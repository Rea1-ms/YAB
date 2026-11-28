; The desktop updater passes its own installation directory as /D. Resolve
; that directory against the registry in each process, including after UAC.
!macro yabSelectUpdateScope
  ${if} ${Silent}
  ${andIf} ${isUpdated}
    Push $R0
    !insertmacro GetDParameter $R0
    ${if} $R0 == ""
      ; Older launchers may omit /D. Only one registered scope is unambiguous.
      ${if} $perUserInstallationFolder == ""
        StrCpy $R0 $perMachineInstallationFolder
      ${elseIf} $perMachineInstallationFolder == ""
        StrCpy $R0 $perUserInstallationFolder
      ${endif}
    ${endif}
    ${if} $R0 != ""
    ${andIf} $R0 == $perMachineInstallationFolder
    ${andIf} $R0 != $perUserInstallationFolder
      StrCpy $installMode "all"
      StrCpy $hasPerMachineInstallation "1"
      SetShellVarContext all
      StrCpy $INSTDIR $perMachineInstallationFolder
    ${elseIf} $R0 != ""
    ${andIf} $R0 == $perUserInstallationFolder
    ${andIf} $R0 != $perMachineInstallationFolder
    ${andIfNot} ${UAC_IsInnerInstance}
      ; The builder uses the machine flag to request elevation in silent mode.
      StrCpy $installMode "CurrentUser"
      StrCpy $hasPerMachineInstallation "0"
      SetShellVarContext current
      StrCpy $INSTDIR $perUserInstallationFolder
    ${else}
      DetailPrint "Update destination does not identify one registered installation: $R0"
      SetErrorLevel 2
      Quit
    ${endif}
    Pop $R0
  ${endif}
!macroend
