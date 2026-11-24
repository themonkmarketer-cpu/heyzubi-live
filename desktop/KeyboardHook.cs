using System.Diagnostics;
using System.Runtime.InteropServices;
using static HeyZubiDesktop.Native;

namespace HeyZubiDesktop;

/// <summary>A hold-to-talk key combination.</summary>
internal sealed record Chord(string Id, string Title, int[] Keys)
{
    public const int CTRL = 0x11, SHIFT = 0x10, ALT = 0x12, WIN = 0x5B, SPACE = 0x20;

    public static readonly Chord[] All =
    {
        new("ctrlWin", "Ctrl + Win", new[] { CTRL, WIN }),
        new("ctrlAlt", "Ctrl + Alt", new[] { CTRL, ALT }),
        new("ctrlShift", "Ctrl + Shift", new[] { CTRL, SHIFT }),
        new("altShift", "Alt + Shift", new[] { ALT, SHIFT }),
        new("winAlt", "Win + Alt", new[] { WIN, ALT }),
        new("ctrlShiftSpace", "Ctrl + Shift + Space", new[] { CTRL, SHIFT, SPACE }),
    };

    public static Chord ById(string? id) => All.FirstOrDefault(c => c.Id == id) ?? All[0];
    public override string ToString() => Title;
}

/// <summary>
/// Watches the keyboard in every app (a low-level hook, as Vello does). Holding the whole chord, and nothing else,
/// starts listening; letting go of any of its keys stops; pressing any other key while holding it cancels, so
/// shortcuts like Ctrl + Win + D keep working. Events arrive on the UI thread that installed the hook.
/// </summary>
internal sealed class KeyboardHook : IDisposable
{
    private const int MASK_KEY = 0xE8; // an unassigned key: sent once so releasing Win/Alt doesn't open Start or a menu bar
    private readonly LowLevelKeyboardProc _proc;
    private IntPtr _hook;
    // Keys held now, with when each last went down (or repeated).
    private readonly Dictionary<int, DateTime> _down = new();
    private bool _active;
    public static bool Debug;

    public Chord Chord { get; set; } = Chord.All[0];
    public bool Enabled { get; set; } = true;
    public event Action? ChordDown, ChordUp, ChordCancelled, Escape;

    public KeyboardHook()
    {
        _proc = Callback;
        using var p = Process.GetCurrentProcess();
        _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(p.MainModule?.ModuleName), 0);
        if (_hook == IntPtr.Zero) throw new InvalidOperationException($"The keyboard listener couldn't start (error {Marshal.GetLastWin32Error()}).");
        // Key releases are missed across a lock screen or a user switch: start clean after one.
        Microsoft.Win32.SystemEvents.SessionSwitch += (_, _) => { _down.Clear(); _active = false; };
    }

    public bool Running => _hook != IntPtr.Zero;

    private static int Normalize(int vk) => vk switch
    {
        0xA2 or 0xA3 => Chord.CTRL,
        0xA0 or 0xA1 => Chord.SHIFT,
        0xA4 or 0xA5 => Chord.ALT,
        0x5C => Chord.WIN,
        _ => vk,
    };

    private IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var k = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            int vk = (int)k.vkCode;
            // Keys this app (or another) types for you, like dictated text, never count towards a chord.
            if (vk != MASK_KEY && (k.flags & LLKHF_INJECTED) == 0)
            {
                int msg = (int)wParam;
                int key = Normalize(vk);
                if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN)
                {
                    if (vk == 0x1B) Escape?.Invoke();
                    bool repeat = _down.ContainsKey(key);
                    // A key whose release was missed (say, behind a UAC prompt) would block the chord: forget
                    // anything that has sat "down" for minutes. (Asking Windows instead is unreliable in here.)
                    var now = DateTime.UtcNow;
                    foreach (var stale in _down.Where(d => d.Key != key && now - d.Value > TimeSpan.FromMinutes(5)).Select(d => d.Key).ToList()) _down.Remove(stale);
                    _down[key] = now;
                    if (Debug && Chord.Keys.Contains(key)) Log.Write($"keys: down {key:X2} held [{string.Join(",", _down.Keys.Select(k => k.ToString("X2")))}]{(repeat ? " repeat" : "")}");
                    if (!repeat)
                    {
                        if (_active && !Chord.Keys.Contains(key))
                        {
                            _active = false;
                            ChordCancelled?.Invoke();
                        }
                        else if (!_active && Enabled && _down.Count == Chord.Keys.Length && Chord.Keys.All(_down.ContainsKey))
                        {
                            _active = true;
                            if (Chord.Keys.Contains(Chord.WIN) || Chord.Keys.Contains(Chord.ALT)) SendMask();
                            ChordDown?.Invoke();
                        }
                    }
                    // Space as part of the chord shouldn't type a space into the app underneath.
                    if (_active && key == Chord.SPACE) return 1;
                }
                else if (msg == WM_KEYUP || msg == WM_SYSKEYUP)
                {
                    _down.Remove(key);
                    if (Debug && Chord.Keys.Contains(key)) Log.Write($"keys: up {key:X2}{(_active ? " (chord ends)" : "")}");
                    if (_active && Chord.Keys.Contains(key))
                    {
                        _active = false;
                        ChordUp?.Invoke();
                        if (key == Chord.SPACE) return 1;
                    }
                }
            }
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    private static void SendMask()
    {
        var inputs = new INPUT[2];
        inputs[0].type = inputs[1].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = inputs[1].u.ki.wVk = MASK_KEY;
        inputs[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(2, inputs, Marshal.SizeOf<INPUT>());
    }

    public void Dispose()
    {
        if (_hook != IntPtr.Zero) UnhookWindowsHookEx(_hook);
        _hook = IntPtr.Zero;
    }
}
