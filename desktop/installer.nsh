!include "${__FILEDIR__}\installer-ui.nsh"
!ifndef BUILD_UNINSTALLER
  !ifdef YAB_INSTALL_COPY_DEBUG
    !include "${__FILEDIR__}\installer-copy-debug.nsh"
  !endif
!endif

; The builder calls this after its own SetDetailsPrint none. Restore only the
; live status line, keeping its application-running checks and file operations.
!macro customCheckAppRunning
  ; This can run during initialization or on the section's worker thread.
  !ifdef __UNINSTALL__
    Call un.yabInitTheme
  !else
    Call yabInitTheme
  !endif
  SetDetailsPrint textonly
  DetailPrint "$(yabChecking)"
  YabInstallUI::Stage /NOUNLOAD "$(yabChecking)"
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  ; This hook also runs inside un.checkAppRunning. Select by the real
  ; function context, not MUI's mutable page prefix.
  !ifdef __UNINSTALL__
    DetailPrint "$(yabRemoving)"
    YabInstallUI::Stage /NOUNLOAD "$(yabRemoving)"
  !else
    DetailPrint "$(yabPreparing)"
    YabInstallUI::Stage /NOUNLOAD "$(yabPreparing)"
  !endif
!macroend

!macro customInstall
  ; Only installed copies may launch automatic installer updates.
  Push $R9
  ClearErrors
  FileOpen $R9 "$INSTDIR\resources\yab-install-location" w
  ${ifNot} ${Errors}
    FileWriteUTF16LE $R9 "$INSTDIR"
    FileClose $R9
  ${endif}
  Pop $R9
  ; A missing marker safely disables updates without invalidating installed files.
  ClearErrors
  YabInstallUI::Phase /NOUNLOAD "$(yabFinishing)" 98 99
!macroend

; Windows scales native dialogs per monitor. The plugin refreshes its own
; artwork and layout after the system finishes scaling their controls.
!macro customHeader
  ManifestDPIAware true
  ManifestDPIAwareness "PerMonitorV2,System"
  ; Language packs otherwise choose SimSun, including its bitmap strikes.
  ; MUI uses these same language fonts for its separately created bold titles.
  SetFont "Microsoft YaHei UI" 9
  !ifmacrodef _CHECK_APP_RUNNING
    ; Defining the hook above makes the builder skip these default declarations.
    Var pid
    !include "getProcessInfo.nsh"
  !endif
  !insertmacro yabUIHeader
  !ifndef BUILD_UNINSTALLER
    !ifdef YAB_INSTALL_COPY_DEBUG
      !insertmacro yabCopyDebugFunctions
    !endif
    Function .onInstSuccess
      YabInstallUI::Complete /NOUNLOAD "$(yabInstalled)"
    FunctionEnd
  !endif
  !ifdef BUILD_UNINSTALLER
    !include nsDialogs.nsh
    Var yabKeepAppData
    Var yabKeepAppDataCheckbox
    Var yabDataDialog
    Var yabUninstallLocation

    Function un.yabDataPageCreate
      ${if} ${isUpdated}
        Abort
      ${endif}
      !insertmacro MUI_HEADER_TEXT "$(yabDataTitle)" "$(yabDataSubtitle)"
      nsDialogs::Create 1018
      Pop $yabDataDialog
      ${if} $yabDataDialog == error
        Abort
      ${endif}
      ${NSD_CreateLabel} 0 0 100% 11u "$(yabUninstallLocationLabel)"
      Pop $0
      ${NSD_CreateText} 0 13u 100% 14u "$INSTDIR"
      Pop $yabUninstallLocation
      SendMessage $yabUninstallLocation ${EM_SETREADONLY} 1 0
      ${NSD_CreateCheckbox} 0 36u 100% 16u "$(yabKeepData)"
      Pop $yabKeepAppDataCheckbox
      ${NSD_CreateLabel} 0 56u 100% 76u "$(yabKeepDataText)"
      Pop $0
      ${NSD_SetState} $yabKeepAppDataCheckbox $yabKeepAppData
      ; Back bypasses the leave callback. Remember changes as they happen.
      ${NSD_OnClick} $yabKeepAppDataCheckbox un.yabDataChoiceChanged
      Call un.yabApplyTheme
      !insertmacro yabStyleCheckbox $yabKeepAppDataCheckbox "un."
      nsDialogs::Show
    FunctionEnd

    Function un.yabDataChoiceChanged
      Pop $0
      ${NSD_GetState} $yabKeepAppDataCheckbox $yabKeepAppData
    FunctionEnd

    Function un.yabRemoveAppData
      ; Upgrades must preserve data even if a previous page changed the choice.
      ${if} ${isUpdated}
        Return
      ${endif}
      ${if} $yabKeepAppData != ${BST_UNCHECKED}
        Return
      ${endif}
      !insertmacro yabRemoveDataDirectory "$INSTDIR\config"
      !ifmacrodef UAC_AsUser_Call
        ${if} ${UAC_IsInnerInstance}
          ; Resolve AppData and remove it in the original user's own process.
          ; Neither paths nor registers cross the privilege boundary.
          !insertmacro UAC_AsUser_Call Function un.yabRemoveAccountData 0
          Return
        ${endif}
      !endif
      Call un.yabRemoveAccountData
    FunctionEnd

    Function un.yabRemoveAccountData
      SetShellVarContext current
      !insertmacro yabRemoveDataDirectory "$APPDATA\yab-desktop"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    FunctionEnd

    ; The builder removes shortcuts and registry entries after customRemoveFiles.
    ; Retry known program directories deepest first, then the installation root.
    ; A child left behind by the first recursive pass would otherwise prevent
    ; every root-only retry. RMDir without /r removes empty directories only.
    Function un.onUninstSuccess
      YabInstallUI::Complete /NOUNLOAD "$(yabRemoved)"
      ${if} ${isUpdated}
        Return
      ${endif}
      SetOutPath "$TEMP"
      Push $0
      StrCpy $0 0
      ${do}
        !ifmacrodef yabRemoveEmptyProgramDirectories
          !insertmacro yabRemoveEmptyProgramDirectories
        !endif
        ClearErrors
        !insertmacro yabRemoveEmptyInstallDirectory
        ${ifNot} ${Errors}
          ${break}
        ${endif}
        IntOp $0 $0 + 1
        ${if} $0 >= 3
          ${break}
        ${endif}
        Sleep 150
      ${loop}
      Pop $0
      ClearErrors
    FunctionEnd
  !endif
