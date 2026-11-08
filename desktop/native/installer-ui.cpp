// Native NSIS control and message-box painting. Windows retains all input,
// focus, radio-group, default-button and accessibility behavior.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <uxtheme.h>
#include <dwmapi.h>
#include <richedit.h>
#include <gdiplus.h>
#include <shlwapi.h>
#include <string>
#include "checkbox-assets.h"

using namespace Gdiplus;

struct StackEntry { StackEntry* next; wchar_t text[1]; };
static bool dark = false, highContrast = false;
static ULONG_PTR graphicsToken = 0;
static HWND statusLabel = nullptr, progressBar = nullptr, totalProgressBar = nullptr;
static std::wstring progressText;
static int progressStart = 0, progressEnd = 99, progressPercent = 0;
static HBRUSH statusBrush = nullptr;
static HWND wizardWindow = nullptr;
static HHOOK messageBoxHook = nullptr;
static constexpr UINT_PTR subclassId = 0x594142;
static Bitmap* checkboxImages[3][checkboxSizeCount] = {};

static Bitmap* CheckboxImage(int state, int size) {
    int index = 0;
    while (index + 1 < checkboxSizeCount && checkboxSizes[index] < size) ++index;
    auto*& cached = checkboxImages[state][index];
    if (cached) return cached;
    HMODULE module = nullptr;
    if (!GetModuleHandleEx(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&CheckboxImage), &module)) return nullptr;
    const HRSRC resource = FindResource(module, MAKEINTRESOURCE(checkboxResourceIds[state][index]), RT_RCDATA);
    if (!resource) return nullptr;
    const DWORD length = SizeofResource(module, resource);
    const auto* bytes = static_cast<const BYTE*>(LockResource(LoadResource(module, resource)));
    if (!bytes || !length) return nullptr;
    IStream* stream = SHCreateMemStream(bytes, length);
    if (!stream) return nullptr;
    {
        Bitmap image(stream);
        if (image.GetLastStatus() == Ok) {
            cached = image.Clone(0, 0, image.GetWidth(), image.GetHeight(), PixelFormat32bppARGB);
        }
    }
    stream->Release();
    return cached;
}

struct RichStream { const char* text; size_t length; size_t position; };
static DWORD CALLBACK ReadRichText(DWORD_PTR cookie, LPBYTE buffer, LONG count, LONG* read) {
    auto* stream = reinterpret_cast<RichStream*>(cookie);
    const size_t remaining = stream->length - stream->position;
    const size_t size = remaining < static_cast<size_t>(count) ? remaining : static_cast<size_t>(count);
    memcpy(buffer, stream->text + stream->position, size);
    stream->position += size;
    *read = static_cast<LONG>(size);
    return 0;
}

static void FormatLicense(HWND window) {
    if (GetProp(window, L"YAB.License")) return;
    std::wstring original(static_cast<size_t>(GetWindowTextLength(window)) + 1, L'\0');
    original.resize(static_cast<size_t>(GetWindowText(window, &original[0], static_cast<int>(original.size()))));
    const COLORREF text = highContrast ? GetSysColor(COLOR_WINDOWTEXT) : dark ? RGB(240, 240, 240) : RGB(32, 32, 32);
    std::string rtf = "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Microsoft YaHei UI;}}"
        "{\\colortbl;\\red" + std::to_string(GetRValue(text)) + "\\green" + std::to_string(GetGValue(text))
        + "\\blue" + std::to_string(GetBValue(text)) + ";}\\cf1\\f0\\fs18 ";
    std::wstring paragraph;
    auto flush = [&]() {
        if (paragraph.empty()) return;
        rtf += "\\pard\\ql\\li120\\ri120\\sa140 ";
        for (wchar_t character : paragraph) {
            if (character == L'\\' || character == L'{' || character == L'}') rtf += '\\';
            if (character < 128) rtf += static_cast<char>(character);
            else rtf += "\\u" + std::to_string(static_cast<short>(character)) + "?";
        }
        rtf += "\\par\n";
        paragraph.clear();
    };
    size_t offset = 0;
    while (offset < original.size()) {
        const size_t end = original.find(L'\n', offset);
        std::wstring line = original.substr(offset, end == std::wstring::npos ? end : end - offset);
        offset = end == std::wstring::npos ? original.size() : end + 1;
        const size_t first = line.find_first_not_of(L" \t\r");
        if (first == std::wstring::npos) { flush(); continue; }
        line = line.substr(first, line.find_last_not_of(L" \t\r") - first + 1);
        if (first > 6) {
            flush();
            rtf += "\\pard\\qc\\b\\sa140 ";
            for (wchar_t character : line) rtf += static_cast<char>(character);
            rtf += "\\b0\\par\n";
        } else {
            if (!paragraph.empty()) paragraph += L' ';
            paragraph += line;
        }
    }
    flush();
    rtf += '}';
    RichStream source = {rtf.data(), rtf.size(), 0};
    EDITSTREAM stream = {reinterpret_cast<DWORD_PTR>(&source), 0, ReadRichText};
    SendMessage(window, EM_STREAMIN, SF_RTF, reinterpret_cast<LPARAM>(&stream));
    SendMessage(window, EM_SETTARGETDEVICE, 0, 0);
    SendMessage(window, EM_SETSEL, 0, 0);
    SendMessage(window, WM_VSCROLL, SB_TOP, 0);
    SetProp(window, L"YAB.License", reinterpret_cast<HANDLE>(1));
}

