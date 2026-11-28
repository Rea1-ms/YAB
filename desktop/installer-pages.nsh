; Standard MUI pages, with state preserved across the UAC restart.
; The license resume rule follows electron-builder's assisted installer:
; https://github.com/electron-userland/electron-builder/blob/42eb34fc6a22990762735e563227f4914074dc75/packages/app-builder-lib/templates/nsis/assistedInstaller.nsh

; Retain the builder's checked-by-default run option and unelevated launcher.
!ifndef BUILD_UNINSTALLER
  !define MUI_FINISHPAGE_RUN_TEXT "$(yabOpenApp)"
!endif

!macro customWelcomePage
  !ifdef UAC_IsInnerInstance
    Var yabWelcomeResumeSkipped
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE yabWelcomePre
  !define MUI_WELCOMEPAGE_TITLE "$(yabWelcomeTitle)"
  !insertmacro MUI_PAGE_WELCOME

  Function yabWelcomePre
    ${if} ${isUpdated}
      Abort
    ${endif}
    !ifdef UAC_IsInnerInstance
      ${if} ${UAC_IsInnerInstance}
      ${andIf} $yabWelcomeResumeSkipped != "1"
        ; Skip the initial replay, but leave Back navigation available.
        StrCpy $yabWelcomeResumeSkipped "1"
        Abort
      ${endif}
    !endif
  FunctionEnd
!macroend

; Called by the MUI callback adapter only for the license page.
!macro yabLicensePre
  !ifdef UAC_IsInnerInstance
    Var /GLOBAL yabLicenseAccepted
    Var /GLOBAL yabLicenseResumeSkipped
    ${if} ${UAC_IsInnerInstance}
    ${andIf} $yabLicenseResumeSkipped != "1"
      ; An .onInit elevation can happen before the original user accepted.
      !insertmacro UAC_AsUser_GetGlobalVar $yabLicenseAccepted
      ${if} $yabLicenseAccepted == "1"
        StrCpy $yabLicenseResumeSkipped "1"
        Abort
      ${endif}
    ${endif}
  !endif
!macroend

!macro yabLicenseLeave
  !ifdef UAC_IsInnerInstance
    ${ifNot} ${UAC_IsInnerInstance}
      StrCpy $yabLicenseAccepted "1"
    ${endif}
  !endif
!macroend

; The builder owns scope selection, registry lookup and elevation. Extend its
; real radio callbacks so the caption describes what the selected scope does.
!macro yabInstallScopeFunctions
  Var yabReinstallFolder
  Var yabDirectoryOverride
  Var yabPersonalNotice
  Var yabMachineDirectory
  Var yabMachineDirectoryEdited

  ; Input and output: $0. Return an existing program folder or an empty string.
  Function yabReinstallTarget
    Push $1
    ; Check that NSIS can represent the registered folder as a write target
    ; without changing what the scope page promises to reinstall.
    Push $INSTDIR
    Call yabSetDirectoryFromInput
    Pop $INSTDIR
    StrCmp $1 0 invalid_reinstall_target
    ${if} $yabDirectoryOverride != ""
    ${andIf} $yabDirectoryOverride != $0
      Goto invalid_reinstall_target
    ${endif}
    ; A bare drive root loses its final slash in $INSTDIR. A complete UNC
    ; share may itself hold the previously installed program.
    StrCpy $1 $0 2 -2
    StrCmp $1 ":\" invalid_reinstall_target
    StrCpy $1 $0 1 -1
    ${if} $1 == "\"
      StrCpy $1 "$0YAB.exe"
    ${else}
      StrCpy $1 "$0\YAB.exe"
    ${endif}
    System::Call 'kernel32::GetFileAttributesW(w r1) i.r1'
    StrCmp $1 -1 invalid_reinstall_target
    IntOp $1 $1 & 0x10
    StrCmp $1 0 reinstall_target_checked
    invalid_reinstall_target:
    StrCpy $0 ""
    reinstall_target_checked:
    Pop $1
  FunctionEnd

  Function yabRefreshScopeAction
    Push $0
    Push $1
    ${NSD_GetState} $MultiUser.InstallModePage.AllUsers $1
    ShowWindow $yabPersonalNotice ${SW_HIDE}
    ; Remember a radio change even if Back leaves this page before the
    ; builder applies its directory, shell context and elevation on Next.
    ${if} $1 = ${BST_CHECKED}
      StrCpy $installMode "all"
      StrCpy $0 $perMachineInstallationFolder
      ${ifNot} ${isUpdated}
      ${andIf} $perUserInstallationFolder != ""
      ${andIf} $perMachineInstallationFolder == ""
        ShowWindow $yabPersonalNotice ${SW_SHOW}
      ${endif}
    ${else}
      StrCpy $installMode "CurrentUser"
      StrCpy $0 $perUserInstallationFolder
    ${endif}
    StrCpy $1 $0
    Call yabReinstallTarget
    StrCpy $yabReinstallFolder $0
    GetDlgItem $0 $HWNDPARENT 1
    ${if} $yabReinstallFolder != ""
      SendMessage $0 ${WM_SETTEXT} 0 "STR:$(yabReinstall)"
    ${elseIf} ${isUpdated}
      SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
    ${else}
      SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^NextBtn)"
      ${if} $1 != ""
        ; A stale registration or explicit alternate /D needs confirmation.
        SendMessage $RadioButtonLabel1 ${WM_SETTEXT} 0 "STR:$(yabChooseInstallFolder)"
      ${endif}
    ${endif}
    Pop $1
    Pop $0
  FunctionEnd

  Function yabScopeChanged
    ; InstModeChange consumes the nsDialogs control handle on the stack.
    Call InstModeChange
    Call yabRefreshScopeAction
  FunctionEnd

  Function yabBindScopeAction
    ${NSD_CreateLabel} 10u 74u 280u 30u "$(yabReplacePersonal)"
    Pop $yabPersonalNotice
    ${NSD_OnClick} $MultiUser.InstallModePage.CurrentUser yabScopeChanged
    ${NSD_OnClick} $MultiUser.InstallModePage.AllUsers yabScopeChanged
    Call yabRefreshScopeAction
  FunctionEnd
