#Requires -Version 5.1
<#
  Origin — Windows installer builder.

  Compiles installer\windows\origin.nsi into dist\Origin-Setup.exe using NSIS.
  Run this on a Windows machine (or in a GitHub Actions windows-latest runner).

  Prerequisites:
    - NSIS installed: https://nsis.sourceforge.io/Download
      (makensis.exe must be on PATH, or install via: winget install NSIS.NSIS)

  Usage:
    powershell -ExecutionPolicy Bypass -File .\build-windows-installer.ps1
#>

param(
    [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Write-Step($msg) { Write-Host ""; Write-Host ("==> " + $msg) -ForegroundColor Cyan }
function Fail($msg) {
    Write-Host ""
    Write-Host ("ERROR: " + $msg) -ForegroundColor Red
    exit 1
}

# ── 1. Check NSIS ──────────────────────────────────────────────────────────────
Write-Step "Checking for NSIS (makensis)"
$makensis = $null
foreach ($p in @(
    "makensis",
    "C:\Program Files (x86)\NSIS\makensis.exe",
    "C:\Program Files\NSIS\makensis.exe"
)) {
    $cmd = Get-Command $p -ErrorAction SilentlyContinue
    if ($cmd) { $makensis = $cmd.Source; break }
}
if (-not $makensis) {
    Fail "makensis not found. Install NSIS: winget install NSIS.NSIS`n  or download from https://nsis.sourceforge.io/Download"
}
Write-Host "Using: $makensis"

# ── 2. Ensure dist/ exists ─────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path "$PSScriptRoot\dist" | Out-Null

# ── 3. Compile installer ────────────────────────────────────────────────────────
Write-Step "Building dist\Origin-Setup.exe  (version $Version)"
& $makensis `
    /DAPP_VERSION=$Version `
    "$PSScriptRoot\installer\windows\origin.nsi"

if ($LASTEXITCODE -ne 0) { Fail "makensis failed. See output above." }

Write-Host ""
Write-Host "Done:" -ForegroundColor Green
Write-Host "  $PSScriptRoot\dist\Origin-Setup.exe"
