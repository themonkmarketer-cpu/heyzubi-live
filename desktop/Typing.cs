using System.Runtime.InteropServices;
using static HeyZubiDesktop.Native;

namespace HeyZubiDesktop;

/// <summary>
/// Types dictated words into whatever has the keyboard focus, as Unicode key presses (any language, any script).
/// One character at a time with a pause: sent in one burst, Windows 11's Notepad repeats whichever character came last
/// ("Hello, this is          ?????"). Measured on 25 Nov 2026: up to 8 ms still garbles on a busy PC, 12 and 16 ms were
/// exact every time, so 16 ms it is.
/// </summary>
internal static class Typing
{
    private const int PauseMs = 16;

    /// <summary>
    /// Types the text. Stops on cancel, and when another window comes to the front, so words never land in the wrong
    /// place. Returns null when all of it was typed, else what to tell the person.
    /// </summary>
    public static Task<string?> TypeAsync(string text, CancellationToken ct) => Task.Run(() =>
    {
        // Off the UI thread: the app's own keyboard listeners run there and every key passes through them.
        text = text.Replace("\r\n", "\n").Replace('\n', ' ');
        // Letting go of one talk key ends the recording; wait for the other, or the first letters become shortcuts.
        for (int i = 0; i < 100 && ModifierHeld(); i++) { if (ct.IsCancellationRequested) return null; Thread.Sleep(20); }
        if (ModifierHeld()) return "Let go of Ctrl, Alt, Shift and Win, then dictate again.";
        IntPtr target = GetForegroundWindow();
        timeBeginPeriod(1); // else Windows rounds the pauses up and down
        try
        {
            foreach (char ch in text)
            {
                if (ct.IsCancellationRequested) return null;
                if (GetForegroundWindow() != target) return "Stopped typing: another window came to the front.";
                Press(ch);
                Thread.Sleep(PauseMs);
            }
            return null;
        }
        finally { timeEndPeriod(1); }
    });

    private static bool ModifierHeld() => new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }.Any(k => (GetAsyncKeyState(k) & 0x8000) != 0);

    private static void Press(char ch)
    {
        var down = new INPUT { type = INPUT_KEYBOARD };
        down.u.ki.wScan = ch;
        down.u.ki.dwFlags = KEYEVENTF_UNICODE;
        var up = down;
        up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        SendInput(2, new[] { down, up }, Marshal.SizeOf<INPUT>());
    }
}