static std::wstring Pop(StackEntry** stack) {
    if (!*stack) return {};
    auto* entry = *stack;
    std::wstring value(entry->text);
    *stack = entry->next;
    GlobalFree(entry);
    return value;
}

static int Scale(HWND window, int value) {
    return MulDiv(value, static_cast<int>(GetDpiForWindow(window)), 96);
}

static void LayoutShieldButton(HWND window) {
    if (GetDlgCtrlID(window) != IDOK) return;
    const HWND parent = GetParent(window);
    RECT rect;
    GetWindowRect(window, &rect);
    MapWindowPoints(nullptr, parent, reinterpret_cast<POINT*>(&rect), 2);
    const int previous = static_cast<int>(reinterpret_cast<INT_PTR>(GetProp(window, L"YAB.ShieldExpansion")));
    const int baseWidth = rect.right - rect.left - previous;
    int expansion = 0;
    if (GetProp(window, L"YAB.Shield")) {
        wchar_t title[1024] = {};
        GetWindowText(window, title, 1024);
        const HDC dc = GetDC(window);
        const auto font = reinterpret_cast<HFONT>(SendMessage(window, WM_GETFONT, 0, 0));
        const auto original = SelectObject(dc, font);
        RECT extent = {};
        DrawText(dc, title, -1, &extent, DT_SINGLELINE | DT_CALCRECT);
        SelectObject(dc, original);
        ReleaseDC(window, dc);
        const int required = extent.right + Scale(window, 16) + Scale(window, 5) + 2 * Scale(window, 6);
        if (required > baseWidth) expansion = required - baseWidth;
    }
    const int change = expansion - previous;
    if (!change) return;
    if (expansion) SetProp(window, L"YAB.ShieldExpansion", reinterpret_cast<HANDLE>(static_cast<INT_PTR>(expansion)));
    else RemoveProp(window, L"YAB.ShieldExpansion");
    // Keep the right edge and Cancel fixed, moving Back by the same amount.
    // Restore both controls as soon as the next action no longer elevates.
    SetWindowPos(window, nullptr, rect.left - change, rect.top, baseWidth + expansion,
        rect.bottom - rect.top, SWP_NOZORDER | SWP_NOACTIVATE);
    const HWND back = GetDlgItem(parent, 3);
    if (back) {
        GetWindowRect(back, &rect);
        MapWindowPoints(nullptr, parent, reinterpret_cast<POINT*>(&rect), 2);
        SetWindowPos(back, nullptr, rect.left - change, rect.top, 0, 0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

static void Rounded(Graphics& graphics, const RectF& rect, float radius, Color fill, Color border) {
    GraphicsPath path;
    const float arc = radius * 2;
    path.AddArc(rect.X, rect.Y, arc, arc, 180, 90);
    path.AddArc(rect.GetRight() - arc, rect.Y, arc, arc, 270, 90);
    path.AddArc(rect.GetRight() - arc, rect.GetBottom() - arc, arc, arc, 0, 90);
    path.AddArc(rect.X, rect.GetBottom() - arc, arc, arc, 90, 90);
    path.CloseFigure();
    SolidBrush brush(fill);
    graphics.FillPath(&brush, &path);
    if (border.GetAlpha()) {
        Pen pen(border, 1.0f);
        graphics.DrawPath(&pen, &path);
    }
}

static bool DrawButton(HWND window, NMCUSTOMDRAW* draw) {
    const auto style = GetWindowLongPtr(window, GWL_STYLE) & BS_TYPEMASK;
    const bool radio = style == BS_RADIOBUTTON || style == BS_AUTORADIOBUTTON;
    const bool choice = radio || style == BS_CHECKBOX || style == BS_AUTOCHECKBOX
        || style == BS_3STATE || style == BS_AUTO3STATE;
    const bool enabled = IsWindowEnabled(window) != FALSE;
    const auto buttonState = SendMessage(window, BM_GETSTATE, 0, 0);
    const bool hot = (draw->uItemState & CDIS_HOT) != 0 || (buttonState & BST_HOT) != 0;
    const bool pressed = (draw->uItemState & CDIS_SELECTED) != 0 || (buttonState & BST_PUSHED) != 0;
    const auto checkState = SendMessage(window, BM_GETCHECK, 0, 0);
    const bool checked = checkState != BST_UNCHECKED;
    Bitmap* checkbox = choice && !radio
        ? CheckboxImage(checkState == BST_INDETERMINATE ? 2 : checked ? 1 : 0, Scale(window, 16)) : nullptr;
    // Missing resources use the complete native button drawing, including text.
    if (choice && !radio && !checkbox) return false;
    const int saved = SaveDC(draw->hdc);
    const bool primary = !choice && (style == BS_DEFPUSHBUTTON || GetDlgCtrlID(window) == IDOK);
    RECT rect = draw->rc;
    const COLORREF canvas = dark ? RGB(32, 32, 32) : GetSysColor(COLOR_BTNFACE);
    SetDCBrushColor(draw->hdc, canvas);
    FillRect(draw->hdc, &rect, static_cast<HBRUSH>(GetStockObject(DC_BRUSH)));
    const Color accent = dark ? Color(255, 96, 205, 255) : Color(255, 0, 120, 212);
    COLORREF text = dark ? RGB(240, 240, 240) : RGB(32, 32, 32);
    {
        Graphics graphics(draw->hdc);
        graphics.SetSmoothingMode(SmoothingModeAntiAlias);
        if (choice) {
            const int size = Scale(window, 16);
            const int top = rect.top + (rect.bottom - rect.top - size) / 2;
            const RectF box(static_cast<float>(rect.left) + 1, static_cast<float>(top) + 1,
                static_cast<float>(size) - 2, static_cast<float>(size) - 2);
            const Color border = dark ? Color(255, 170, 170, 170) : Color(255, 119, 119, 119);
            const Color fill = checked ? accent : Color(dark ? 0xFF303030 : 0xFFFFFFFF);
            if (radio) {
                SolidBrush brush(fill);
                graphics.FillEllipse(&brush, box);
                Pen pen(checked ? accent : border, 1.0f);
                graphics.DrawEllipse(&pen, box);
                if (checked) {
                    SolidBrush dot(dark ? Color(255, 16, 32, 42) : Color(255, 255, 255, 255));
                    const float inset = static_cast<float>(Scale(window, 5));
                    graphics.FillEllipse(&dot, box.X + inset, box.Y + inset,
                        box.Width - inset * 2, box.Height - inset * 2);
                }
            } else {
                Color color = checked ? accent : border;
                if (!enabled) color = dark ? Color(255, 100, 100, 100) : Color(255, 160, 160, 160);
                else if (checked && pressed) color = dark ? Color(255, 72, 170, 215) : Color(255, 0, 86, 158);
                else if (checked && hot) color = dark ? Color(255, 120, 215, 255) : Color(255, 0, 105, 190);
                else if (pressed) color = dark ? Color(255, 200, 200, 200) : Color(255, 40, 40, 40);
                else if (hot) color = dark ? Color(255, 230, 230, 230) : Color(255, 70, 70, 70);
                // The saved PNGs contain the upstream alpha silhouette only.
                // Tint it without changing the native checkbox's input/state.
                ColorMatrix matrix = {{{0, 0, 0, 0, 0}, {0, 0, 0, 0, 0}, {0, 0, 0, 0, 0},
                    {0, 0, 0, 1, 0}, {color.GetR() / 255.0f, color.GetG() / 255.0f, color.GetB() / 255.0f, 0, 1}}};
                ImageAttributes attributes;
                attributes.SetColorMatrix(&matrix);
                graphics.SetInterpolationMode(InterpolationModeHighQualityBicubic);
                graphics.SetPixelOffsetMode(PixelOffsetModeHalf);
                graphics.DrawImage(checkbox, Rect(rect.left, top, size, size), 0, 0,
                    checkbox->GetWidth(), checkbox->GetHeight(), UnitPixel, &attributes);
            }
            rect.left += size + Scale(window, 6);
        } else {
            Color fill = dark ? Color(255, 51, 51, 51) : Color(255, 255, 255, 255);
            Color border = dark ? Color(255, 85, 85, 85) : Color(255, 190, 190, 190);
            if (primary && enabled) {
                fill = accent;
                text = dark ? RGB(16, 32, 42) : RGB(255, 255, 255);
            } else if (hot && enabled) {
                fill = dark ? Color(255, 63, 63, 63) : Color(255, 245, 245, 245);
            }
            if (pressed && enabled) fill = dark ? Color(255, 70, 115, 135) : Color(255, 220, 235, 245);
            if (!enabled) fill = dark ? Color(255, 42, 42, 42) : Color(255, 235, 235, 235);
            Rounded(graphics, RectF(0.5f, 0.5f, static_cast<float>(rect.right - rect.left) - 1,
                static_cast<float>(rect.bottom - rect.top) - 1), static_cast<float>(Scale(window, 4)), fill, border);
        }
    }
    if (!enabled) text = dark ? RGB(135, 135, 135) : GetSysColor(COLOR_GRAYTEXT);
    const auto font = reinterpret_cast<HFONT>(SendMessage(window, WM_GETFONT, 0, 0));
    SelectObject(draw->hdc, font);
    SetBkMode(draw->hdc, TRANSPARENT);
    SetTextColor(draw->hdc, text);
    wchar_t title[1024] = {};
    GetWindowText(window, title, 1024);
    RECT textRect = rect;
    UINT flags = DT_SINGLELINE | DT_VCENTER | (choice ? DT_LEFT : DT_CENTER);
    if (SendMessage(window, WM_QUERYUISTATE, 0, 0) & UISF_HIDEACCEL) flags |= DT_HIDEPREFIX;
    if (!choice && GetProp(window, L"YAB.Shield")) {
        SHSTOCKICONINFO icon = {sizeof(icon)};
        if (SUCCEEDED(SHGetStockIconInfo(SIID_SHIELD, SHGSI_ICON | SHGSI_SMALLICON, &icon))) {
            const int size = Scale(window, 16);
            // Measure with the same accelerator-prefix handling as DrawText.
            // Center the complete icon/caption group, then draw the caption
            // immediately after the icon instead of re-centering it again.
            RECT extent = {};
            DrawText(draw->hdc, title, -1, &extent, flags | DT_CALCRECT);
            const int gap = Scale(window, 5);
            const int x = rect.left + (rect.right - rect.left - extent.right - size - gap) / 2;
            const int y = rect.top + (rect.bottom - rect.top - size) / 2;
            DrawIconEx(draw->hdc, x, y, icon.hIcon, size, size, 0, nullptr, DI_NORMAL);
            DestroyIcon(icon.hIcon);
            textRect.left = x + size + gap;
            textRect.right = textRect.left + extent.right;
            flags = (flags & ~DT_CENTER) | DT_LEFT;
        }
    }
    DrawText(draw->hdc, title, -1, &textRect, flags);
    if ((draw->uItemState & CDIS_FOCUS) && !(SendMessage(window, WM_QUERYUISTATE, 0, 0) & UISF_HIDEFOCUS)) {
        InflateRect(&rect, -Scale(window, 3), -Scale(window, 3));
        DrawFocusRect(draw->hdc, &rect);
    }
    RestoreDC(draw->hdc, saved);
    return true;
}

static void UpdateProgress(bool sample = true) {
    if (!IsWindow(statusLabel) || !IsWindow(progressBar)) return;
    if (sample) {
        PBRANGE range = {};
        SendMessage(progressBar, PBM_GETRANGE, FALSE, reinterpret_cast<LPARAM>(&range));
        const int position = static_cast<int>(SendMessage(progressBar, PBM_GETPOS, 0, 0));
        const int local = range.iHigh > range.iLow
            ? MulDiv(position - range.iLow, 100, range.iHigh - range.iLow) : 0;
        const int bounded = local < 0 ? 0 : local > 100 ? 100 : local;
        const int mapped = progressStart + bounded * (progressEnd - progressStart) / 100;
        if (mapped > progressPercent) progressPercent = mapped;
    }
    // Keep NSIS and Nsis7z's original range/position intact. They share a raw
    // progress control and may restore older values when extraction finishes.
    ShowWindow(progressBar, SW_HIDE);
    SendMessage(totalProgressBar, PBM_SETPOS, progressPercent, 0);
    const auto text = progressText + L"  " + std::to_wstring(progressPercent) + L"%";
    SetWindowText(statusLabel, text.c_str());
    ShowWindow(statusLabel, SW_SHOWNA);
    InvalidateRect(statusLabel, nullptr, TRUE);
    UpdateWindow(statusLabel);
}

static LRESULT CALLBACK ControlProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam, UINT_PTR, DWORD_PTR) {
    if (message == BCM_SETSHIELD) {
        if (lparam) SetProp(window, L"YAB.Shield", reinterpret_cast<HANDLE>(1));
        else RemoveProp(window, L"YAB.Shield");
    }
    const LRESULT result = DefSubclassProc(window, message, wparam, lparam);
    if (message == BCM_SETSHIELD || (message == WM_SETTEXT && GetProp(window, L"YAB.Shield"))) {
        LayoutShieldButton(window);
    }
    if (window == progressBar && (message == PBM_SETPOS || message == PBM_DELTAPOS || message == PBM_STEPIT)) UpdateProgress();
    // A new range may temporarily contain the previous writer's position.
    // Wait for its first position update before mapping the next stage.
    if (message == WM_NCDESTROY) {
        RemoveProp(window, L"YAB.Shield");
        RemoveProp(window, L"YAB.ShieldExpansion");
        RemoveWindowSubclass(window, ControlProc, subclassId);
        if (window == progressBar) { progressBar = nullptr; totalProgressBar = nullptr; statusLabel = nullptr; }
    }
    return result;
}

static LRESULT CALLBACK DialogProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam, UINT_PTR, DWORD_PTR) {
    // Keep the real MessageBox layout, text, buttons and return values. Only
    // paint its surface; system message boxes do not inherit the wizard theme.
    if (GetProp(window, L"YAB.MessageBox") && dark && !highContrast) {
        if (message == WM_ERASEBKGND) {
            RECT rect;
            GetClientRect(window, &rect);
            FillRect(reinterpret_cast<HDC>(wparam), &rect, statusBrush);
            return TRUE;
        }
        if (message == WM_PAINT) {
            PAINTSTRUCT paint;
            const HDC dc = BeginPaint(window, &paint);
            FillRect(dc, &paint.rcPaint, statusBrush);
            EndPaint(window, &paint);
            return 0;
        }
        if (message == WM_CTLCOLORDLG || message == WM_CTLCOLORSTATIC || message == WM_CTLCOLORBTN) {
            const HDC dc = reinterpret_cast<HDC>(wparam);
            SetTextColor(dc, RGB(240, 240, 240));
            SetBkColor(dc, RGB(32, 32, 32));
            return reinterpret_cast<LRESULT>(statusBrush);
        }
    }
    if (message == WM_NOTIFY && !highContrast && graphicsToken) {
        auto* draw = reinterpret_cast<NMCUSTOMDRAW*>(lparam);
        wchar_t type[32] = {};
        GetClassName(draw->hdr.hwndFrom, type, 32);
        if (draw->hdr.code == NM_CUSTOMDRAW && draw->dwDrawStage == CDDS_PREPAINT && lstrcmp(type, L"Button") == 0) {
            const auto style = GetWindowLongPtr(draw->hdr.hwndFrom, GWL_STYLE) & BS_TYPEMASK;
            if (style != BS_GROUPBOX && style != BS_OWNERDRAW) {
                if (DrawButton(draw->hdr.hwndFrom, draw)) return CDRF_SKIPDEFAULT;
            }
        }
    }
    if (message == WM_CTLCOLORSTATIC && reinterpret_cast<HWND>(lparam) == statusLabel && !highContrast) {
        SetTextColor(reinterpret_cast<HDC>(wparam), dark ? RGB(240, 240, 240) : RGB(32, 32, 32));
        SetBkColor(reinterpret_cast<HDC>(wparam), dark ? RGB(32, 32, 32) : GetSysColor(COLOR_BTNFACE));
        return reinterpret_cast<LRESULT>(statusBrush);
    }
    if (message == WM_NCDESTROY) {
        RemoveProp(window, L"YAB.MessageBox");
        RemoveWindowSubclass(window, DialogProc, subclassId);
        if (window == wizardWindow) {
            if (messageBoxHook) UnhookWindowsHookEx(messageBoxHook);
            messageBoxHook = nullptr;
            wizardWindow = nullptr;
        }
    }
    return DefSubclassProc(window, message, wparam, lparam);
}

static BOOL CALLBACK AttachControl(HWND window, LPARAM) {
    wchar_t type[32] = {};
    GetClassName(window, type, 32);
    if (lstrcmp(type, L"#32770") == 0) SetWindowSubclass(window, DialogProc, subclassId, 0);
    if (lstrcmp(type, L"Button") == 0 && !highContrast && graphicsToken) {
        const auto style = GetWindowLongPtr(window, GWL_STYLE) & BS_TYPEMASK;
        if (style != BS_GROUPBOX && style != BS_OWNERDRAW) {
            SetWindowSubclass(window, ControlProc, subclassId, 0);
            // Keep group boxes' disabled theme and existing owner-draw controls.
            // Custom drawing retains native button input and accessibility.
            SetWindowTheme(window, L"Explorer", nullptr);
        }
    }
    if (lstrcmpi(type, L"RichEdit20W") == 0 || lstrcmpi(type, L"RichEdit20A") == 0
        || lstrcmpi(type, L"RICHEDIT50W") == 0) FormatLicense(window);
    return TRUE;
}

static LRESULT CALLBACK ThemeMessageBox(int code, WPARAM wparam, LPARAM lparam) {
    if (code == HCBT_ACTIVATE && dark && !highContrast) {
        const HWND window = reinterpret_cast<HWND>(wparam);
        wchar_t type[32] = {};
        GetClassName(window, type, 32);
        // Limit this thread-local hook to our own native Yes/No dialogs.
        // UAC and other applications' windows are never affected.
        if (lstrcmp(type, L"#32770") == 0 && GetWindow(window, GW_OWNER) == wizardWindow
            && GetDlgItem(window, IDYES) && GetDlgItem(window, IDNO)) {
            SetProp(window, L"YAB.MessageBox", reinterpret_cast<HANDLE>(1));
            SetWindowSubclass(window, DialogProc, subclassId, 0);
            EnumChildWindows(window, AttachControl, 0);
            const BOOL enabled = TRUE;
            if (FAILED(DwmSetWindowAttribute(window, 20, &enabled, sizeof(enabled)))) {
                DwmSetWindowAttribute(window, 19, &enabled, sizeof(enabled));
            }
            RedrawWindow(window, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN);
        }
    }
    return CallNextHookEx(messageBoxHook, code, wparam, lparam);
}

extern "C" __declspec(dllexport) void Apply(HWND parent, int, wchar_t*, StackEntry** stack, void*) {
    dark = Pop(stack) == L"1";
    highContrast = Pop(stack) != L"0";
    if (!graphicsToken && !highContrast) {
        GdiplusStartupInput input;
        GdiplusStartup(&graphicsToken, &input, nullptr);
    }
    if (!statusBrush) statusBrush = CreateSolidBrush(dark ? RGB(32, 32, 32) : GetSysColor(COLOR_BTNFACE));
    wizardWindow = parent;
    if (!messageBoxHook) messageBoxHook = SetWindowsHookEx(WH_CBT, ThemeMessageBox, nullptr, GetCurrentThreadId());
    SetWindowSubclass(parent, DialogProc, subclassId, 0);
    EnumChildWindows(parent, AttachControl, 0);
    // MUI draws a second, offset branding label as an embossed shadow. Giving
    // both layers the same foreground produces the blurry text in dark mode.
    ShowWindow(GetDlgItem(parent, 1028), SW_HIDE);
    ShowWindow(GetDlgItem(parent, 1034), SW_HIDE);
    const HWND brand = GetDlgItem(parent, 1256);
    SendMessage(brand, WM_SETFONT, SendMessage(parent, WM_GETFONT, 0, 0), TRUE);
    RedrawWindow(parent, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN);
}

extern "C" __declspec(dllexport) void Progress(HWND parent, int, wchar_t*, StackEntry** stack, void*) {
    progressText = Pop(stack);
    progressStart = progressPercent = 0;
    progressEnd = 99;
    const HWND page = FindWindowEx(parent, nullptr, L"#32770", nullptr);
    progressBar = GetDlgItem(page, 1004);
    const HWND original = GetDlgItem(page, 1006);
    if (!progressBar || !original) return;
    RECT rect;
    GetWindowRect(original, &rect);
    MapWindowPoints(nullptr, page, reinterpret_cast<POINT*>(&rect), 2);
    // A separate label cannot be blanked by SetDetailsPrint none, which the
    // builder runs again after page callbacks and skips restoring after UAC.
    ShowWindow(original, SW_HIDE);
    statusLabel = CreateWindowEx(0, L"STATIC", L"", WS_CHILD | WS_VISIBLE | SS_ENDELLIPSIS,
        rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top,
        page, reinterpret_cast<HMENU>(0x7F10), nullptr, nullptr);
    SendMessage(statusLabel, WM_SETFONT, SendMessage(original, WM_GETFONT, 0, 0), TRUE);
    GetWindowRect(progressBar, &rect);
    MapWindowPoints(nullptr, page, reinterpret_cast<POINT*>(&rect), 2);
    totalProgressBar = CreateWindowEx(0, PROGRESS_CLASS, L"", WS_CHILD | WS_VISIBLE | PBS_SMOOTH,
        rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top,
        page, reinterpret_cast<HMENU>(0x7F11), nullptr, nullptr);
    SendMessage(totalProgressBar, PBM_SETRANGE32, 0, 100);
    if (dark && !highContrast) {
        SetWindowTheme(totalProgressBar, L" ", L" ");
        SendMessage(totalProgressBar, PBM_SETBKCOLOR, 0, RGB(48, 48, 48));
        SendMessage(totalProgressBar, PBM_SETBARCOLOR, 0, RGB(80, 160, 224));
    }
    SetWindowSubclass(progressBar, ControlProc, subclassId, 0);
    SetWindowSubclass(page, DialogProc, subclassId, 0);
    UpdateProgress(false);
}

extern "C" __declspec(dllexport) void Stage(HWND, int, wchar_t*, StackEntry** stack, void*) {
    progressText = Pop(stack);
    UpdateProgress(false);
}

extern "C" __declspec(dllexport) void Phase(HWND, int, wchar_t*, StackEntry** stack, void*) {
    progressText = Pop(stack);
    const int start = _wtoi(Pop(stack).c_str());
    const int end = _wtoi(Pop(stack).c_str());
    // Retrying a copy must not restart its interval or move progress backwards.
    if (start >= progressStart && start <= end && end < 100) {
        progressStart = start;
        progressEnd = end;
        if (start > progressPercent) progressPercent = start;
    }
    UpdateProgress(false);
}

extern "C" __declspec(dllexport) void Complete(HWND, int, wchar_t*, StackEntry** stack, void*) {
    progressText = Pop(stack);
    progressPercent = 100;
    UpdateProgress(false);
}
