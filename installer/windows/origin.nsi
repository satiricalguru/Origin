; ============================================================
;  Origin — Windows NSIS Installer Script
;  Produces: dist/Origin-Setup.exe
;
;  Build with:
;    makensis installer\windows\origin.nsi
;  (from the repo root, after installing NSIS on Windows)
; ============================================================

!define APP_NAME     "Origin"
!define APP_VERSION  "1.0.0"
!define APP_PUBLISHER "Origin"
!define APP_URL      "https://github.com/satiricalguru/Origin"
!define INSTALL_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

; Output file
OutFile "..\..\dist\Origin-Setup.exe"

; Compression
SetCompressor /SOLID lzma

; Modern UI
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

; --- Installer metadata ---
Name "${APP_NAME} ${APP_VERSION}"
BrandingText "${APP_NAME} ${APP_VERSION} — Access without barriers."
RequestExecutionLevel admin

; --- Default install dir ---
InstallDir "$PROGRAMFILES64\${APP_NAME}"
InstallDirRegKey HKLM "${INSTALL_REG_KEY}" "InstallLocation"

; --- MUI Pages ---
!define MUI_ABORTWARNING
!define MUI_ICON   "origin.ico"
!define MUI_UNICON "origin.ico"

!define MUI_WELCOMEPAGE_TITLE  "Welcome to Origin ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT   "Origin is a local AI assistant that runs entirely on your machine — no cloud required.$\r$\n$\r$\nThis installer will copy the Origin files to your computer. Python 3.11+ must be installed separately (see requirements).$\r$\n$\r$\nClick Next to continue."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE  "..\..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Launch Origin now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!insertmacro MUI_PAGE_FINISH

; --- Uninstaller pages ---
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; --- Language ---
!insertmacro MUI_LANGUAGE "English"

; ============================================================
;  Installer Section
; ============================================================
Section "Origin (required)" SecMain
    SectionIn RO   ; Cannot be deselected

    SetOutPath "$INSTDIR"

    ; Copy everything except venv/, data/, .git/, __pycache__/, dist/, logs/
    ; GitHub Actions will zip the clean repo so we can just use:
    File /r /x "venv" /x "data" /x ".git" /x "__pycache__" /x "dist" /x "logs" /x ".pytest_cache" "..\..\*"

    ; Create logs and data dirs so the app can write to them
    CreateDirectory "$INSTDIR\logs"
    CreateDirectory "$INSTDIR\data"

    ; Write uninstaller
    WriteUninstaller "$INSTDIR\Uninstall.exe"

    ; Registry: Add/Remove Programs
    WriteRegStr   HKLM "${INSTALL_REG_KEY}" "DisplayName"      "${APP_NAME}"
    WriteRegStr   HKLM "${INSTALL_REG_KEY}" "DisplayVersion"   "${APP_VERSION}"
    WriteRegStr   HKLM "${INSTALL_REG_KEY}" "Publisher"        "${APP_PUBLISHER}"
    WriteRegStr   HKLM "${INSTALL_REG_KEY}" "URLInfoAbout"     "${APP_URL}"
    WriteRegStr   HKLM "${INSTALL_REG_KEY}" "InstallLocation"  "$INSTDIR"
    WriteRegStr   HKLM "${INSTALL_REG_KEY}" "UninstallString"  "$INSTDIR\Uninstall.exe"
    WriteRegDWORD HKLM "${INSTALL_REG_KEY}" "NoModify"         1
    WriteRegDWORD HKLM "${INSTALL_REG_KEY}" "NoRepair"         1

    ; Estimate install size
    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKLM "${INSTALL_REG_KEY}" "EstimatedSize" "$0"

    ; Start Menu shortcut
    CreateDirectory "$SMPROGRAMS\${APP_NAME}"
    CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" \
        "powershell.exe" \
        "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$INSTDIR\launch-windows.ps1`"" \
        "$INSTDIR\installer\windows\origin.ico" 0

    CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" \
        "$INSTDIR\Uninstall.exe"

    ; Desktop shortcut
    CreateShortcut "$DESKTOP\${APP_NAME}.lnk" \
        "powershell.exe" \
        "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$INSTDIR\launch-windows.ps1`"" \
        "$INSTDIR\installer\windows\origin.ico" 0

SectionEnd

; ============================================================
;  Launch function (called from Finish page)
; ============================================================
Function LaunchApp
    ExecShell "open" "powershell.exe" \
        "-ExecutionPolicy Bypass -File `"$INSTDIR\launch-windows.ps1`""
FunctionEnd

; ============================================================
;  Uninstaller Section
; ============================================================
Section "Uninstall"
    ; Remove shortcuts
    Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
    Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
    RMDir  "$SMPROGRAMS\${APP_NAME}"
    Delete "$DESKTOP\${APP_NAME}.lnk"

    ; Remove installed files (but preserve user data/)
    RMDir /r "$INSTDIR\app.py"
    RMDir /r "$INSTDIR\routes"
    RMDir /r "$INSTDIR\services"
    RMDir /r "$INSTDIR\src"
    RMDir /r "$INSTDIR\core"
    RMDir /r "$INSTDIR\config"
    RMDir /r "$INSTDIR\static"
    RMDir /r "$INSTDIR\mcp_servers"
    RMDir /r "$INSTDIR\scripts"
    RMDir /r "$INSTDIR\installer"
    RMDir /r "$INSTDIR\venv"
    RMDir /r "$INSTDIR\logs"
    RMDir /r "$INSTDIR\.github"
    Delete "$INSTDIR\*.py"
    Delete "$INSTDIR\*.toml"
    Delete "$INSTDIR\*.txt"
    Delete "$INSTDIR\*.md"
    Delete "$INSTDIR\*.sh"
    Delete "$INSTDIR\*.ps1"
    Delete "$INSTDIR\*.yml"
    Delete "$INSTDIR\*.json"
    Delete "$INSTDIR\Uninstall.exe"

    ; Remove registry keys
    DeleteRegKey HKLM "${INSTALL_REG_KEY}"

    ; Remove install dir if empty
    RMDir "$INSTDIR"

SectionEnd
