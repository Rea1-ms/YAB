; Fluent-style painting for a native checkbox: Windows still handles focus,
; Space, clicks, checked state and accessibility. High contrast stays native.
; System's x86 call interface needs IEEE-754 bits for GDI+ REAL parameters.
; Convert integer stroke widths (1..15 physical pixels) without a float plugin.
!macro yabStrokeBits PIXELS OUTPUT
  ${if} ${PIXELS} >= 8
    IntOp ${OUTPUT} ${PIXELS} << 20
    IntOp ${OUTPUT} ${OUTPUT} + 0x40800000
  ${elseIf} ${PIXELS} >= 4
    IntOp ${OUTPUT} ${PIXELS} << 21
    IntOp ${OUTPUT} ${OUTPUT} + 0x40000000
  ${elseIf} ${PIXELS} >= 2
    IntOp ${OUTPUT} ${PIXELS} << 22
    IntOp ${OUTPUT} ${OUTPUT} + 0x3F800000
  ${else}
    StrCpy ${OUTPUT} 0x3F800000
  ${endif}
!macroend

!macro yabCheckboxFunctions PREFIX
  Function ${PREFIX}yabDrawCheckbox
    System::Store S
    Pop $0 ; control
    Pop $1 ; notification
    Pop $2 ; NMCUSTOMDRAW
    ${if} $1 != -12 ; NM_CUSTOMDRAW
    ${orIf} $yabHighContrast != 0
    ${orIf} $yabGdiToken P= 0
      System::Store L
      Return
    ${endif}
    System::Call '*$2(p, p, i, i.r3, p.r4, i.r5, i.r6, i.r7, i.r8, p, i.r9)'
    ${if} $3 != 1 ; CDDS_PREPAINT
      System::Store L
      Return
    ${endif}
    System::Call 'gdi32::SaveDC(p r4)'
    ; Use device pixels throughout, based on this control's startup DPI.
    System::Call 'user32::GetDpiForWindow(p r0) i.R0'
    System::Call 'kernel32::MulDiv(i 16, i R0, i 96) i.R1'
    System::Call 'kernel32::MulDiv(i 4, i R0, i 96) i.R2'
    System::Call 'kernel32::MulDiv(i 2, i R0, i 96) i.R0'
    IntOp $R3 $8 - $6
    IntOp $R3 $R3 - $R1
    IntOp $R3 $R3 / 2
    IntOp $R3 $R3 + $6
    ${if} $yabDarkMode = 1
      StrCpy $R4 0x202020
      StrCpy $R5 0x00F0F0F0
      StrCpy $R6 0xFF60CDFF
      StrCpy $R7 0xFFAAAAAA
      StrCpy $R8 0xFF10202A
    ${else}
      System::Call 'user32::GetSysColor(i 15) i.R4'
      StrCpy $R5 0x00202020
      StrCpy $R6 0xFF0078D4
      StrCpy $R7 0xFF777777
      StrCpy $R8 0xFFFFFFFF
    ${endif}
    ; Clear the complete row, then draw rounded geometry with antialiasing.
    System::Call 'gdi32::SetDCBrushColor(p r4, i R4)'
    System::Call 'gdi32::GetStockObject(i 18) p.R9'
    IntOp $3 $2 + 20
    System::Call 'user32::FillRect(p r4, p r3, p R9)'
    System::Call 'gdiplus::GdipCreateFromHDC(p r4, *p.r1)'
    System::Call 'gdiplus::GdipSetSmoothingMode(p r1, i 4)'
    System::Call 'gdiplus::GdipCreatePath(i 0, *p.r2)'
    IntOp $3 $5 + $R1
    IntOp $3 $3 - $R2
    IntOp $6 $R3 + $R1
    IntOp $6 $6 - $R2
    System::Call 'gdiplus::GdipAddPathArcI(p r2, i r5, i R3, i R2, i R2, i 0x43340000, i 0x42B40000)'
    System::Call 'gdiplus::GdipAddPathArcI(p r2, i r3, i R3, i R2, i R2, i 0x43870000, i 0x42B40000)'
    System::Call 'gdiplus::GdipAddPathArcI(p r2, i r3, i r6, i R2, i R2, i 0, i 0x42B40000)'
    System::Call 'gdiplus::GdipAddPathArcI(p r2, i r5, i r6, i R2, i R2, i 0x42B40000, i 0x42B40000)'
    System::Call 'gdiplus::GdipClosePathFigure(p r2)'
    SendMessage $0 ${BM_GETCHECK} 0 0 $3
    ${if} $3 = ${BST_CHECKED}
      System::Call 'gdiplus::GdipCreateSolidFill(i R6, *p.r3)'
      System::Call 'gdiplus::GdipFillPath(p r1, p r3, p r2)'
      System::Call 'gdiplus::GdipDeleteBrush(p r3)'
      !insertmacro yabStrokeBits $R0 $R9
      System::Call 'gdiplus::GdipCreatePen1(i R8, i R9, i 0, *p.r3)'
      ; Checkmark coordinates are fractions of the DPI-scaled square.
      IntOp $6 $R1 * 3
      IntOp $6 $6 / 16
      IntOp $6 $6 + $5
      IntOp $7 $R1 / 2
      IntOp $7 $7 + $R3
      IntOp $8 $R1 * 7
      IntOp $8 $8 / 16
      IntOp $8 $8 + $5
      IntOp $R4 $R1 * 11
      IntOp $R4 $R4 / 16
      IntOp $R4 $R4 + $R3
      System::Call 'gdiplus::GdipDrawLineI(p r1, p r3, i r6, i r7, i r8, i R4)'
      IntOp $6 $R1 * 13
      IntOp $6 $6 / 16
      IntOp $6 $6 + $5
      IntOp $7 $R1 * 5
      IntOp $7 $7 / 16
      IntOp $7 $7 + $R3
      System::Call 'gdiplus::GdipDrawLineI(p r1, p r3, i r8, i R4, i r6, i r7)'
    ${else}
      IntOp $R0 $R0 / 2
      !insertmacro yabStrokeBits $R0 $R9
      System::Call 'gdiplus::GdipCreatePen1(i R7, i R9, i 0, *p.r3)'
      System::Call 'gdiplus::GdipDrawPath(p r1, p r3, p r2)'
    ${endif}
    System::Call 'gdiplus::GdipDeletePen(p r3)'
    System::Call 'gdiplus::GdipDeletePath(p r2)'
    System::Call 'gdiplus::GdipDeleteGraphics(p r1)'
    System::Call 'user32::GetWindowTextW(p r0, w.r1, i ${NSIS_MAX_STRLEN})'
    SendMessage $0 ${WM_GETFONT} 0 0 $2
    System::Call 'gdi32::SelectObject(p r4, p r2) p.r3'
    System::Call 'gdi32::SetBkMode(p r4, i 1)'
    System::Call 'gdi32::SetTextColor(p r4, i R5)'
    IntOp $5 $5 + $R1
    IntOp $5 $5 + $R2
    System::Call 'user32::GetClientRect(p r0, @r2)'
    System::Call '*$2(i r5)'
    System::Call 'user32::DrawTextW(p r4, w r1, i -1, p r2, i 0x824)'
    System::Call 'gdi32::SelectObject(p r4, p r3)'
    IntOp $9 $9 & 0x10 ; CDIS_FOCUS
    ${if} $9 != 0
      SendMessage $0 0x129 0 0 $1 ; WM_QUERYUISTATE
      IntOp $1 $1 & 1 ; UISF_HIDEFOCUS
      ${if} $1 = 0
        System::Call 'user32::DrawFocusRect(p r4, p r2)'
      ${endif}
    ${endif}
    System::Call 'gdi32::RestoreDC(p r4, i -1)'
    System::Store L
    ${NSD_Return} 4 ; CDRF_SKIPDEFAULT
  FunctionEnd
!macroend

!macro yabStyleCheckbox CONTROL PREFIX
  ${if} $yabHighContrast = 0
  ${andIf} $yabGdiToken P<> 0
    ; A themed native button emits NM_CUSTOMDRAW; the callback paints its text
    ; as well as its glyph, avoiding the theme's black text in dark mode.
    System::Call 'uxtheme::SetWindowTheme(p ${CONTROL}, w "Explorer", p 0)'
    ${NSD_OnNotify} ${CONTROL} ${PREFIX}yabDrawCheckbox
  ${endif}
!macroend
