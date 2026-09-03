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

; electron-builder normally takes shortcut icons from the application EXE.
; Our unsigned/offline build deliberately skips rcedit, so point Windows
; shortcuts at the packaged ICO explicitly after the default links are made.
!macro customInstall
  ${If} ${FileExists} "$INSTDIR\resources\icon.ico"
    ${If} ${FileExists} "$newDesktopLink"
      Delete "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${EndIf}
    ${If} ${FileExists} "$newStartMenuLink"
      Delete "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend

!macro customUnInstall
  ; Stop a running CPA spawned by the app (best effort). Do not delete data.
  nsExec::ExecToLog 'taskkill /F /IM cli-proxy-api.exe'
!macroend