!macroend

!macro customUnWelcomePage
  !ifdef UAC_IsInnerInstance
    Var yabUnWelcomeSeen
    Var yabUnWelcomeResumed
    !define MUI_PAGE_CUSTOMFUNCTION_PRE un.yabWelcomePre
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.yabWelcomeLeave
  !endif
  !define MUI_WELCOMEPAGE_TITLE "$(yabUnWelcomeTitle)"
  !insertmacro MUI_UNPAGE_WELCOME
  !ifdef UAC_IsInnerInstance
    Function un.yabWelcomePre
      ${if} ${UAC_IsInnerInstance}
      ${andIf} $yabUnWelcomeResumed != "1"
        StrCpy $yabUnWelcomeResumed "1"
        !insertmacro UAC_AsUser_GetGlobalVar $yabUnWelcomeSeen
        ${if} $yabUnWelcomeSeen == "1"
          Abort
        ${endif}
      ${endif}
    FunctionEnd
    Function un.yabWelcomeLeave
      StrCpy $yabUnWelcomeSeen "1"
    FunctionEnd
  !endif
!macroend

!macro yabUninstallDataPage
  UninstPage custom un.yabDataPageCreate
!macroend

!ifmacrondef yabUnregisteredUninstallNotice
  !macro yabUnregisteredUninstallNotice
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(yabUnregisteredUninstall)"
  !macroend
!endif

; These are the two InstallLocation values read by the assisted installer.
; Its silent old-version removal also supports legacy registrations without them.
!macro yabRequireUninstallRegistration
  ${ifNot} ${Silent}
    StrCpy $R0 $perUserInstallationFolder
    ${if} ${isForAllUsers}
    ${orIf} ${UAC_IsInnerInstance}
      StrCpy $R0 $perMachineInstallationFolder
    ${elseIfNot} ${isForCurrentUser}
    ${andIf} $R0 == ""
      StrCpy $R0 $perMachineInstallationFolder
    ${endif}
    ${if} $R0 == ""
      !insertmacro yabUnregisteredUninstallNotice
      SetErrorLevel 2
      Quit
    ${endif}
  ${endif}
!macroend

!macro customUnInit
  !ifdef YAB_REQUIRE_EARLY_THEME
    !ifndef YAB_UNINSTALLER_EARLY_THEME
      !error "The generated uninstaller theme template was not loaded."
    !endif
  !endif
  Call un.yabInitTheme
  StrCpy $yabKeepAppData ${BST_CHECKED}
  ; Honor the existing explicit silent-uninstall flag; ordinary /S keeps data.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${ifNot} ${Errors}
    ; The builder's default uninstaller also interprets this flag after our
    ; callbacks. Reject combinations that could bypass the user's choice.
    ${if} ${isUpdated}
      Abort "$(yabCannotDeleteOnUpdate)"
    ${endif}
    ${ifNot} ${Silent}
      Abort "$(yabDeleteRequiresSilent)"
    ${endif}
    StrCpy $yabKeepAppData ${BST_UNCHECKED}
  ${endif}
!macroend

!macro customUnInstall
  Call un.yabRemoveAppData
!macroend

; Tests replace this operation with a log writer and never remove files.
!ifmacrondef yabRemoveDataDirectory
  !macro yabRemoveDataDirectory DIRECTORY
    RMDir /r "${DIRECTORY}"
  !macroend
!endif

!ifmacrondef yabRemoveEmptyInstallDirectory
  !macro yabRemoveEmptyInstallDirectory
    RMDir "$INSTDIR"
  !macroend
!endif
