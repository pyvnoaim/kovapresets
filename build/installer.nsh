; Ask, on a real uninstall, whether to also wipe the user's data. That data is
; %APPDATA%\kovapreset (the RUNTIME app name, not productName): presets,
; hotkeys, settings, and the baseline backup of the pre-KovaPresets game files.
;
; Why this is asked from un.onInit and not from the uninstall section: a
; one-click uninstaller force-sets silent mode before that section runs (see
; uninstaller.nsh), and NSIS suppresses MessageBox in silent mode - so the
; question would never be displayed. un.onInit is also the only place SetSilent
; is legal, so un-silence just long enough to ask, then restore it and let the
; uninstall itself stay one-click.
;
; A genuine /S means nobody is there to answer, so the data is kept. An update
; reinstall passes /S too (installUtil.nsh runs the old uninstaller with
; "/S /KEEP_APP_DATA --updated"), which is exactly the behaviour we want there.

; The uninstaller is a separate compilation pass; in the installer pass the two
; macros below are never inserted, and an unused Var is a warning that
; electron-builder promotes to a build error.
!ifdef BUILD_UNINSTALLER
  Var DeleteUserData
!endif

!macro customUnInit
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/S" $R1
  ${If} ${Errors}
    SetSilent normal
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also delete your presets, hotkeys and settings?$\r$\n$\r$\nChoose No to keep them for a future reinstall." \
      /SD IDNO IDNO keepData
    StrCpy $DeleteUserData "1"
    keepData:
    SetSilent silent
  ${EndIf}
!macroend

!macro customUnInstall
  ${If} $DeleteUserData == "1"
    RMDir /r "$APPDATA\kovapreset"
    ; staged downloads from the auto-updater
    RMDir /r "$LOCALAPPDATA\kovapreset-updater"
  ${EndIf}
!macroend
