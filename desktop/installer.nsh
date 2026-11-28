!include "${__FILEDIR__}\installer-ui.nsh"
!include "${__FILEDIR__}\installer-data.nsh"
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
  !ifmacrodef UAC_AsUser_Call
    !insertmacro yabPrepareInstallData
  !endif
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
      StrCpy $0 $INSTDIR
      StrCpy $1 $installMode
      !ifmacrodef UAC_AsUser_Call
        ${if} ${UAC_IsInnerInstance}
          ; Send the selected installation to the unelevated process. Only
          ; that process walks directories writable by the initiating user.
          !insertmacro UAC_AsUser_Call Function un.yabRemoveAccountData ${UAC_SYNCREGISTERS}
        ${else}
          Call un.yabRemoveAccountData
        ${endif}
      !else
        Call un.yabRemoveAccountData
      !endif
      IfFileExists "$INSTDIR\config" +4 0
      IfFileExists "$INSTDIR\data" +3 0
      Delete "$INSTDIR\.yab-data-owner"
      Delete "$INSTDIR\desktop-update.json"
      ClearErrors
    FunctionEnd

    Function un.yabRemoveAccountData
      Push $R0
      Push $R1
      Push $R2
      Push $R3
      StrCpy $R0 $0
      StrCpy $R1 "current-user"
      ${if} $1 == "all"
        StrCpy $R1 "all-users"
      ${endif}
      !insertmacro yabReadDataOwner $R0 $R2 $R3
      !insertmacro yabReadProcessSid
      ${if} $R2 == ""
      ${orIf} $R2 == $0
        !insertmacro yabRemoveDataDirectory "$R0\config"
        !insertmacro yabRemoveDataDirectory "$R0\data"
      ${endif}
      SetShellVarContext current
      !insertmacro yabRemoveDataDirectory "$LOCALAPPDATA\YAB\$R1"
      !insertmacro yabRemoveDataDirectory "$APPDATA\yab-desktop"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
    FunctionEnd

    !ifdef YAB_SAFE_DATA_REMOVAL
      Function un.yabRemoveOwnedTree
        Exch $0
        Push $1
        Push $2
        Push $3
        System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
        ${if} $1 != -1
          IntOp $2 $1 & 16
          ${if} $2 == 0
            Delete "$0"
          ${else}
            IntOp $2 $1 & 0x400
            ${if} $2 == 0
              ClearErrors
              FindFirst $2 $3 "$0\*"
              ${ifNot} ${Errors}
                ${do}
                  ${if} $3 != "."
                  ${andIf} $3 != ".."
                    Push "$0\$3"
                    Call un.yabRemoveOwnedTree
                  ${endif}
                  ClearErrors
                  FindNext $2 $3
                ${loopUntil} ${Errors}
                FindClose $2
              ${endif}
            ${endif}
            ; Remove a junction itself and never enumerate its target.
            RMDir "$0"
          ${endif}
        ${endif}
        Pop $3
        Pop $2
        Pop $1
        Pop $0
      FunctionEnd
    !endif

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
  !define YAB_SAFE_DATA_REMOVAL
  !macro yabRemoveDataDirectory DIRECTORY
    Push "${DIRECTORY}"
    Call un.yabRemoveOwnedTree
  !macroend
!endif

!ifmacrondef yabRemoveEmptyInstallDirectory
  !macro yabRemoveEmptyInstallDirectory
    RMDir "$INSTDIR"
  !macroend
!endif
