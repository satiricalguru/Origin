#!/bin/bash
# Build a downloadable macOS launcher app + .dmg for Origin.
#
#   ./build-macos-app.sh
#
# Produces:
#   dist/Origin.app   — double-click: starts the local server (using this
#                         repo's venv) and opens the UI in an app-style window.
#   dist/Origin.dmg   — drag-to-Applications disk image (the downloadable).
#
# This is a *launcher* wrapper: it drives the venv we set up in this repo, it
# does not bundle Python. The install path is baked into the app at build time,
# so rebuild if you move the repo. Override the port with ORIGIN_PORT.
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Origin"
INSTALL_DIR="$REPO_DIR"
PORT="${ORIGIN_PORT:-7860}"
DIST="$REPO_DIR/dist"
APP="$DIST/$APP_NAME.app"

echo "Building $APP_NAME.app"
echo "  install dir: $INSTALL_DIR"
echo "  port:        $PORT"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ── Icon (best effort) — center-crop to a square .icns ──
ICON_SRC=""
for f in "$REPO_DIR/docs/origin.png" "$REPO_DIR/docs/origin.jpg"; do
  [ -f "$f" ] && ICON_SRC="$f" && break
done
if [ -n "$ICON_SRC" ] && command -v sips >/dev/null 2>&1; then
  TMPIMG="$(mktemp -d)"
  sips -c 720 720 "$ICON_SRC" --out "$TMPIMG/sq.png" >/dev/null 2>&1 || cp "$ICON_SRC" "$TMPIMG/sq.png"
  sips -z 512 512 "$TMPIMG/sq.png" --out "$TMPIMG/icon.png" >/dev/null 2>&1
  if sips -s format icns "$TMPIMG/icon.png" --out "$APP/Contents/Resources/origin.icns" >/dev/null 2>&1; then
    echo "  icon:        origin.icns"
  else
    echo "  icon:        (skipped — conversion failed)"
  fi
  rm -rf "$TMPIMG"
else
  echo "  icon:        (skipped — no docs/origin.png)"
fi

# ── Info.plist ──
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>            <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>     <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>      <string>com.origin.launcher</string>
    <key>CFBundleVersion</key>         <string>1.0.0</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>CFBundlePackageType</key>     <string>APPL</string>
    <key>CFBundleExecutable</key>      <string>$APP_NAME</string>
    <key>CFBundleIconFile</key>        <string>origin</string>
    <key>LSMinimumSystemVersion</key>  <string>11.0</string>
    <key>NSHighResolutionCapable</key> <true/>
    <key>LSUIElement</key>             <false/>
</dict>
</plist>
PLIST

# ── Launcher executable (placeholders filled below) ──
cat > "$APP/Contents/MacOS/$APP_NAME.tmpl" <<'LAUNCHER'
#!/bin/bash
# Origin.app — start the local server and open the UI in an app window.
PORT="__PORT__"
URL="http://127.0.0.1:${PORT}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Detect install dir: look for venv relative to this script's location.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEARCH_DIRS=(
  "$SCRIPT_DIR/../../../.."                    # inside .app in repo
  "$HOME/Origin"                               # ~/Origin
  "$HOME/Documents/Origin"                     # ~/Documents/Origin
  "$HOME/Desktop/Origin"                       # ~/Desktop/Origin
  "/opt/Origin"                                # /opt/Origin
  "/usr/local/Origin"                          # /usr/local/Origin
)
INSTALL_DIR=""
for d in "${SEARCH_DIRS[@]}"; do
  if [ -x "$d/venv/bin/uvicorn" ]; then
    INSTALL_DIR="$d"
    break
  fi
done
if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="$SCRIPT_DIR/../../../.."
fi

UVICORN="$INSTALL_DIR/venv/bin/uvicorn"
LOG="$INSTALL_DIR/logs/origin-app.log"

notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Origin\"" >/dev/null 2>&1; }
die_gui() {
  /usr/bin/osascript -e "display dialog \"$1\" with title \"Origin\" buttons {\"OK\"} default button 1 with icon stop" >/dev/null 2>&1
  exit 1
}

[ -x "$UVICORN" ] || die_gui "Origin isn't set up yet. Open Terminal and run:

cd $INSTALL_DIR
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
./venv/bin/python setup.py"

# Open the UI in a chrome-less app window (Chromium browsers), else default browser.
open_ui() {
  local b base exe bin
  for b in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
    for base in "/Applications" "$HOME/Applications"; do
      if [ -d "$base/$b.app" ]; then
        exe="$(/usr/bin/defaults read "$base/$b.app/Contents/Info" CFBundleExecutable 2>/dev/null)"
        bin="$base/$b.app/Contents/MacOS/$exe"
        if [ -x "$bin" ]; then
          "$bin" --app="$URL" --new-window >/dev/null 2>&1 &
          disown
          return 0
        fi
      fi
    done
  done
  /usr/bin/open "$URL"
}

mkdir -p "$INSTALL_DIR/logs"

# Already running? Just open the UI and exit immediately.
if /usr/bin/curl -s -o /dev/null --max-time 2 "$URL"; then
  open_ui
  exit 0
fi

notify "Starting…"
cd "$INSTALL_DIR" || die_gui "Install folder not found: $INSTALL_DIR"
"$UVICORN" app:app --host 127.0.0.1 --port "$PORT" >>"$LOG" 2>&1 &
SERVER_PID=$!

# Quitting the app stops the server it started.
trap 'kill $SERVER_PID 2>/dev/null; exit 0' TERM INT

# Wait for readiness (first run downloads an embedding model — allow ~2 min).
READY=0
for i in $(seq 1 120); do
  /usr/bin/curl -s -o /dev/null --max-time 2 "$URL" && { READY=1; break; }
  kill -0 "$SERVER_PID" 2>/dev/null || die_gui "Origin failed to start. Log:
$LOG"
  sleep 1
done

if [ "$READY" = "1" ]; then
  open_ui
else
  notify "Origin is taking a while — open $URL once it finishes starting."
fi

# Detach from terminal so the app doesn't block in the dock.
# The server runs in background; re-opened instances just detect it and exit.
wait "$SERVER_PID" 2>/dev/null &
disown
exit 0
LAUNCHER

sed -e "s|__PORT__|$PORT|g" \
    "$APP/Contents/MacOS/$APP_NAME.tmpl" > "$APP/Contents/MacOS/$APP_NAME"
rm -f "$APP/Contents/MacOS/$APP_NAME.tmpl"
chmod +x "$APP/Contents/MacOS/$APP_NAME"

# Refresh Finder's icon cache for the new bundle.
touch "$APP"

# ── .dmg (drag-to-Applications) ──
echo "Packaging dist/$APP_NAME.dmg"
STAGE="$(mktemp -d)/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DIST/$APP_NAME.dmg"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DIST/$APP_NAME.dmg" >/dev/null
rm -rf "$STAGE"

echo ""
echo "Done:"
echo "  $APP"
echo "  $DIST/$APP_NAME.dmg"
echo ""
echo "Run it:        open '$APP'"
echo "Install:       open '$DIST/$APP_NAME.dmg'  (drag Origin to Applications)"
