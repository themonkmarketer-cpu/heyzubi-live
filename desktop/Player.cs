using System.Text;
using static HeyZubiDesktop.Native;

namespace HeyZubiDesktop;

/// <summary>Plays the bot's spoken answer (MP3) through Windows' own MCI player. Call it from the UI thread.</summary>
internal sealed class Player : IDisposable
{
    private const string Alias = "heyzubivoice";
    private string? _file;

    public void Play(byte[] mp3)
    {
        Stop();
        _file = Path.Combine(Path.GetTempPath(), $"heyzubi-{Guid.NewGuid():N}.mp3");
        File.WriteAllBytes(_file, mp3);
        if (mciSendString($"open \"{_file}\" type mpegvideo alias {Alias}", null, 0, IntPtr.Zero) == 0)
            mciSendString($"play {Alias}", null, 0, IntPtr.Zero);
    }

    public bool Playing
    {
        get
        {
            if (_file is null) return false;
            var sb = new StringBuilder(32);
            return mciSendString($"status {Alias} mode", sb, sb.Capacity, IntPtr.Zero) == 0 && sb.ToString() == "playing";
        }
    }

    public void Stop()
    {
        if (_file is null) return;
        mciSendString($"stop {Alias}", null, 0, IntPtr.Zero);
        mciSendString($"close {Alias}", null, 0, IntPtr.Zero);
        try { File.Delete(_file); } catch { /* next time */ }
        _file = null;
    }

    public void Dispose() => Stop();
}
