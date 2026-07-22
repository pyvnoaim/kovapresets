; Uninstall hook: let the user choose between a full wipe and keeping their
; data. The app data folder is %APPDATA%\kovapreset (the RUNTIME app name, not
; the productName) - it holds presets, hotkeys, settings and the baseline
; backup of the pre-KovaPresets game files.
!macro customUnInstall
  ${ifNot} ${isUpdated}          ; app updates uninstall silently - never prompt there
    IfSilent keepData            ; ditto for an explicit silent uninstall (/S)
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also delete your presets, hotkeys and settings?$\r$\n$\r$\nChoose No to keep them for a future reinstall." \
      IDNO keepData
      RMDir /r "$APPDATA\kovapreset"
    keepData:
  ${endIf}
!macroend
