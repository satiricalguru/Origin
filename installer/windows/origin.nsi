; ============================================================
;  Origin — Windows NSIS Installer Script
;  Produces: dist\Origin-Setup.exe
;
;  REPO_ROOT is injected at compile time by the build workflow:
;    makensis /DREPO_ROOT="C:\path\to\repo" installer\windows\origin.nsi
;
;  For local builds, run from repo root:
;    makensis /DREPO_ROOT="." installer\windows\origin.nsi
; ============================================================

; REPO_ROOT must be set via /D on the command line.
!ifndef REPO_ROOT
  !define REPO_ROOT "."
!endif

!define APP_NAME      "Origin"
!define APP_VERSION   "1.0.0"
!define APP_PUBLISHER "Origin"
!define APP_URL       "https://github.com/satiricalguru/Origin"
!define INSTALL_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

; Output file
OutFile "${REPO_ROOT}\dist\Origin-Setup.exe"

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

!define MUI_WELCOMEPAGE_TITLE  "Welcome to Origin ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT   "Origin is a local AI assistant that runs entirely on your machine — no cloud required.$\r$\n$\r$\nThis installer will copy the Origin files to your computer. Python 3.11+ must be installed separately (see requirements).$\r$\n$\r$\nClick Next to continue."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE  "${REPO_ROOT}\LICENSE"
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
;  Macro: copy a directory if it exists
; ============================================================
!macro CopyDir SRC DEST
  SetOutPath "${DEST}"
  File /r "${SRC}\*"
!macroend

; ============================================================
;  Installer Section
; ============================================================
Section "Origin (required)" SecMain
    SectionIn RO

    ; Root-level files
    SetOutPath "$INSTDIR"
    File "${REPO_ROOT}\app.py"
    File "${REPO_ROOT}\requirements.txt"
    File "${REPO_ROOT}\requirements-optional.txt"
    File "${REPO_ROOT}\setup.py"
    File "${REPO_ROOT}\pyproject.toml"
    File "${REPO_ROOT}\launch-windows.ps1"
    File "${REPO_ROOT}\LICENSE"
    File "${REPO_ROOT}\README.md"

    ; Subdirectories
    SetOutPath "$INSTDIR\routes"
    File /r "${REPO_ROOT}\routes\*"

    SetOutPath "$INSTDIR\services"
    File /r "${REPO_ROOT}\services\*"

    SetOutPath "$INSTDIR\src"
    File /r "${REPO_ROOT}\src\*"

    SetOutPath "$INSTDIR\core"
    File /r "${REPO_ROOT}\core\*"

    SetOutPath "$INSTDIR\config"
    File /r "${REPO_ROOT}\config\*"

    SetOutPath "$INSTDIR\static"
    File /r "${REPO_ROOT}\static\*"

    SetOutPath "$INSTDIR\mcp_servers"
    File /r "${REPO_ROOT}\mcp_servers\*"

    SetOutPath "$INSTDIR\scripts"
    File /r "${REPO_ROOT}\scripts\*"

    ; Runtime dirs
    CreateDirectory "$INSTDIR\logs"
    CreateDirectory "$INSTDIR\data"

    ; Uninstaller
    SetOutPath "$INSTDIR"
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

    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKLM "${INSTALL_REG_KEY}" "EstimatedSize" "$0"

    ; Start Menu shortcuts
    CreateDirectory "$SMPROGRAMS\${APP_NAME}"
    CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" \
        "powershell.exe" \
        "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$INSTDIR\launch-windows.ps1`""
    CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" \
        "$INSTDIR\Uninstall.exe"

    ; Desktop shortcut
    CreateShortcut "$DESKTOP\${APP_NAME}.lnk" \
        "powershell.exe" \
        "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$INSTDIR\launch-windows.ps1`""

SectionEnd

; ============================================================
;  Launch function
; ============================================================
Function LaunchApp
    ExecShell "" "powershell.exe" \
        "-ExecutionPolicy Bypass -File `"$INSTDIR\launch-windows.ps1`""
FunctionEnd

; ============================================================
;  Uninstaller Section
; ============================================================
Section "Uninstall"
    Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
    Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
    RMDir  "$SMPROGRAMS\${APP_NAME}"
    Delete "$DESKTOP\${APP_NAME}.lnk"

    RMDir /r "$INSTDIR\routes"
    RMDir /r "$INSTDIR\services"
    RMDir /r "$INSTDIR\src"
    RMDir /r "$INSTDIR\core"
    RMDir /r "$INSTDIR\config"
    RMDir /r "$INSTDIR\static"
    RMDir /r "$INSTDIR\mcp_servers"
    RMDir /r "$INSTDIR\scripts"
    RMDir /r "$INSTDIR\logs"
    Delete "$INSTDIR\*.py"
    Delete "$INSTDIR\*.toml"
    Delete "$INSTDIR\*.txt"
    Delete "$INSTDIR\*.md"
    Delete "$INSTDIR\*.ps1"
    Delete "$INSTDIR\Uninstall.exe"

    DeleteRegKey HKLM "${INSTALL_REG_KEY}"
    RMDir "$INSTDIR"
SectionEnd
