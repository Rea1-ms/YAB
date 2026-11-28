; Run after scope elevation and before invoking the previous uninstaller.
!macro yabRequireWritableInstallDirectory
  Push $R0
  Push $R1
  ClearErrors
  CreateDirectory "$INSTDIR"
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.R0'
  StrCpy $R1 -1
  ${if} $R0 != -1
    IntOp $R0 $R0 & 0x10
    ${if} $R0 != 0
      ; Request FILE_ADD_FILE and FILE_ADD_SUBDIRECTORY on the directory itself.
      System::Call 'kernel32::CreateFileW(w "$INSTDIR", i 6, i 7, p 0, i 3, i 0x02000000, p 0) p.R1'
    ${endif}
  ${endif}
  ${if} $R1 P= -1
    DetailPrint "$(yabDirectoryNotWritable)"
    Call yabInitTheme
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(yabDirectoryNotWritable)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}
  System::Call 'kernel32::CloseHandle(p R1)'
  Pop $R1
  Pop $R0
  ClearErrors
!macroend

; This marker stays alongside retained data during updates and after uninstall.
!macro yabReadDataOwner DIRECTORY OWNER HANDLE
  StrCpy ${OWNER} ""
  ClearErrors
  FileOpen ${HANDLE} "${DIRECTORY}\.yab-data-owner" r
  ${ifNot} ${Errors}
    FileReadUTF16LE ${HANDLE} ${OWNER}
    FileClose ${HANDLE}
  ${endif}
  ClearErrors
!macroend

!macro yabGrantDataDirectory DIRECTORY SID
  System::Call 'kernel32::GetFileAttributesW(w "${DIRECTORY}") i.r1'
  ${if} $1 == -1
    CreateDirectory "${DIRECTORY}"
    System::Call 'kernel32::GetFileAttributesW(w "${DIRECTORY}") i.r1'
  ${endif}
  ; Refuse reparse points and files. /L never applies the ACL to a link target.
  IntOp $1 $1 & 0x410
  ${if} $1 == 16
    nsExec::ExecToStack '"$SYSDIR\icacls.exe" "${DIRECTORY}" /grant:r "*${SID}:(OI)(CI)M" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /inheritance:r /L /Q'
    Pop $1
    Pop $2
    ${if} $1 != 0
      DetailPrint "Unable to grant user access to ${DIRECTORY} ($1)"
    ${endif}
  ${endif}
!macroend

!macro yabPrepareInstallData
  Goto yabInstallDataStart
  yabReadInstallAccountSid:
    !insertmacro yabReadProcessSid
    Return
  yabInstallDataStart:
  ${if} $installMode == "all"
    Push $0
    Push $1
    Push $2
    ; Reinstalling or updating from another account must keep the data owner.
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\.yab-data-owner") i.r1'
    ${if} $1 == -1
      StrCpy $0 ""
      ${if} ${UAC_IsInnerInstance}
        ClearErrors
        !insertmacro UAC_AsUser_Call Label yabReadInstallAccountSid ${UAC_SYNCREGISTERS}
        ${if} ${Errors}
          StrCpy $0 ""
        ${endif}
      ${else}
        Call :yabReadInstallAccountSid
      ${endif}
      ${if} $0 == ""
      ${orIf} $0 == "S-1-5-18"
      ${orIf} $0 == "S-1-5-19"
      ${orIf} $0 == "S-1-5-20"
        StrCpy $0 "-"
      ${endif}
      ; CREATE_NEW avoids opening a marker or link created after the check.
      System::Call 'kernel32::CreateFileW(w "$INSTDIR\.yab-data-owner", i 0x40000000, i 0, p 0, i 1, i 0x80, p 0) p.r1'
      ${if} $1 P<> -1
        StrLen $2 $0
        IntOp $2 $2 * 2
        System::Call 'kernel32::WriteFile(p r1, w r0, i r2, *i .r2, p 0) i.r2'
        System::Call 'kernel32::CloseHandle(p r1)'
        ${if} $2 != 0
        ${andIf} $0 != "-"
          !insertmacro yabGrantDataDirectory "$INSTDIR\config" $0
          !insertmacro yabGrantDataDirectory "$INSTDIR\data" $0
        ${endif}
      ${endif}
    ${endif}
    Pop $2
    Pop $1
    Pop $0
    ClearErrors
  ${endif}
!macroend