!macroend

; The builder reads the personal uninstall entry from the executing process's
; HKCU. Migrate it only for a new machine install under the original account.
!macro yabCheckPersonalMigration
  Var /GLOBAL yabMigratePersonal
  StrCpy $yabMigratePersonal 0
  ${if} $perMachineInstallationFolder == ""
  ${andIf} $perUserInstallationFolder != ""
    ${ifNot} ${UAC_IsInnerInstance}
      StrCpy $yabMigratePersonal 1
    ${else}
      Push $0
      Push $1
      StrCpy $0 ""
      ClearErrors
      !insertmacro UAC_AsUser_Call Label yabReadMigrationAccountSid ${UAC_SYNCREGISTERS}
      ${ifNot} ${Errors}
      ${andIf} $0 != ""
        StrCpy $1 $0
        Call :yabReadMigrationAccountSid
        ${if} $0 == $1
          StrCpy $yabMigratePersonal 1
        ${endif}
      ${endif}
      Pop $1
      Pop $0
    ${endif}
  ${endif}
  Goto yabPersonalMigrationChecked

  ; Return the current process token's user SID in $0. Run the same code
  ; in each process so split tokens of the same account compare equal.
  yabReadMigrationAccountSid:
  Push $1
  Push $2
  Push $3
  StrCpy $0 ""
  System::Call 'advapi32::OpenProcessToken(p -1, i 8, *p .r1) i.r2'
  ${if} $2 != 0
    ; TOKEN_USER and SECURITY_MAX_SID_SIZE fit in 128 bytes on x86 and x64.
    System::Alloc 128
    Pop $2
    ${if} $2 P<> 0
      System::Call 'advapi32::GetTokenInformation(p r1, i 1, p r2, i 128, *i .r3) i.r0'
      ${if} $0 != 0
        System::Call '*$2(p .r3)'
        System::Call 'advapi32::ConvertSidToStringSidW(p r3, *p .r3) i.r0'
        ${if} $0 != 0
          System::Call 'kernel32::lstrcpynW(w .r0, p r3, i ${NSIS_MAX_STRLEN})'
          System::Call 'kernel32::LocalFree(p r3)'
        ${else}
          StrCpy $0 ""
        ${endif}
      ${else}
        StrCpy $0 ""
      ${endif}
      System::Free $2
    ${endif}
    System::Call 'kernel32::CloseHandle(p r1)'
  ${endif}
  Pop $3
  Pop $2
  Pop $1
  Return
  yabPersonalMigrationChecked:
!macroend
