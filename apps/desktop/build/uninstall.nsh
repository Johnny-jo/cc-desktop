; Claude Desktop — uninstall cleanup
; Included via electron-builder nsis.include.
; Stops the managed CPA process and removes the app's user data
; (settings, sessions, snapshots, CPA config). Shared user content
; (~/.cli-proxy-api) is preserved on purpose.

!macro customUnInstall
  ; Stop a running CPA spawned by the app (best effort).
  nsExec::ExecToLog 'taskkill /F /IM cli-proxy-api.exe'

  ; App userData root (productName "Claude Desktop" under %APPDATA%).
  RMDir /r "$APPDATA\Claude Desktop"

  ; Fallback paths from earlier packaging attempts.
  RMDir /r "$APPDATA\claude-desktop"
  RMDir /r "$APPDATA\@claude-desktop\desktop"

  ; NOTE: we deliberately do NOT touch:
  ;   - %USERPROFILE%\.cli-proxy-api  (shared CPA credentials, may predate us)
  ;   - the user's project directories
!macroend
