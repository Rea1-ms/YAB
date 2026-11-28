Unicode true
; The routing preview omits the production welcome, license and finish pages.
!pragma warning disable 6001
!include MUI2.nsh
!include LogicLib.nsh
!define APP_FILENAME "YAB"
!define APP_EXECUTABLE_FILENAME "YAB.exe"
!define isUpdated '0 = 1'
!define UAC_IsInnerInstance '$inner = 1'
!define UAC_IsAdmin '$admin = 1'
!define isForCurrentUser '0 = 1'
!define isForAllUsers '0 = 1'
!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION

Var installMode
Var hasPerMachineInstallation
Var hasPerUserInstallation
Var perMachineInstallationFolder
Var perUserInstallationFolder
Var inner
Var admin
Var scenario
Var report
Var step
Var page

; Supply isolated installation records and privilege results. Keep the actual
; range page, radio notifications, directory controls and page transitions.
!macro GetDParameter result
  ReadINIStr ${result} "$EXEDIR\routing.ini" state directoryOverride
!macroend
!macro UAC_AsUser_GetGlobalVar result
  !if "${result}" == "$yabReinstallFolder"
    ReadINIStr ${result} "$EXEDIR\routing.ini" state confirmedFolder
  !else
    StrCpy ${result} ""
  !endif
!macroend
!macro UAC_RunElevated
  FileWriteUTF16LE $report "elevation-requested$\r$\n"
  ; Resume the same range page after a simulated denial.
  ${NSD_CreateTimer} drivePage 50
  StrCpy $0 1223
!macroend
!macro setInstallModePerAllUsers
  StrCpy $installMode all
  StrCpy $INSTDIR "$EXEDIR\new-machine\YAB"
  ${If} $perMachineInstallationFolder != ""
    StrCpy $INSTDIR $perMachineInstallationFolder
  ${EndIf}
  !insertmacro previewDirectoryOverride
!macroend
!macro setInstallModePerUser
  StrCpy $installMode CurrentUser
  StrCpy $INSTDIR "$EXEDIR\new-personal\YAB"
  ${If} $perUserInstallationFolder != ""
    StrCpy $INSTDIR $perUserInstallationFolder
  ${EndIf}
  !insertmacro previewDirectoryOverride
!macroend
!macro previewDirectoryOverride
  !insertmacro GetDParameter $0
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
!macroend
!include "${__FILEDIR__}\..\installer.nsh"
!include "${MODE_PAGE}"

Name "YAB install routing preview"
OutFile "${PREVIEW_DIR}\routing.exe"
RequestExecutionLevel user
AutoCloseWindow true
!define MUI_PAGE_CUSTOMFUNCTION_SHOW modeShown
!insertmacro PAGE_INSTALL_MODE
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE English
!include "${PREVIEW_DIR}\messages.nsh"

; Schedule the driver only when the production page creates its real input.
; The timer fires after all controls have been created and the page is visible.
!define previewCreateDirRequest "${NSD_CreateDirRequest}"
!define /redef NSD_CreateDirRequest "!insertmacro previewDirectoryControl"
!macro previewDirectoryControl x y width height initial
  StrCpy $page directory
  ${NSD_CreateTimer} drivePage 50
  ${previewCreateDirRequest} ${x} ${y} ${width} ${height} "${initial}"
!macroend
!insertmacro customHeader

Function .onInit
  ReadINIStr $scenario "$EXEDIR\routing.ini" state scenario
  ReadINIStr $admin "$EXEDIR\routing.ini" state admin
  ReadINIStr $inner "$EXEDIR\routing.ini" state inner
  ReadINIStr $perMachineInstallationFolder "$EXEDIR\routing.ini" state machine
  ReadINIStr $perUserInstallationFolder "$EXEDIR\routing.ini" state personal
  StrCpy $hasPerMachineInstallation 0
  StrCpy $hasPerUserInstallation 0
  ${If} $perMachineInstallationFolder != ""
    StrCpy $hasPerMachineInstallation 1
  ${EndIf}
  ${If} $perUserInstallationFolder != ""
    StrCpy $hasPerUserInstallation 1
  ${EndIf}
  ${If} $hasPerMachineInstallation == 1
  ${AndIf} $hasPerUserInstallation == 0
    !insertmacro setInstallModePerAllUsers
  ${Else}
    !insertmacro setInstallModePerUser
  ${EndIf}
  FileOpen $report "$EXEDIR\result-$scenario.txt" w
  StrCpy $step 0
  !insertmacro customInit
FunctionEnd

Function modeShown
  StrCpy $page scope
  ${NSD_CreateTimer} drivePage 50
FunctionEnd

Function snapshot
  GetDlgItem $0 $HWNDPARENT 1
  ${NSD_GetText} $0 $1
  System::Call 'user32::GetPropW(p r0, w "YAB.Shield") p.r2'
  ${If} $page == scope
    ${NSD_GetState} $MultiUser.InstallModePage.AllUsers $3
    ${If} $3 == ${BST_CHECKED}
      StrCpy $3 all
    ${Else}
      StrCpy $3 current
    ${EndIf}
  ${Else}
    ${NSD_GetText} $yabDirectoryInput $3
  ${EndIf}
  FileWriteUTF16LE $report "$page|$1|$2|$3$\r$\n"
  ${If} $page == scope
    System::Call 'user32::GetWindowLongW(p $yabPersonalNotice, i -16) i.r0'
    IntOp $0 $0 & ${WS_VISIBLE}
    ${If} $0 != 0
      ${NSD_GetText} $yabPersonalNotice $1
      ${If} $1 == "$(yabReplacePersonal)"
        FileWriteUTF16LE $report "personal-migration-notice$\r$\n"
      ${Else}
        FileWriteUTF16LE $report "unexpected-notice|$1$\r$\n"
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

Function drivePage
  ${NSD_KillTimer} drivePage
  ${Do}
    Call snapshot
    IntOp $step $step + 1
    ReadINIStr $0 "$EXEDIR\routing.ini" actions $step
    ${Switch} $0
      ${Case} all
        SendMessage $MultiUser.InstallModePage.AllUsers ${BM_CLICK} 0 0
        ${Break}
      ${Case} current
        SendMessage $MultiUser.InstallModePage.CurrentUser ${BM_CLICK} 0 0
        ${Break}
      ${Case} edit
        ${NSD_SetText} $yabDirectoryInput "$EXEDIR\chosen"
        ${Break}
      ${Case} clear
        ${NSD_SetText} $yabDirectoryInput ""
        ${Break}
      ${Case} edit-relative
        ${NSD_SetText} $yabDirectoryInput "C:unfinished/"
        ${Break}
      ${Case} back
        System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_COMMAND}, p 3, p 0)'
        Return
      ${Case} next
        System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_COMMAND}, p 1, p 0)'
        Return
      ${Default}
        FileWriteUTF16LE $report "unexpected page at step $step$\r$\n"
        SetErrorLevel 1
        Quit
    ${EndSwitch}
  ${Loop}
FunctionEnd

Section
  FileWriteUTF16LE $report "install|$installMode|$INSTDIR$\r$\n"
  FileClose $report
SectionEnd
