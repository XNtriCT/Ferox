# Builds the Ferox cached portable executable.
#
# The stock electron-builder "portable" target re-extracts the whole app to a
# temp folder on every launch. This pipeline builds the unpacked app, then
# wraps it with scripts/ferox_portable.nsi which extracts once to
# %LOCALAPPDATA%\Ferox and launches directly afterwards, so Ferox opens
# instantly on every run after the first.
#
# Usage: npm run pack

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..").Path
$version = (Get-Content (Join-Path $root 'package.json') | ConvertFrom-Json).version

Push-Location $root
try {
  Write-Host '[1/3] Building unpacked app...' -ForegroundColor Cyan
  npx electron-builder --win dir
  if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }

  Write-Host '[2/3] Locating makensis...' -ForegroundColor Cyan
  $makensis = Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\nsis" -Recurse -Filter makensis.exe -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
  if (-not $makensis) { throw 'makensis.exe not found in the electron-builder cache' }

  Write-Host '[3/3] Building cached portable launcher...' -ForegroundColor Cyan
  & $makensis "/DAPP_SOURCE=$root\dist\win-unpacked" "/DAPP_VERSION=$version" "/DOUTFILE=$root\dist\Ferox.exe" "$root\scripts\ferox_portable.nsi"
  if ($LASTEXITCODE -ne 0) { throw 'makensis failed' }

  Copy-Item (Join-Path $root 'dist\Ferox.exe') (Join-Path $root 'Ferox.exe') -Force
  Write-Host 'Done: dist\Ferox.exe and Ferox.exe (instant-open cached portable)' -ForegroundColor Green
} finally {
  Pop-Location
}
