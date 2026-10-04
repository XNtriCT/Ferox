# Ferox Browser - Native C++ Ninja Compilation Script
# Compiles Brave from source with YouTube 3x/4x support

param (
    [string]$SourceDir = "C:\src\ferox",
    [string]$Config = "Release"
)

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  FEROX - Native C++ Binary Compiler    " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

if (-not (Test-Path $SourceDir)) {
    Write-Error "Source directory $SourceDir does not exist. Please run fork_and_setup.ps1 first."
    exit 1
}

Set-Location $SourceDir

Write-Host "[1/3] Generating GN build configuration for $Config..." -ForegroundColor Yellow
npm run create_dist -- --target_os=win --target_arch=x64

Write-Host "[2/3] Compiling Ferox browser with ninja..." -ForegroundColor Yellow
npm run build -- $Config

Write-Host "[3/3] Packaging installer..." -ForegroundColor Yellow
npm run create_dist

Write-Host "`nBuild complete! The native executable is located at: $SourceDir\src\out\$Config\brave.exe" -ForegroundColor Green
