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
