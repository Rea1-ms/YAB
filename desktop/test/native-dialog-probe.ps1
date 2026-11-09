param([int]$PreviewProcessId, [string]$Executable, [string]$ReportPath, [string]$Kind = 'message')
$ErrorActionPreference = 'Stop'
# Inspect only the explicitly launched, isolated preview. Never search by the
# product name or send input to another installer or a running application.
$preview = Get-Process -Id $PreviewProcessId
if ($preview.Path -ne $Executable) { throw 'The preview process does not match the requested executable.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class YabPopupSample {
    public string Prompt { get; set; }
    public uint Thread { get; set; }
    public bool Themed { get; set; }
    public int Body { get; set; }
    public int Footer { get; set; }
    public int Button { get; set; }
    public int ButtonId { get; set; }
}
public static class YabDialogProbe {
    delegate bool EnumCallback(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window, EnumCallback callback, IntPtr state);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetProp(IntPtr window, string name);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern int GetPixel(IntPtr dc, int x, int y);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr bitmap);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr bitmap);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr window, IntPtr area, IntPtr region, uint flags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    struct Rect { public int Left, Top, Right, Bottom; }
    static int Pixel(IntPtr window, int x, int y) {
        IntPtr dc = GetDC(window);
        try { return GetPixel(dc, x, y); } finally { ReleaseDC(window, dc); }
    }
    static int[] RenderedPixels(IntPtr window, Rect rect) {
        IntPtr source = GetDC(window), dc = CreateCompatibleDC(source);
        IntPtr bitmap = CreateCompatibleBitmap(source, rect.Right, rect.Bottom);
        IntPtr original = SelectObject(dc, bitmap);
        try {
            if (!PrintWindow(window, dc, 3)) return new int[] { -1, -1 };
            return new int[] { GetPixel(dc, 5, 5), GetPixel(dc, 5, rect.Bottom - 5) };
        } finally {
            SelectObject(dc, original); DeleteObject(bitmap); DeleteDC(dc); ReleaseDC(window, source);
        }
    }
    public static List<YabPopupSample> Run(int process, string kind) {
        var samples = new List<YabPopupSample>();
        var handled = new HashSet<string>();
        var watch = Stopwatch.StartNew();
        var visible = new List<string>();
        while (watch.ElapsedMilliseconds < 25000) {
            try { if (Process.GetProcessById(process).HasExited) return samples; }
            catch (ArgumentException) { return samples; }
            EnumWindows((window, state) => {
                uint owner; uint thread = GetWindowThreadProcessId(window, out owner);
                if (owner != process) return true;
                var text = new StringBuilder(1024);
                GetWindowText(kind == "message" ? GetDlgItem(window, 65535) : window, text, text.Capacity);
                string prompt = text.ToString();
                if (!visible.Contains(prompt)) visible.Add(prompt);
                if (!prompt.StartsWith("YAB-PREVIEW:") || handled.Contains(prompt)) return true;
                int step = int.Parse(prompt.Substring(prompt.LastIndexOf(':') + 1));
                int id = prompt.Contains(":init:") ? 2 : new int[] { 4, 2, 1, 2, 2 }[step - 1];
                if (kind == "folder") id = step == 1 ? 1 : 2;
                IntPtr button = GetDlgItem(window, id);
                if (kind != "message") EnumChildWindows(window, (child, ignored) => {
                    var type = new StringBuilder(100);
                    var caption = new StringBuilder(100);
                    GetClassName(child, type, type.Capacity);
                    GetWindowText(child, caption, caption.Capacity);
                    string description = type + ":" + GetDlgCtrlID(child) + ":" + caption;
                    if (!visible.Contains(description)) visible.Add(description);
                    if (type.ToString() == "Button") {
                        if (kind == "folder" && GetDlgCtrlID(child) == id) button = child;
                        if (kind == "shell" && caption.ToString().Contains(prompt.Contains(":file:") ? "取消" : "确定")) button = child;
                    }
                    return true;
                }, IntPtr.Zero);
                if (button == IntPtr.Zero) return true;
                RedrawWindow(window, IntPtr.Zero, IntPtr.Zero, 0x185);
                Thread.Sleep(160);
                Rect rect; GetClientRect(window, out rect);
                int body = Pixel(window, 5, 5), footer = Pixel(window, 5, rect.Bottom - 5);
                if (kind != "message") {
                    int[] rendered = RenderedPixels(window, rect);
                    body = rendered[0]; footer = rendered[1];
                }
                if (body == -1 || footer == -1) return true;
                samples.Add(new YabPopupSample { Prompt = prompt, Thread = thread,
                    Themed = GetProp(window, "YAB.MessageBox") != IntPtr.Zero,
                    Body = body, Footer = footer, Button = Pixel(button, 8, 7), ButtonId = GetDlgCtrlID(button) });
                handled.Add(prompt);
                PostMessage(button, 0xF5, IntPtr.Zero, IntPtr.Zero);
                return true;
            }, IntPtr.Zero);
            Thread.Sleep(25);
        }
        throw new TimeoutException("The isolated preview did not complete its message boxes. Seen: " + string.Join(" | ", visible)
            + "; handled: " + string.Join(" | ", handled));
    }
}
'@
[YabDialogProbe]::Run($PreviewProcessId, $Kind) | ConvertTo-Json -Depth 3 -AsArray | Set-Content -LiteralPath $ReportPath -Encoding utf8
