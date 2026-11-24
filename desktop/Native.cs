using System.Runtime.InteropServices;

namespace HeyZubiDesktop;

/// <summary>Windows calls the app needs. Nothing here is third-party.</summary>
internal static class Native
{
    // ---- keyboard hook ----
    public const int WH_KEYBOARD_LL = 13;
    public const int WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
    public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc fn, IntPtr hMod, uint threadId);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string? name);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);

    // ---- SendInput (the "mask" key that stops Win opening Start and Alt opening menus) ----
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    public const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
    public const uint LLKHF_INJECTED = 0x10;
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

    // ---- layered (see-through) windows ----
    public const int WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_TOPMOST = 0x8, WS_EX_NOACTIVATE = 0x8000000;
    public const int ULW_ALPHA = 2;
    public const byte AC_SRC_OVER = 0, AC_SRC_ALPHA = 1;
    public const uint WDA_EXCLUDEFROMCAPTURE = 0x11;
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; public POINT(int x, int y) { this.x = x; this.y = y; } }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; public SIZE(int cx, int cy) { this.cx = cx; this.cy = cy; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
    [DllImport("user32.dll", SetLastError = true)] public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pprSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
    [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);

    // ---- microphone (waveIn) ----
    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEFORMATEX { public ushort wFormatTag, nChannels; public uint nSamplesPerSec, nAvgBytesPerSec; public ushort nBlockAlign, wBitsPerSample, cbSize; }
    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEHDR { public IntPtr lpData; public uint dwBufferLength, dwBytesRecorded; public IntPtr dwUser; public uint dwFlags, dwLoops; public IntPtr lpNext, reserved; }
    public const uint WHDR_DONE = 1;
    public const int WAVE_MAPPER = -1;
    [DllImport("winmm.dll")] public static extern int waveInOpen(out IntPtr hwi, int deviceId, ref WAVEFORMATEX fmt, IntPtr callback, IntPtr instance, int flags);
    [DllImport("winmm.dll")] public static extern int waveInPrepareHeader(IntPtr hwi, IntPtr hdr, int size);
    [DllImport("winmm.dll")] public static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr hdr, int size);
    [DllImport("winmm.dll")] public static extern int waveInAddBuffer(IntPtr hwi, IntPtr hdr, int size);
    [DllImport("winmm.dll")] public static extern int waveInStart(IntPtr hwi);
    [DllImport("winmm.dll")] public static extern int waveInStop(IntPtr hwi);
    [DllImport("winmm.dll")] public static extern int waveInReset(IntPtr hwi);
    [DllImport("winmm.dll")] public static extern int waveInClose(IntPtr hwi);
    [DllImport("winmm.dll")] public static extern int waveInGetNumDevs();
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WAVEINCAPS { public ushort wMid, wPid; public uint vDriverVersion; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname; public uint dwFormats; public ushort wChannels, wReserved1; }
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int waveInGetDevCaps(IntPtr deviceId, ref WAVEINCAPS caps, int size);

    // ---- playback (MCI plays MP3 with no extra libraries) ----
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string command, System.Text.StringBuilder? ret, int retLength, IntPtr callback);

    // ---- DPAPI: the device token is encrypted for this Windows user ----
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DATA_BLOB { public int cbData; public IntPtr pbData; }
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CryptProtectData(ref DATA_BLOB pDataIn, string? desc, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB pDataOut);
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, IntPtr desc, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB pDataOut);
    [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr mem);

    public static byte[] Protect(byte[] data, bool encrypt)
    {
        var inBlob = new DATA_BLOB { cbData = data.Length, pbData = Marshal.AllocHGlobal(data.Length) };
        var outBlob = new DATA_BLOB();
        try
        {
            Marshal.Copy(data, 0, inBlob.pbData, data.Length);
            const int CRYPTPROTECT_UI_FORBIDDEN = 1;
            bool ok = encrypt
                ? CryptProtectData(ref inBlob, "HeyZubi", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref outBlob)
                : CryptUnprotectData(ref inBlob, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref outBlob);
            if (!ok) throw new InvalidOperationException("Windows couldn't protect the device key.");
            var result = new byte[outBlob.cbData];
            Marshal.Copy(outBlob.pbData, result, 0, outBlob.cbData);
            return result;
        }
        finally
        {
            Marshal.FreeHGlobal(inBlob.pbData);
            if (outBlob.pbData != IntPtr.Zero) LocalFree(outBlob.pbData);
        }
    }
}
