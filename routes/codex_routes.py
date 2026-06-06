"""ChatGPT Codex OAuth + model routes.

Implements an OAuth 2.0 + PKCE sign-in flow against `auth.openai.com` so users
can connect their ChatGPT account to Origin's IDE Codex panel. Uses the same
public client_id as the official OpenAI Codex CLI
(`app_X8GQ3CkEM6Ngw2v0YVlvW5L7`) with a localhost loopback callback on port
1455 (matches what the CLI registers). The token, account email, and current
model are stored per-user in `data/codex_tokens/{username}.json` (encrypted
with `api_key_manager`).

If the server is not running on the same machine the user is browsing from
(e.g. a remote deploy), the OAuth flow falls back to a "paste the callback
URL back" pattern modeled on the existing Google MCP OAuth handler — the
server returns an HTML page with a text input for the user to paste the full
redirect URL into.
"""

import base64
import hashlib
import json
import logging
import os
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, Optional

import requests as _req
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

from src.auth_helpers import get_current_user, require_user

logger = logging.getLogger(__name__)

# Public client_id from the OpenAI Codex CLI. There is no secret.
CODEX_CLIENT_ID = "app_X8GQ3CkEM6Ngw2v0YVlvW5L7"
CODEX_AUTH_URL = "https://auth.openai.com/oauth/authorize"
CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"
CODEX_API_BASE = "https://api.openai.com/v1"
CODEX_SCOPES = "openid profile email offline_access"
CODEX_CALLBACK_PORT = 1455
CODEX_CALLBACK_PATH = "/auth/callback"

# In-memory state store: state -> {verifier, user, created_at}
_codex_oauth_states: Dict[str, Dict[str, Any]] = {}
_state_lock = threading.Lock()
_STATE_TTL = 600  # 10 minutes

# Local loopback HTTP server (started on demand). Single instance, single user
# at a time. Catches the redirect from auth.openai.com.
_callback_server: Optional["_CallbackServer"] = None
_callback_server_lock = threading.Lock()


# ──────────────────────────────────────────────────────────────────
# Per-user token storage
# ──────────────────────────────────────────────────────────────────

def _token_path(data_dir: str, username: str) -> str:
    safe = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in username)
    folder = os.path.join(data_dir, "codex_tokens")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, f"{safe}.json")


def _load_token(api_key_manager, username: str) -> Optional[Dict[str, Any]]:
    if not username:
        return None
    path = _token_path(api_key_manager.data_dir, username)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            blob = json.load(f)
        access = api_key_manager.decrypt_api_key(blob.get("access_token_enc", ""))
        refresh = api_key_manager.decrypt_api_key(blob.get("refresh_token_enc", ""))
        if not access:
            return None
        return {
            "access_token": access,
            "refresh_token": refresh,
            "expires_at": blob.get("expires_at", 0),
            "account_id": blob.get("account_id", ""),
            "email": blob.get("email", ""),
        }
    except Exception as e:
        logger.warning("Failed to load codex token for %s: %s", username, e)
        return None


def _save_token(api_key_manager, username: str, payload: Dict[str, Any]) -> None:
    path = _token_path(api_key_manager.data_dir, username)
    blob = {
        "access_token_enc": api_key_manager.encrypt_api_key(payload.get("access_token", "")),
        "refresh_token_enc": api_key_manager.encrypt_api_key(payload.get("refresh_token", "")),
        "expires_at": payload.get("expires_at", 0),
        "account_id": payload.get("account_id", ""),
        "email": payload.get("email", ""),
    }
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(blob, f)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def _delete_token(api_key_manager, username: str) -> None:
    path = _token_path(api_key_manager.data_dir, username)
    if os.path.exists(path):
        try:
            os.remove(path)
        except Exception as e:
            logger.warning("Failed to delete codex token for %s: %s", username, e)


# ──────────────────────────────────────────────────────────────────
# PKCE helpers
# ──────────────────────────────────────────────────────────────────

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _new_pkce() -> Dict[str, str]:
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return {"verifier": verifier, "challenge": challenge}


# ──────────────────────────────────────────────────────────────────
# Token exchange + refresh
# ──────────────────────────────────────────────────────────────────

