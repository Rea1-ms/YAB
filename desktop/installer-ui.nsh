!include MUI2.nsh
!include FileFunc.nsh
!include nsDialogs.nsh
; Use MUI's native Yes/No confirmation for both Cancel and window-close.
!define /ifndef MUI_ABORTWARNING
!define /ifndef MUI_UNABORTWARNING
!include "${__FILEDIR__}\installer-i18n.nsh"
!include "${__FILEDIR__}\installer-controls.nsh"
!include "${__FILEDIR__}\installer-pages.nsh"
Var yabSidebarBitmap

; Load the high-resolution sidebar at its original size, then downsample to
; the actual DPI-scaled control. LoadImage(cx, cy), used by MUI by default,
; stretches with nearest-neighbour filtering and leaves jagged edges.
!macroundef MUI_INTERNAL_FULLWINDOW_LOADWIZARDIMAGE
!macro MUI_INTERNAL_FULLWINDOW_LOADWIZARDIMAGE _un CONTROL IMAGE HANDLE
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  StrCpy $0 ${CONTROL}
  StrCpy $4 0
  System::Call 'user32::LoadImageW(p 0, w "${IMAGE}", i ${IMAGE_BITMAP}, i 0, i 0, i ${LR_LOADFROMFILE}|${LR_CREATEDIBSECTION}) p.r1'
  ${if} $1 P<> 0
    System::Alloc 24
    Pop $9
    System::Call 'gdi32::GetObjectW(p r1, i 24, p r9)'
    System::Call '*$9(i, i.r5, i.r6)'
    System::Free $9
    System::Call 'user32::GetClientRect(p r0, @r9)'
    System::Call '*$9(i, i, i.r7, i.r8)'
    System::Call 'user32::GetDC(p r0) p.R2'
    System::Call 'gdi32::CreateCompatibleDC(p R2) p.r2'
    System::Call 'gdi32::CreateCompatibleDC(p R2) p.r3'
    System::Call 'gdi32::CreateCompatibleBitmap(p R2, i r7, i r8) p.r4'
    ${if} $2 P<> 0
    ${andIf} $3 P<> 0
    ${andIf} $4 P<> 0
      System::Call 'gdi32::SelectObject(p r2, p r1) p.R0'
      System::Call 'gdi32::SelectObject(p r3, p r4) p.R1'
      System::Call 'gdi32::SetStretchBltMode(p r3, i 4)'
      System::Call 'gdi32::SetBrushOrgEx(p r3, i 0, i 0, p 0)'
      System::Call 'gdi32::StretchBlt(p r3, i 0, i 0, i r7, i r8, p r2, i 0, i 0, i r5, i r6, i 0x00CC0020) i.r9'
      System::Call 'gdi32::SelectObject(p r2, p R0)'
      System::Call 'gdi32::SelectObject(p r3, p R1)'
      ${if} $9 = 0
        System::Call 'gdi32::DeleteObject(p r4)'
        StrCpy $4 0
      ${endif}
    ${else}
      System::Call 'gdi32::DeleteObject(p r4)'
      StrCpy $4 0
    ${endif}
    System::Call 'gdi32::DeleteDC(p r2)'
    System::Call 'gdi32::DeleteDC(p r3)'
    System::Call 'user32::ReleaseDC(p r0, p R2)'
    System::Call 'gdi32::DeleteObject(p r1)'
  ${endif}
  ${if} $4 P= 0
    ; Retain MUI's loading behavior if a graphics allocation fails.
    ${NSD_SetStretchedImage} $0 "${IMAGE}" $4
  ${else}
    SendMessage $0 ${STM_SETIMAGE} ${IMAGE_BITMAP} $4
  ${endif}
  StrCpy $yabSidebarBitmap $4
  ; Preserve MUI's ownership of this initial bitmap. The plugin owns only
  ; replacement images rendered when this control changes physical size.
  YabInstallUI::Sidebar /NOUNLOAD $0 "${IMAGE}"
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  StrCpy ${HANDLE} $yabSidebarBitmap
!macroend

!ifmacrondef yabReadThemePreference
  !macro yabReadThemePreference OUTPUT
    ReadRegDWORD ${OUTPUT} HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
  !macroend
!endif

