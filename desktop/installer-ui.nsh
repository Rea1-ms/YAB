!include MUI2.nsh
!include FileFunc.nsh
!include nsDialogs.nsh

!ifmacrondef yabReadThemePreference
  !macro yabReadThemePreference OUTPUT
    ReadRegDWORD ${OUTPUT} HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT yabApplyTheme
!else
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.yabApplyTheme
!endif

; Keep MUI's callback behavior, adding the palette after every standard or
; multi-user page has created its controls. Custom pages call it explicitly.
!macroundef MUI_PAGE_FUNCTION_CUSTOM
!macro MUI_PAGE_FUNCTION_CUSTOM TYPE
  !ifdef MUI_PAGE_CUSTOMFUNCTION_${TYPE}
    Call "${MUI_PAGE_CUSTOMFUNCTION_${TYPE}}"
    !undef MUI_PAGE_CUSTOMFUNCTION_${TYPE}
  !endif
  !if "${TYPE}" == "SHOW"
    ; The builder's multi-user page resets MUI's prefix even in the
    ; uninstaller. Select the callback from the actual function instead.
    !ifdef __UNINSTALL__
      Call un.yabApplyTheme
    !else
      Call yabApplyTheme
    !endif
  !endif
!macroend

!macro yabThemeFunctions PREFIX
  Function ${PREFIX}yabInitTheme
    Push $0
    Push $1
    Push $2
    StrCpy $yabDarkMode 0
    ClearErrors
    !insertmacro yabReadThemePreference $0
    ${ifNot} ${Errors}
    ${andIf} $0 == 0
      ; Respect high contrast instead of replacing the accessibility palette.
      System::Call '*(i 12, i 0, p 0) p.r1'
      System::Call 'user32::SystemParametersInfoW(i 0x42, i 12, p r1, i 0)'
      System::Call '*$1(i, i.r0)'
      System::Free $1
      IntOp $0 $0 & 1
      ${if} $0 == 0
        StrCpy $yabDarkMode 1
        ; These optional theme APIs are available on supported Windows 10/11.
        System::Call 'kernel32::GetModuleHandleW(w "uxtheme.dll") p.r0'
        System::Call 'kernel32::GetProcAddress(p r0, p 135) p.r1'
        ${if} $1 != 0
          System::Call '::$1(i 1) i.r2'
        ${endif}
      ${endif}
    ${endif}
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  Function ${PREFIX}yabColorWindow
    Exch $0
    Push $1
    Push $2
    Push $3
    SetCtlColors $0 F0F0F0 202020
    System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
    System::Call 'kernel32::GetModuleHandleW(w "uxtheme.dll") p.r1'
    System::Call 'kernel32::GetProcAddress(p r1, p 133) p.r1'
    ${if} $1 != 0
      System::Call '::$1(p r0, i 1) i.r2'
    ${endif}
    System::Call 'user32::GetClassNameW(p r0, w.r2, i ${NSIS_MAX_STRLEN})'
    ${if} $2 == "Button"
      System::Call 'user32::GetWindowLongW(p r0, i -16) i.r1'
      IntOp $1 $1 & 0xF
      ${if} $1 == 7
        ; The themed group-box caption ignores the foreground color.
        System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
      ${endif}
    ${elseIf} $2 == "RichEdit20W"
    ${orIf} $2 == "RichEdit20A"
    ${orIf} $2 == "RICHEDIT50W"
      SendMessage $0 0x443 0 0x202020
      System::Alloc 92
      Pop $1
      System::Call '*$1(i 92, i 0x40000000, i 0, i 0, i 0, i 0x00F0F0F0)'
      SendMessage $0 0x444 4 $1
      System::Free $1
    ${elseIf} $2 == "msctls_progress32"
      System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
      SendMessage $0 0x2001 0 0x303030
      SendMessage $0 0x409 0 0xE0A050
    ${endif}
    System::Call 'user32::GetWindow(p r0, i 5) p.r3'
    ${while} $3 != 0
      Push $3
      Call ${PREFIX}yabColorWindow
      System::Call 'user32::GetWindow(p r3, i 2) p.r3'
    ${endWhile}
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  Function ${PREFIX}yabApplyTheme
    ${if} $yabDarkMode != 1
      Return
    ${endif}
    Push $0
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4) i.r0'
    ${if} $0 != 0
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'
    ${endif}
    Push $HWNDPARENT
    Call ${PREFIX}yabColorWindow
    System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x185)'
    Pop $0
  FunctionEnd
!macroend

