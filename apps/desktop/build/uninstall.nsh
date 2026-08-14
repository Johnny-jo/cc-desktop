; Claude Desktop — uninstall / upgrade cleanup
; Included via electron-builder nsis.include.
;
; NSIS upgrades always run the previous uninstaller first. ${isUpdated} is
; not reliably defined in this include, so we NEVER delete AppData here.
; Upgrade and even a manual uninstall leave:
;   %APPDATA%\Claude Desktop   (settings, sessions, CPA config.yaml)
;   %USERPROFILE%\.cli-proxy-api
;   %USERPROFILE%\.claude
; Users who want a clean wipe can delete those folders themselves.

!macro customUnInstall
  ; Stop a running CPA spawned by the app (best effort). Do not delete data.
  nsExec::ExecToLog 'taskkill /F /IM cli-proxy-api.exe'
!macroend