!ifmacrondef yabReadHighContrast
  !macro yabReadHighContrast OUTPUT
    System::Call '*(i 12, i 0, p 0) p.r1'
    System::Call 'user32::SystemParametersInfoW(i 0x42, i 12, p r1, i 0)'
    System::Call '*$1(i, i.r0)'
    System::Free $1
    IntOp ${OUTPUT} $0 & 1
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
  !if "${TYPE}" == "PRE"
    ; The same Next button survives page changes. Clear both native and custom
    ; shield state before entering a page; the install-mode radio callback
    ; restores it only when continuing would actually request elevation.
    Push $0
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${BCM_SETSHIELD} 0 0
    Pop $0
  !endif
  !ifdef MUI_PAGE_CUSTOMFUNCTION_${TYPE}
    Call "${MUI_PAGE_CUSTOMFUNCTION_${TYPE}}"
    !undef MUI_PAGE_CUSTOMFUNCTION_${TYPE}
  !endif
  !ifndef BUILD_UNINSTALLER
    ; Retain the builder's update callback before adding license resume rules.
    !if "${TYPE}" == "PRE"
      !searchreplace YAB_LICENSE_CALLBACK "${__FUNCTION__}" "mui.LicensePre_" ""
      !if "${YAB_LICENSE_CALLBACK}" != "${__FUNCTION__}"
        !insertmacro yabLicensePre
      !endif
      !undef YAB_LICENSE_CALLBACK
    !else if "${TYPE}" == "LEAVE"
      !searchreplace YAB_LICENSE_CALLBACK "${__FUNCTION__}" "mui.LicenseLeave_" ""
      !if "${YAB_LICENSE_CALLBACK}" != "${__FUNCTION__}"
        !insertmacro yabLicenseLeave
      !endif
      !undef YAB_LICENSE_CALLBACK
    !endif
  !endif
  !if "${TYPE}" == "SHOW"
    ; The builder's multi-user page resets MUI's prefix even in the
    ; uninstaller. Select the callback from the actual function instead.
    !ifdef __UNINSTALL__
      Call un.yabApplyTheme
    !else
      Call yabApplyTheme
    !endif
    !searchreplace YAB_INSTFILES_SHOW "${__FUNCTION__}" "mui.InstFilesShow_" ""
    !if "${YAB_INSTFILES_SHOW}" != "${__FUNCTION__}"
      !ifdef __UNINSTALL__
        Call un.yabStartProgress
      !else
        Call yabStartProgress
      !endif
    !endif
    !undef YAB_INSTFILES_SHOW
  !endif
!macroend

!macro yabThemeFunctions PREFIX
  Function ${PREFIX}yabInitTheme
    Push $0
    Push $1
    Push $2
    StrCpy $yabDarkMode 0
    !insertmacro yabReadHighContrast $yabHighContrast
    ClearErrors
    !insertmacro yabReadThemePreference $0
    ${ifNot} ${Errors}
    ${andIf} $0 == 0
    ${andIf} $yabHighContrast == 0
      ; Respect high contrast instead of replacing the accessibility palette.
      StrCpy $yabDarkMode 1
    ${endif}
    Pop $2
    Pop $1
    Pop $0
    YabInstallUI::Initialize /NOUNLOAD $yabDarkMode $yabHighContrast
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
      ${if} $1 = ${BS_CHECKBOX}
      ${orIf} $1 = ${BS_AUTOCHECKBOX}
      ${orIf} $1 = ${BS_RADIOBUTTON}
      ${orIf} $1 = ${BS_3STATE}
      ${orIf} $1 = ${BS_AUTO3STATE}
      ${orIf} $1 = ${BS_GROUPBOX}
      ${orIf} $1 = ${BS_AUTORADIOBUTTON}
        ; Themed choice controls and group captions ignore SetCtlColors.
        ; Let the native unthemed controls use our readable foreground color;
        ; their checked state, keyboard input and accessibility stay native.
        ; System marshals an empty string as NULL (restore default theme).
        ; A space selects a nonexistent theme, as MUI's finish page does.
        System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
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
    Push $0
    ${if} $yabDarkMode = 1
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4) i.r0'
    ${if} $0 != 0
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'
    ${endif}
    Push $HWNDPARENT
    Call ${PREFIX}yabColorWindow
    ${endif}
    YabInstallUI::Apply /NOUNLOAD $yabDarkMode $yabHighContrast
    Pop $0
  FunctionEnd

  Function ${PREFIX}yabStartProgress
    !if "${PREFIX}" == "un."
      YabInstallUI::Progress /NOUNLOAD "$(yabRemoving)"
    !else
      YabInstallUI::Progress /NOUNLOAD "$(yabPreparing)"
      YabInstallUI::Phase /NOUNLOAD "$(yabPreparing)" 0 5
    !endif
  FunctionEnd
!macroend

!macro yabUIHeader
  Var yabDarkMode
  Var yabHighContrast
  !ifdef BUILD_UNINSTALLER
    !insertmacro yabThemeFunctions "un."
    !insertmacro yabCheckboxFunctions "un."
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
    YabInstallUI::BrowseFolder /NOUNLOAD "$(^BrowseForFolder)" "$0"
    Pop $1
    ${if} $1 == error
      ; Retain browsing on systems where the modern shell dialog is unavailable.
      nsDialogs::SelectFolderDialog "$(^BrowseForFolder)" "$0"
      Pop $1
    ${endif}
    ${if} $1 == error
    ${orIf} $1 == ""
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
    !insertmacro MUI_HEADER_TEXT "$(yabDirectoryTitle)" "$(yabDirectorySubtitle)"
    nsDialogs::Create 1018
    Pop $yabDirectoryDialog
    ${if} $yabDirectoryDialog == error
      Abort
    ${endif}
    ${NSD_CreateLabel} 0 0 100% 58u "$(yabDirectoryText)"
    Pop $0
    ${NSD_CreateGroupBox} 0 75u 100% 44u "$(yabDirectoryGroup)"
    Pop $0
    ${NSD_CreateDirRequest} 3% 92u 72% 14u "$INSTDIR"
    Pop $yabDirectoryInput
    ${NSD_OnChange} $yabDirectoryInput yabDirectoryChanged
    ${NSD_CreateBrowseButton} 77% 91u 20% 16u "$(^BrowseBtn)"
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
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(yabDirectoryInvalid)"
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

; The builder invokes this before architecture and elevation checks.
!macro preInit
  !ifndef BUILD_UNINSTALLER
    Call yabInitTheme
  !endif
!macroend

; Use our own directory page, replacing the builder's late path mutation.
!macro customPageAfterChangeDir
  Page custom yabDirectoryPage yabDirectoryPageLeave
!macroend