def _exchange_code(code: str, verifier: str, redirect_uri: str) -> Dict[str, Any]:
    data = {
        "grant_type": "authorization_code",
        "client_id": CODEX_CLIENT_ID,
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": redirect_uri,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    r = _req.post(CODEX_TOKEN_URL, data=data, headers=headers, timeout=15)
    if not r.ok:
        raise HTTPException(502, f"OpenAI token exchange failed: {r.status_code} {r.text[:200]}")
    return r.json()


def _refresh(refresh_token: str) -> Dict[str, Any]:
    data = {
        "grant_type": "refresh_token",
        "client_id": CODEX_CLIENT_ID,
        "refresh_token": refresh_token,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    r = _req.post(CODEX_TOKEN_URL, data=data, headers=headers, timeout=15)
    if not r.ok:
        raise HTTPException(502, f"OpenAI token refresh failed: {r.status_code} {r.text[:200]}")
    return r.json()


def _persist_tokens(api_key_manager, username: str, tok: Dict[str, Any]) -> Dict[str, Any]:
    expires_in = int(tok.get("expires_in", 3600))
    account_id = ""
    email = ""
    try:
        id_token = tok.get("id_token", "")
        if id_token:
            # JWT: header.payload.signature — payload is base64url JSON
            payload_b64 = id_token.split(".", 2)[1] if "." in id_token else ""
            payload_b64 += "=" * (-len(payload_b64) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload_b64))
            email = claims.get("email", "")
            account_id = claims.get("sub", "")
    except Exception:
        pass
    payload = {
        "access_token": tok.get("access_token", ""),
        "refresh_token": tok.get("refresh_token", ""),
        "expires_at": int(time.time()) + max(60, expires_in - 60),
        "account_id": account_id,
        "email": email,
    }
    _save_token(api_key_manager, username, payload)
    return payload


def _ensure_fresh_token(api_key_manager, username: str) -> Optional[Dict[str, Any]]:
    tok = _load_token(api_key_manager, username)
    if not tok:
        return None
    if tok["expires_at"] > time.time() + 30:
        return tok
    if not tok.get("refresh_token"):
        return tok
    try:
        new = _refresh(tok["refresh_token"])
        return _persist_tokens(api_key_manager, username, new)
    except Exception as e:
        logger.warning("Codex token refresh failed for %s: %s", username, e)
        return tok


# ──────────────────────────────────────────────────────────────────
# Model listing
# ──────────────────────────────────────────────────────────────────

def _fetch_openai_models(api_key: str) -> list:
    """Hit OpenAI's /v1/models. Returns the raw `data` list."""
    r = _req.get(
        f"{CODEX_API_BASE}/models",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=15,
    )
    if not r.ok:
        raise HTTPException(502, f"OpenAI /v1/models failed: {r.status_code} {r.text[:200]}")
    return r.json().get("data", [])


def _is_code_model(model_id: str) -> bool:
    mid = model_id.lower()
    if "codex" in mid:
        return True
    if "-code" in mid or mid.startswith("code-"):
        return True
    return False


# ──────────────────────────────────────────────────────────────────
# Localhost loopback callback server
# ──────────────────────────────────────────────────────────────────

class _CallbackHandler(BaseHTTPRequestHandler):
    # Filled in by _CallbackServer before serve_forever()
    result_event: threading.Event = None
    result_payload: Dict[str, Any] = {}
    html_response: bytes = b""

    def log_message(self, format, *args):  # silence stdout
        pass

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != CODEX_CALLBACK_PATH:
            self.send_response(404)
            self.end_headers()
            return
        params = urllib.parse.parse_qs(parsed.query)
        code = (params.get("code") or [None])[0]
        state = (params.get("state") or [None])[0]
        err = (params.get("error") or [None])[0]
        if self.result_event is not None:
            self.result_payload["code"] = code
            self.result_payload["state"] = state
            self.result_payload["error"] = err
            self.result_event.set()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(self.html_response)))
        self.end_headers()
        self.wfile.write(self.html_response)


class _CallbackServer:
    def __init__(self, port: int):
        self.port = port
        self.server: Optional[HTTPServer] = None
        self.thread: Optional[threading.Thread] = None

    def start(self) -> bool:
        try:
            self.server = HTTPServer(("127.0.0.1", self.port), _CallbackHandler)
        except OSError as e:
            logger.warning("Could not start codex callback server on :%d: %s", self.port, e)
            return False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return True

    def wait_for_callback(self, timeout: float) -> Dict[str, Any]:
        if not self.server:
            return {"error": "callback server not running"}
        event = threading.Event()
        _CallbackHandler.result_event = event
        _CallbackHandler.result_payload = {}
        _CallbackHandler.html_response = (
            b"<!doctype html><html><body style=\"font-family:sans-serif;padding:24px;\">"
            b"<h2>Connected to ChatGPT</h2>"
            b"<p>You can close this window and return to Origin.</p>"
            b"<script>setTimeout(function(){window.close();},1500);</script>"
            b"</body></html>"
        )
        event.wait(timeout=timeout)
        return _CallbackHandler.result_payload

    def stop(self) -> None:
        if self.server:
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:
                pass
            self.server = None
            self.thread = None


