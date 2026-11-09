param([int]$PreviewProcessId, [string]$Executable, [string]$ReportPath)
$ErrorActionPreference = 'Stop'
# Only move the isolated preview supplied by the test; never change display settings.
$preview = Get-Process -Id $PreviewProcessId
if ($preview.Path -ne $Executable) { throw 'The preview executable does not match its process.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class YabDpiSample {
    public string Page { get; set; }
    public int Monitor { get; set; }
    public uint Dpi { get; set; }
    public bool PerMonitorV2 { get; set; }
    public int[] Window { get; set; }
    public int[] Next { get; set; }
    public int[] Sidebar { get; set; }
    public int[] Status { get; set; }
    public int[] OriginalStatus { get; set; }
    public int[] Progress { get; set; }
    public int[] OriginalProgress { get; set; }
    public int Percent { get; set; }
}
public static class YabDpiProbe {
    delegate bool WindowCallback(IntPtr window, IntPtr state);
    delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref Rect area, IntPtr state);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window, WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr state);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr left, IntPtr right);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, byte[] info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    static void Capture(IntPtr window, string filename) {
        var size = Bounds(window, IntPtr.Zero);
        int length = checked(size[2] * size[3] * 4);
        var info = new byte[40];
        Array.Copy(BitConverter.GetBytes(40), 0, info, 0, 4);
        Array.Copy(BitConverter.GetBytes(size[2]), 0, info, 4, 4);
        Array.Copy(BitConverter.GetBytes(-size[3]), 0, info, 8, 4);
        info[12] = 1; info[14] = 32;
        IntPtr source = GetDC(window), dc = CreateCompatibleDC(source), bits;
        IntPtr image = CreateDIBSection(source, info, 0, out bits, IntPtr.Zero, 0);
        IntPtr previous = SelectObject(dc, image);
        try {
            if (image == IntPtr.Zero || !PrintWindow(window, dc, 2)) throw new InvalidOperationException("Cannot render DPI preview.");
            var pixels = new byte[length]; Marshal.Copy(bits, pixels, 0, length);
            using (var writer = new System.IO.BinaryWriter(System.IO.File.Open(filename, System.IO.FileMode.Create))) {
                writer.Write((ushort)0x4D42); writer.Write(length + 54); writer.Write(0); writer.Write(54);
                writer.Write(info); writer.Write(pixels);
            }
        } finally {
            SelectObject(dc, previous); DeleteObject(image); DeleteDC(dc); ReleaseDC(window, source);
        }
    }
    static string Title(IntPtr window) {
        var text = new StringBuilder(256); GetWindowText(window, text, text.Capacity); return text.ToString();
    }
    static IntPtr Find(int process, string title) {
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 10000) {
            IntPtr found = IntPtr.Zero;
            EnumWindows((window, state) => {
                uint owner; GetWindowThreadProcessId(window, out owner);
                if (owner == process && Title(window) == title) found = window;
                return true;
            }, IntPtr.Zero);
            if (found != IntPtr.Zero) { Thread.Sleep(160); return found; }
            Thread.Sleep(25);
        }
        throw new TimeoutException("The isolated DPI preview did not reach " + title);
    }
    static int[] Bounds(IntPtr window, IntPtr parent) {
        if (window == IntPtr.Zero) return null;
        Rect rect; GetWindowRect(window, out rect);
        Rect origin = new Rect();
        if (parent != IntPtr.Zero) GetWindowRect(parent, out origin);
        return new int[] { rect.Left - origin.Left, rect.Top - origin.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
    }
    static YabDpiSample Read(IntPtr window, string page, int monitor) {
        IntPtr sidebar = IntPtr.Zero, status = IntPtr.Zero, progress = IntPtr.Zero;
        IntPtr originalStatus = IntPtr.Zero, originalProgress = IntPtr.Zero;
        EnumChildWindows(window, (child, state) => {
            int id = GetDlgCtrlID(child);
            if (id == 0x7F10) status = child;
            if (id == 0x7F11) progress = child;
            if (id == 1006) originalStatus = child;
            if (id == 1004) originalProgress = child;
            var type = new StringBuilder(40); GetClassName(child, type, type.Capacity);
            if (type.ToString() == "Static" && SendMessage(child, 0x173, IntPtr.Zero, IntPtr.Zero) != IntPtr.Zero) {
                var size = Bounds(child, window);
                if (size[2] > 50 && size[3] > 100) sidebar = child;
            }
            return true;
        }, IntPtr.Zero);
        return new YabDpiSample {
            Page = page, Monitor = monitor, Dpi = GetDpiForWindow(window),
            PerMonitorV2 = AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window), new IntPtr(-4)),
            Window = Bounds(window, IntPtr.Zero), Next = Bounds(GetDlgItem(window, 1), window),
            Sidebar = Bounds(sidebar, window), Status = Bounds(status, window), OriginalStatus = Bounds(originalStatus, window),
            Progress = Bounds(progress, window), OriginalProgress = Bounds(originalProgress, window),
            Percent = progress == IntPtr.Zero ? -1 : SendMessage(progress, 0x408, IntPtr.Zero, IntPtr.Zero).ToInt32()
        };
    }
    public static List<YabDpiSample> Run(int process, string directory) {
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            var monitors = new List<Rect>();
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr monitor, IntPtr dc, ref Rect area, IntPtr state) => {
                monitors.Add(area); return true;
            }, IntPtr.Zero);
            if (monitors.Count == 0) throw new InvalidOperationException("No active monitors.");
            var samples = new List<YabDpiSample>();
            foreach (string page in new string[] { "sidebar", "progress" }) {
                IntPtr window = Find(process, "YAB-DPI-PREVIEW:" + page);
                Rect original; GetWindowRect(window, out original);
                for (int pass = 0; pass < 4; ++pass) {
                    for (int index = 0; index < monitors.Count; ++index) {
                        Rect target = monitors[index];
                        if (!SetWindowPos(window, IntPtr.Zero, target.Left + 20, target.Top + 20, 0, 0, 0x15))
                            throw new InvalidOperationException("Cannot move isolated preview.");
                        Thread.Sleep(180);
                        // Sending a benign message also synchronizes with its UI thread.
                        SendMessage(window, 0, IntPtr.Zero, IntPtr.Zero);
                        samples.Add(Read(window, page, index));
                        if (pass == 1) Capture(window, System.IO.Path.Combine(directory, page + "-" + index + ".bmp"));
                    }
                }
                SetWindowPos(window, IntPtr.Zero, original.Left, original.Top, 0, 0, 0x15);
                if (page == "sidebar") PostMessage(window, 0x111, new IntPtr(1), IntPtr.Zero);
            }
            return samples;
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
}
'@
try {
    [YabDpiProbe]::Run($PreviewProcessId, (Split-Path $ReportPath)) | ConvertTo-Json -Depth 5 -AsArray | Set-Content -LiteralPath $ReportPath -Encoding utf8
} finally {
    # This marker ends the preview's inert section; it never installs anything.
    Set-Content -LiteralPath (Join-Path (Split-Path $Executable) 'complete.txt') -Value 'complete' -Encoding utf8
}
