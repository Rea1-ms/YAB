Var yabCopyDebugLog
Var yabCopyDebugHint

!macro yabCopyDebugLine TEXT
  ${if} $yabCopyDebugLog != ""
    Push $9
    ClearErrors
    FileOpen $9 "$yabCopyDebugLog" a
    ${ifNot} ${Errors}
      FileSeek $9 0 END
      FileWriteUTF16LE /BOM $9 "${TEXT}$\r$\n"
      FileClose $9
    ${endif}
    ClearErrors
    Pop $9
  ${endif}
!macroend

!macro yabStartCopyDebug
  Push $0
  Push $1
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--debug-install" $1
  ${ifNot} ${Errors}
  ${andIf} $1 == ""
    ; Use a new temporary file so a later attempt preserves this report.
    System::Call 'kernel32::GetTempFileNameW(w "$TEMP", w "YAB", i 0, w .r1) i.r0'
    ${if} $0 != 0
      StrCpy $yabCopyDebugLog $1
      StrCpy $yabCopyDebugHint "$\r$\n$\r$\n$(yabCopyDebugLogLabel) $yabCopyDebugLog"
      !insertmacro yabCopyDebugLine "YAB ${VERSION} | destination: $OUTDIR"
    ${endif}
  ${endif}
  ClearErrors
  Pop $1
  Pop $0
!macroend

!macro yabInspectCopyFailure
  ${if} $yabCopyDebugLog != ""
    !insertmacro yabCopyDebugLine "Destination checks after the failure (Win32 5 = access denied; 32 = sharing violation):"
    Call yabProbeCopyDestination
    !insertmacro yabCopyDebugLine "End of checks. An empty list means no blocked path was detected at probe time."
  ${endif}
!macroend

!macro yabCopyDebugFunctions
  ; Locate supplies the full staged path in $R9. Probe its counterpart in the
  ; install directory. OPEN_EXISTING requests access without writing files.
  Function yabProbeCopyEntry
    StrLen $0 "$PLUGINSDIR\7z-out"
    StrCpy $0 $R9 "" $0
    StrCpy $0 "$OUTDIR$0"
    Call yabProbeExistingCopyPath
    Push ""
  FunctionEnd

  Function yabProbeCopyDestination
    Push $0
    StrCpy $0 "$OUTDIR"
    Call yabProbeExistingCopyPath
    ${Locate} "$PLUGINSDIR\7z-out" "/L=FD" "yabProbeCopyEntry"
    Pop $0
    ClearErrors
  FunctionEnd

  Function yabProbeExistingCopyPath
    Push $1
    Push $2
    Push $3
    System::Call 'kernel32::GetFileAttributesW(w r0) i.r1 ?e'
    Pop $2
    ${if} $1 == -1
      ; Newly added files are normally absent before copying.
      ${if} $2 != 2
      ${andIf} $2 != 3
        !insertmacro yabCopyDebugLine "Win32 $2 | attributes | $0"
      ${endif}
    ${else}
      IntOp $2 $1 & 0x10 ; FILE_ATTRIBUTE_DIRECTORY
      ${if} $2 != 0
        StrCpy $3 6 ; FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY
      ${else}
        StrCpy $3 0x40010000 ; GENERIC_WRITE | DELETE
      ${endif}
      System::Call 'kernel32::CreateFileW(w r0, i r3, i 7, p 0, i 3, i 0x02000000, p 0) p.r1 ?e'
      Pop $2
      ${if} $1 P= -1
        !insertmacro yabCopyDebugLine "Win32 $2 | open for replacement | $0"
      ${else}
        System::Call 'kernel32::CloseHandle(p r1)'
      ${endif}
    ${endif}
    Pop $3
    Pop $2
    Pop $1
  FunctionEnd
!macroend