!macro yabUIHeader
  Var yabDarkMode
  !ifdef BUILD_UNINSTALLER
    !insertmacro yabThemeFunctions "un."
  !else
    Var yabDirectoryDialog
    Var yabDirectoryInput
    Var yabDirectoryVisited
    !insertmacro yabThemeFunctions ""

  Function yabFinalizeDirectory
    Push $0
    Push $1
    ; NSIS strips a drive root's trailing slash when assigning $INSTDIR.
    ; Expand it before canonicalization, which would otherwise use the CWD.
    StrLen $0 $INSTDIR
    ${if} $0 == 2
      StrCpy $1 $INSTDIR 1 1
      ${if} $1 == ":"
        StrCpy $INSTDIR "$INSTDIR\YAB"
      ${endif}
    ${endif}
    ClearErrors
    GetFullPathName $1 "$INSTDIR"
    ${ifNot} ${Errors}
      StrCpy $INSTDIR $1
    ${endif}
    StrLen $0 $INSTDIR
    ${while} $0 > 3
      StrCpy $1 $INSTDIR 1 -1
      ${if} $1 != "\"
        ${break}
      ${endif}
      StrCpy $INSTDIR $INSTDIR -1
      StrLen $0 $INSTDIR
    ${endWhile}
    ${GetFileName} "$INSTDIR" $0
    ${if} $0 != "YAB"
    ${andIf} $0 != "yab-desktop"
      IfFileExists "$INSTDIR\YAB.exe" yab_directory_ready
      StrCpy $1 $INSTDIR 1 -1
      ${if} $1 == "\"
        StrCpy $INSTDIR $INSTDIR -1
      ${endif}
      StrCpy $INSTDIR "$INSTDIR\YAB"
    ${endif}
    yab_directory_ready:
    Pop $1
    Pop $0
  FunctionEnd

  Function yabDirectoryChanged
    Pop $0
    ${NSD_GetText} $yabDirectoryInput $INSTDIR
  FunctionEnd

  Function yabBrowseDirectory
    Pop $0
    ${NSD_GetText} $yabDirectoryInput $0
    nsDialogs::SelectFolderDialog "$(^BrowseForFolder)" "$0"
    Pop $1
    ${if} $1 == error
      Return
    ${endif}
    StrCpy $INSTDIR $1
    Call yabFinalizeDirectory
    ${NSD_SetText} $yabDirectoryInput $INSTDIR
    SendMessage $yabDirectoryInput ${EM_SETSEL} -1 -1
    SendMessage $yabDirectoryInput ${EM_SCROLLCARET} 0 0
  FunctionEnd

  Function yabDirectoryPage
    ${if} ${isUpdated}
      Abort
    ${endif}
    ${if} $yabDirectoryVisited != 1
      Call yabFinalizeDirectory
      StrCpy $yabDirectoryVisited 1
    ${endif}
    ${if} $LANGUAGE == ${LANG_SIMPCHINESE}
    ${orIf} $LANGUAGE == ${LANG_TRADCHINESE}
      !insertmacro MUI_HEADER_TEXT "选择安装位置" "下方显示的就是实际安装目录。"
    ${else}
      !insertmacro MUI_HEADER_TEXT "Installation folder" "The path below is the exact installation folder."
    ${endif}
    nsDialogs::Create 1018
    Pop $yabDirectoryDialog
    ${if} $yabDirectoryDialog == error
      Abort
    ${endif}
    ${if} $LANGUAGE == ${LANG_SIMPCHINESE}
    ${orIf} $LANGUAGE == ${LANG_TRADCHINESE}
      ${NSD_CreateLabel} 0 6u 100% 40u "浏览选好文件夹后，会自动补上 YAB 子目录；已有 YAB 文件夹时直接使用。$\r$\n也可以直接编辑完整安装路径。"
    ${else}
      ${NSD_CreateLabel} 0 6u 100% 40u "Browsing adds the YAB subfolder immediately. An existing YAB folder is used directly.$\r$\nYou can also edit the complete installation path."
    ${endif}
    Pop $0
    ${NSD_CreateDirRequest} 0 52u 76% 14u "$INSTDIR"
    Pop $yabDirectoryInput
    ${NSD_OnChange} $yabDirectoryInput yabDirectoryChanged
    ${NSD_CreateBrowseButton} 78% 51u 22% 16u "$(^BrowseBtn)"
    Pop $0
    ${NSD_OnClick} $0 yabBrowseDirectory
    Call yabApplyTheme
    nsDialogs::Show
  FunctionEnd

  Function yabDirectoryPageLeave
    ${NSD_GetText} $yabDirectoryInput $0
    System::Call 'shlwapi::PathIsRelativeW(w r0) i.r1'
    ${if} $0 == ""
    ${orIf} $1 != 0
      ${if} $LANGUAGE == ${LANG_SIMPCHINESE}
      ${orIf} $LANGUAGE == ${LANG_TRADCHINESE}
        MessageBox MB_OK|MB_ICONEXCLAMATION "请填写完整的安装目录。"
      ${else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Enter a complete installation folder path."
      ${endif}
      Abort
    ${endif}
    StrCpy $INSTDIR $0
    ; Do not add a folder here: installation uses the path already displayed.
  FunctionEnd
  !endif
!macroend

!macro customInit
  Call yabInitTheme
  StrCpy $yabDirectoryVisited 0
!macroend

; Use our own directory page, replacing the builder's late path mutation.
!macro customPageAfterChangeDir
  Page custom yabDirectoryPage yabDirectoryPageLeave
!macroend
