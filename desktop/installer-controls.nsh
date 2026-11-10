; Drawing is implemented in the native plugin, shared by every page and
; control. Keep these macros for callers of the previous checkbox extension.
!addplugindir /x86-unicode "${__FILEDIR__}/assets"

!macro yabCheckboxFunctions PREFIX
!macroend

!macro yabStyleCheckbox CONTROL PREFIX
  YabInstallUI::Apply /NOUNLOAD $yabDarkMode $yabHighContrast
!macroend
