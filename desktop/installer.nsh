!include "${__FILEDIR__}\installer-ui.nsh"

; The builder calls this after its own SetDetailsPrint none. Restore only the
; live status line, keeping its application-running checks and file operations.
!macro customCheckAppRunning
  SetDetailsPrint textonly
  ${if} $LANGUAGE == ${LANG_SIMPCHINESE}
    DetailPrint "正在检查 YAB 运行状态…"
  ${elseIf} $LANGUAGE == ${LANG_TRADCHINESE}
    DetailPrint "正在檢查 YAB 執行狀態…"
  ${else}
    DetailPrint "Checking whether YAB is running..."
  ${endif}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  ${if} $LANGUAGE == ${LANG_SIMPCHINESE}
    DetailPrint "正在准备程序文件…"
  ${elseIf} $LANGUAGE == ${LANG_TRADCHINESE}
    DetailPrint "正在準備程式檔案…"
  ${else}
    DetailPrint "Preparing application files..."
  ${endif}
!macroend

; Use native dialog scaling at the display's startup DPI instead of bitmap scaling.
; This also applies to the generated uninstaller; it is not per-monitor DPI support.
!macro customHeader
  ManifestDPIAware true
  ; Language packs otherwise choose SimSun, including its bitmap strikes.
  ; MUI uses these same language fonts for its separately created bold titles.
  SetFont "Microsoft YaHei UI" 9
  !ifmacrodef _CHECK_APP_RUNNING
    ; Defining the hook above makes the builder skip these default declarations.
    Var pid
    !include "getProcessInfo.nsh"
  !endif
  !insertmacro yabUIHeader
  !ifdef BUILD_UNINSTALLER
    !include nsDialogs.nsh
    Var yabKeepAppData
    Var yabKeepAppDataCheckbox
    Var yabDataDialog

    Function un.yabDataPageCreate
      ${if} ${isUpdated}
        Abort
      ${endif}
      ${if} $LANGUAGE == ${LANG_SIMPCHINESE}
      ${orIf} $LANGUAGE == ${LANG_TRADCHINESE}
        !insertmacro MUI_HEADER_TEXT "应用数据" "选择卸载后是否保留配置和运行数据。"
      ${else}
        !insertmacro MUI_HEADER_TEXT "Application data" "Choose whether to keep your settings and runtime data."
      ${endif}
      nsDialogs::Create 1018
      Pop $yabDataDialog
      ${if} $yabDataDialog == error
        Abort
      ${endif}
      ${if} $LANGUAGE == ${LANG_SIMPCHINESE}
      ${orIf} $LANGUAGE == ${LANG_TRADCHINESE}
        ${NSD_CreateCheckbox} 0 12u 100% 16u "保留应用数据（推荐）"
        Pop $yabKeepAppDataCheckbox
        ${NSD_CreateLabel} 0 40u 100% 90u "保留配置、日志、运行环境和备份，重新安装后可继续使用。$\r$\n$\r$\n取消勾选将删除本安装目录中的 config 配置目录，以及当前用户默认应用数据目录中的 YAB 数据（含原 BAAS 数据）。$\r$\n$\r$\n通过环境变量指定到其他位置的数据不在清理范围内。"
      ${else}
        ${NSD_CreateCheckbox} 0 12u 100% 16u "Keep application data (recommended)"
        Pop $yabKeepAppDataCheckbox
        ${NSD_CreateLabel} 0 40u 100% 90u "Keep settings, logs, runtimes and backups for a future installation.$\r$\n$\r$\nUnchecking this option deletes config in this installation and the current user's default YAB application data (including legacy BAAS data).$\r$\n$\r$\nCustom locations selected through environment variables are kept."
      ${endif}
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
      !insertmacro yabRemoveDataDirectory "$APPDATA\baas-desktop"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    FunctionEnd
  !endif
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.yabDataPageCreate un.yabDataPageLeave
!macroend

!macro customUnInit
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
      Abort "Application data cannot be deleted during an update."
    ${endif}
    ${ifNot} ${Silent}
      Abort "Use --delete-app-data only with /S, or choose the option in the uninstaller."
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
