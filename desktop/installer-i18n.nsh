!include LangFile.nsh

; electron-builder supplies these from desktop/package.json. Standalone
; previews can supply their own version before including installer.nsh.
!define /ifndef PRODUCT_NAME "YAB"
!define /ifndef VERSION "dev"
!define YAB_DISPLAY_NAME "${PRODUCT_NAME} v${VERSION}"
!define YAB_TRANSLATIONS_DIR "${__FILEDIR__}\installer-translations"

; Keep MUI's standard language loader, then load our separate translations.
; Unsupported languages get English custom text and retain MUI's own language.
!macroundef MUI_LANGUAGE
!macro MUI_LANGUAGE NLFID
  !verbose push ${MUI_VERBOSE}
  !insertmacro MUI_LANGUAGEEX "${NSISDIR}\Contrib\Language files" "${NLFID}"
  !define YAB_TRANSLATION_LANGUAGE "${NLFID}"
  !if /FileExists "${YAB_TRANSLATIONS_DIR}\${NLFID}.nsh"
    !insertmacro LANGFILE_INCLUDE_WITHDEFAULT "${YAB_TRANSLATIONS_DIR}\${NLFID}.nsh" "${YAB_TRANSLATIONS_DIR}\English.nsh"
  !else
    !insertmacro LANGFILE_INCLUDE "${YAB_TRANSLATIONS_DIR}\English.nsh"
  !endif
  !undef YAB_TRANSLATION_LANGUAGE
  !verbose pop
!macroend
