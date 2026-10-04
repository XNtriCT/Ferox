# Ferox Browser - Setup & Fork Script
# Clones brave-browser, pulls brave-core, and applies the YouTube 3x/4x speed patch

param (
    [string]$TargetDir = "C:\src\ferox"
)

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  FEROX - Brave Browser Fork Setup      " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Check prerequisites
Write-Host "[1/5] Checking environment tools..." -ForegroundColor Yellow
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is required. Please install Git for Windows."
    exit 1
}

# 2. Setup depot_tools
$DepotToolsDir = "C:\src\depot_tools"
if (-not (Test-Path $DepotToolsDir)) {
    Write-Host "[2/5] Cloning Chromium depot_tools..." -ForegroundColor Yellow
    git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git $DepotToolsDir
    $env:PATH = "$DepotToolsDir;$env:PATH"
} else {
    Write-Host "[2/5] depot_tools already installed." -ForegroundColor Green
}

# 3. Clone brave-browser
Write-Host "[3/5] Cloning brave-browser repository..." -ForegroundColor Yellow
if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    git clone https://github.com/brave/brave-browser.git $TargetDir
}

Set-Location $TargetDir

# 4. Initialize npm dependencies and sync submodules
Write-Host "[4/5] Running npm install & submodule sync..." -ForegroundColor Yellow
npm install
npm run init

# 5. Apply Ferox YouTube 3x/4x patch to brave-core
Write-Host "[5/5] Applying YouTube 3x & 4x speed patch to src/brave..." -ForegroundColor Yellow
$PatchFile = Join-Path $PSScriptRoot "..\patches\brave_core_youtube_speeds.patch"
if (Test-Path "$TargetDir\src\brave") {
    Set-Location "$TargetDir\src\brave"
    git apply $PatchFile
    Write-Host "Patch applied successfully!" -ForegroundColor Green
} else {
    Write-Host "brave-core will be patched once 'npm run init' completes full sync." -ForegroundColor Yellow
}

Write-Host "`nSetup complete! Run '.\scripts\build_brave.ps1' to compile native binary." -ForegroundColor Cyan
