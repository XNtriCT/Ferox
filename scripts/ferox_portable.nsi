; Ferox cached portable launcher
;
; The plain electron-builder portable target re-extracts the entire app to a
; temp folder on every launch, which makes startup slow. This launcher extracts
; the app exactly once to %LOCALAPPDATA%\Ferox and then starts it directly on
; every later run, so opening Ferox is instant.
;
; Build:
;   makensis /DAPP_SOURCE=<path to win-unpacked> /DAPP_VERSION=<version> \
;            /DOUTFILE=<output exe> scripts\ferox_portable.nsi

Unicode true
Name "Ferox"
OutFile "${OUTFILE}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
CRCCheck off
WindowIcon off
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!ifndef APP_SOURCE
  !error "APP_SOURCE is not defined"
!endif
!ifndef OUTFILE
  !error "OUTFILE is not defined"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "1.0.0"
!endif

Section
  StrCpy $0 "$LOCALAPPDATA\Ferox"

  ; Already extracted at this version? Launch immediately (instant startup).
  IfFileExists "$0\Ferox.exe" 0 extract
  IfFileExists "$0\.ferox-${APP_VERSION}" launch extract

extract:
  ; First run (or new version): extract once, then mark the cache.
  RMDir /r "$0"
  CreateDirectory "$0"
  SetOutPath "$0"
  File /r "${APP_SOURCE}\*.*"
  FileOpen $1 "$0\.ferox-${APP_VERSION}" w
  FileClose $1

launch:
  Exec '"$0\Ferox.exe"'
SectionEnd
