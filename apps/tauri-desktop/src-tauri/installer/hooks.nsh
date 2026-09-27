; DucKI Node - NSIS installer hooks (wired via bundle.windows.nsis.installerHooks).
;
; Tauri's own uninstaller only knows the bundle-identifier folders. DucKI keeps its runtime data
; in %LOCALAPPDATA%\DucKI Node (databases, logs, prompts) and user content in %USERPROFILE%\DucKI
; (shared workspace, skills, plugins). Both are handled here - never during updates.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ; Runtime data follows Tauri's "delete app data" checkbox.
    ${If} $DeleteAppDataCheckboxState = 1
      SetShellVarContext current
      RmDir /r "$LOCALAPPDATA\DucKI Node"
    ${EndIf}

    ; User content (workspace, skills, plugins) is only removed on an explicit yes. Silent and
    ; passive uninstalls always keep it (/SD IDNO).
    ${If} $PassiveMode <> 1
    ${AndIf} ${FileExists} "$PROFILE\DucKI\*.*"
      ${If} $LANGUAGE = 1031
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Sollen auch deine DucKI-Inhalte gelöscht werden?$\r$\n$\r$\n$PROFILE\DucKI$\r$\n(Shared Workspace, Skills, Plugins)$\r$\n$\r$\nDas kann nicht rückgängig gemacht werden." /SD IDNO IDYES ducki_delete_user_content IDNO ducki_keep_user_content
      ${Else}
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your DucKI content?$\r$\n$\r$\n$PROFILE\DucKI$\r$\n(shared workspace, skills, plugins)$\r$\n$\r$\nThis cannot be undone." /SD IDNO IDYES ducki_delete_user_content IDNO ducki_keep_user_content
      ${EndIf}
      ducki_delete_user_content:
        RmDir /r "$PROFILE\DucKI"
      ducki_keep_user_content:
    ${EndIf}
  ${EndIf}
!macroend