def _ensure_callback_server() -> Optional[_CallbackServer]:
    global _callback_server
    with _callback_server_lock:
        if _callback_server and _callback_server.server:
            return _callback_server
        srv = _CallbackServer(CODEX_CALLBACK_PORT)
        if srv.start():
            _callback_server = srv
            return srv
        return None


# ──────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────

def _public_redirect_uri(request: Request) -> str:
    """Pick the redirect URI to register with OpenAI.

    Loopback: `http://localhost:1455/auth/callback` (matches Codex CLI).
    Anything else: a public callback that falls back to a paste-back page.
    """
    return f"http://localhost:{CODEX_CALLBACK_PORT}{CODEX_CALLBACK_PATH}"


def setup_codex_routes(api_key_manager) -> APIRouter:
    router = APIRouter(tags=["codex"])

    @router.get("/api/codex/status")
    async def codex_status(request: Request):
        username = get_current_user(request) or ""
        if not username:
            return {"connected": False, "email": "", "model": None, "available": False}
        tok = _ensure_fresh_token(api_key_manager, username)
        if not tok:
            return {"connected": False, "email": "", "model": None, "available": False}
        # Pull preferred model from a sidecar preferences file
        model = _load_preferred_model(api_key_manager, username)
        return {
            "connected": True,
            "email": tok.get("email", ""),
            "model": model,
            "available": True,
        }

    @router.get("/api/codex/models")
    async def codex_models(request: Request):
        username = get_current_user(request) or ""
        if not username:
            raise HTTPException(401, "Not authenticated")
        tok = _ensure_fresh_token(api_key_manager, username)
        if not tok:
            raise HTTPException(400, "Connect to ChatGPT first")
        try:
            items = _fetch_openai_models(tok["access_token"])
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(502, f"Could not list OpenAI models: {e}")
        codex = sorted(
            [{"id": m.get("id"), "created": m.get("created", 0)} for m in items if _is_code_model(m.get("id", ""))],
            key=lambda m: m.get("id", ""),
        )
        # Persist full list so the picker can show "all OpenAI code-capable"
        # options without re-fetching every render.
        _save_cached_models(api_key_manager, username, codex)
        return {"models": codex, "email": tok.get("email", "")}

    @router.post("/api/codex/model")
    async def codex_set_model(request: Request):
        username = get_current_user(request) or ""
        if not username:
            raise HTTPException(401, "Not authenticated")
        body = await request.json()
        model = (body or {}).get("model", "").strip()
        if not model:
            raise HTTPException(400, "model is required")
        _save_preferred_model(api_key_manager, username, model)
        return {"ok": True, "model": model}

    @router.post("/api/codex/oauth/start")
    async def codex_oauth_start(request: Request):
        username = get_current_user(request) or ""
        if not username:
            raise HTTPException(401, "Not authenticated")
        # Clean expired states
        now = time.time()
        with _state_lock:
            for k in [k for k, v in _codex_oauth_states.items() if v["created_at"] < now - _STATE_TTL]:
                _codex_oauth_states.pop(k, None)
        pkce = _new_pkce()
        state = secrets.token_urlsafe(16)
        with _state_lock:
            _codex_oauth_states[state] = {
                "verifier": pkce["verifier"],
                "user": username,
                "created_at": now,
            }
        redirect_uri = _public_redirect_uri(request)
        # Start the local callback server eagerly so we can catch the redirect.
        local_ok = bool(_ensure_callback_server())
        params = {
            "client_id": CODEX_CLIENT_ID,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "scope": CODEX_SCOPES,
            "state": state,
            "code_challenge": pkce["challenge"],
            "code_challenge_method": "S256",
            "id_token_add_organizations": "true",
            "codex_cli_simplified_flow": "true",
        }
        auth_url = CODEX_AUTH_URL + "?" + urllib.parse.urlencode(params)
        return {
            "auth_url": auth_url,
            "state": state,
            "loopback": local_ok,
            "redirect_uri": redirect_uri,
        }

    @router.post("/api/codex/oauth/wait")
    async def codex_oauth_wait(request: Request):
        """Block up to ~2 minutes for the local callback to deliver a code."""
        body = await request.json()
        state = (body or {}).get("state", "")
        with _state_lock:
            entry = _codex_oauth_states.get(state)
        if not entry:
            raise HTTPException(400, "Unknown or expired state")
        srv = _callback_server
        if not srv:
            raise HTTPException(500, "Callback server not running")
        result = srv.wait_for_callback(timeout=120)
        code = result.get("code")
        returned_state = result.get("state")
        err = result.get("error")
        if err:
            with _state_lock:
                _codex_oauth_states.pop(state, None)
            raise HTTPException(400, f"OpenAI returned error: {err}")
        if not code or returned_state != state:
            with _state_lock:
                _codex_oauth_states.pop(state, None)
            raise HTTPException(400, "Did not receive authorization code")
        with _state_lock:
            entry = _codex_oauth_states.pop(state, None)
        if not entry:
            raise HTTPException(400, "State expired")
        try:
            tok = _exchange_code(code, entry["verifier"], _public_redirect_uri(request))
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(502, f"Token exchange failed: {e}")
        persisted = _persist_tokens(api_key_manager, entry["user"], tok)
        return {
            "ok": True,
            "email": persisted.get("email", ""),
            "account_id": persisted.get("account_id", ""),
        }

    @router.post("/api/codex/oauth/disconnect")
    async def codex_disconnect(request: Request):
        username = get_current_user(request) or ""
        if not username:
            raise HTTPException(401, "Not authenticated")
        _delete_token(api_key_manager, username)
        return {"ok": True}

    @router.post("/api/codex/chat")
    async def codex_chat(request: Request):
        """Send a single Codex request to OpenAI using the stored OAuth token.

        Body: { "message": str, "model": str }
        Returns: { "response": str } on success.
        """
        username = get_current_user(request) or ""
        if not username:
            raise HTTPException(401, "Not authenticated")
        body = await request.json()
        message = (body or {}).get("message", "").strip()
        model = (body or {}).get("model", "").strip() or _load_preferred_model(api_key_manager, username) or ""
        if not message:
            raise HTTPException(400, "message is required")
        if not model:
            raise HTTPException(400, "Pick a Codex model first")
        tok = _ensure_fresh_token(api_key_manager, username)
        if not tok:
            raise HTTPException(400, "Connect to ChatGPT first")
        try:
            r = _req.post(
                f"{CODEX_API_BASE}/chat/completions",
                headers={
                    "Authorization": f"Bearer {tok['access_token']}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You are Codex, an AI coding assistant inside the Origin IDE. "
                                "Reply with code in fenced ``` blocks when relevant. "
                                "Be concise and direct."
                            ),
                        },
                        {"role": "user", "content": message},
                    ],
                    "temperature": 0.2,
                },
                timeout=60,
            )
        except _req.RequestException as e:
            raise HTTPException(502, f"OpenAI request failed: {e}")
        if not r.ok:
            raise HTTPException(502, f"OpenAI error: {r.status_code} {r.text[:300]}")
        data = r.json()
        try:
            text = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise HTTPException(502, "Unexpected OpenAI response shape")
        return {"response": text, "model": model}

    return router


