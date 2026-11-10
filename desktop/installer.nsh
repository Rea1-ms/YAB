!include "${__FILEDIR__}\installer-ui.nsh"

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
    Function .onInstSuccess
      YabInstallUI::Complete /NOUNLOAD "$(yabInstalled)"
    FunctionEnd
  !endif
  !ifdef BUILD_UNINSTALLER
    !include nsDialogs.nsh
    Var yabKeepAppData
    Var yabKeepAppDataCheckbox
    Var yabDataDialog

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
      ${NSD_CreateCheckbox} 0 12u 100% 16u "$(yabKeepData)"
      Pop $yabKeepAppDataCheckbox
      ${NSD_CreateLabel} 0 40u 100% 90u "$(yabKeepDataText)"
      Pop $0
      ${NSD_SetState} $yabKeepAppDataCheckbox $yabKeepAppData
      Call un.yabApplyTheme
      !insertmacro yabStyleCheckbox $yabKeepAppDataCheckbox "un."
      nsDialogs::Show
    FunctionEnd

    Function un.yabDataPageLeave
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
      ; Use only known application paths, never environment-provided directories.
      SetShellVarContext current
      !insertmacro yabRemoveDataDirectory "$INSTDIR\config"
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
  !define MUI_WELCOMEPAGE_TITLE "$(yabUnWelcomeTitle)"
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.yabDataPageCreate un.yabDataPageLeave
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