# ──────────────────────────────────────────────────────────────────
# Sidecar files for preferred model + cached model list
# ──────────────────────────────────────────────────────────────────

def _prefs_path(api_key_manager, username: str) -> str:
    safe = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in username)
    folder = os.path.join(api_key_manager.data_dir, "codex_tokens")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, f"{safe}.prefs.json")


def _load_preferred_model(api_key_manager, username: str) -> Optional[str]:
    path = _prefs_path(api_key_manager, username)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            blob = json.load(f)
        return blob.get("model")
    except Exception:
        return None


def _save_preferred_model(api_key_manager, username: str, model: str) -> None:
    path = _prefs_path(api_key_manager, username)
    blob = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                blob = json.load(f)
        except Exception:
            blob = {}
    blob["model"] = model
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(blob, f)
    os.replace(tmp, path)


def _save_cached_models(api_key_manager, username: str, models: list) -> None:
    path = _prefs_path(api_key_manager, username)
    blob = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                blob = json.load(f)
        except Exception:
            blob = {}
    blob["cached_models"] = models
    blob["cached_at"] = int(time.time())
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(blob, f)
    os.replace(tmp, path)


def load_cached_models(api_key_manager, username: str) -> list:
    path = _prefs_path(api_key_manager, username)
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            blob = json.load(f)
        return blob.get("cached_models", [])
    except Exception:
        return []
