using System.Diagnostics;
using System.Runtime.InteropServices;
using static HeyZubiDesktop.Native;

namespace HeyZubiDesktop;

/// <summary>
/// Records the default microphone as 16 kHz mono 16-bit PCM through waveIn, and hands back a WAV file.
/// Windows' microphone privacy switch applies: if desktop apps may not use the mic, the clip is silent.
/// </summary>
internal sealed class Recorder : IDisposable
{
    private const int Rate = 16000, BufferBytes = 3200, Buffers = 8; // 100 ms each
    private IntPtr _wave;
    private readonly List<IntPtr> _headers = new();
    private MemoryStream _pcm = new();
    private Thread? _pump;
    private volatile bool _running;
    private readonly Stopwatch _clock = new();
    private readonly object _lock = new();

    /// <summary>Loudness of the latest 100 ms, 0..1 (for the spark's pulse).</summary>
    public volatile float Level;
    public bool Recording => _running;

    /// <summary>Starts recording. Returns an error to show, or null.</summary>
    public string? Start()
    {
        if (_running) return null;
        if (waveInGetNumDevs() == 0) return "No microphone found. Plug one in.";
        var fmt = new WAVEFORMATEX { wFormatTag = 1, nChannels = 1, nSamplesPerSec = Rate, nAvgBytesPerSec = Rate * 2, nBlockAlign = 2, wBitsPerSample = 16, cbSize = 0 };
        int r = waveInOpen(out _wave, WAVE_MAPPER, ref fmt, IntPtr.Zero, IntPtr.Zero, 0 /* CALLBACK_NULL */);
        if (r != 0) return $"The microphone couldn't open (code {r}). Check Windows Settings › Privacy › Microphone.";
        _pcm = new MemoryStream();
        int hdrSize = Marshal.SizeOf<WAVEHDR>();
        for (int i = 0; i < Buffers; i++)
        {
            var hdr = new WAVEHDR { lpData = Marshal.AllocHGlobal(BufferBytes), dwBufferLength = BufferBytes };
            IntPtr p = Marshal.AllocHGlobal(hdrSize);
            Marshal.StructureToPtr(hdr, p, false);
            waveInPrepareHeader(_wave, p, hdrSize);
            waveInAddBuffer(_wave, p, hdrSize);
            _headers.Add(p);
        }
        _running = true;
        waveInStart(_wave);
        _clock.Restart();
        _pump = new Thread(Pump) { IsBackground = true, Name = "HeyZubi mic" };
        _pump.Start();
        return null;
    }

    private void Pump()
    {
        while (_running)
        {
            Collect(requeue: true);
            Thread.Sleep(20);
        }
    }

    private void Collect(bool requeue)
    {
        lock (_lock)
        {
            int hdrSize = Marshal.SizeOf<WAVEHDR>();
            foreach (var p in _headers)
            {
                var h = Marshal.PtrToStructure<WAVEHDR>(p);
                if ((h.dwFlags & WHDR_DONE) == 0) continue;
                if (h.dwBytesRecorded > 0)
                {
                    var buf = new byte[h.dwBytesRecorded];
                    Marshal.Copy(h.lpData, buf, 0, buf.Length);
                    _pcm.Write(buf, 0, buf.Length);
                    Level = Loudness(buf);
                }
                waveInUnprepareHeader(_wave, p, hdrSize);
                h.dwFlags = 0;
                h.dwBytesRecorded = 0;
                Marshal.StructureToPtr(h, p, false);
                if (requeue)
                {
                    waveInPrepareHeader(_wave, p, hdrSize);
                    waveInAddBuffer(_wave, p, hdrSize);
                }
            }
        }
    }

    private static float Loudness(byte[] pcm)
    {
        double sum = 0;
        int n = pcm.Length / 2;
        for (int i = 0; i < n; i++) { short s = BitConverter.ToInt16(pcm, i * 2); sum += (double)s * s; }
        double rms = n > 0 ? Math.Sqrt(sum / n) / 32768.0 : 0;
        return (float)Math.Min(1, rms * 6);
    }

    /// <summary>Stops and returns the WAV file and its length in milliseconds.</summary>
    public (byte[] wav, int ms) Stop()
    {
        if (!_running) return (Array.Empty<byte>(), 0);
        _running = false;
        _pump?.Join(500);
        int ms = (int)_clock.ElapsedMilliseconds;
        waveInStop(_wave);
        waveInReset(_wave); // marks every queued buffer done
        Collect(requeue: false);
        foreach (var p in _headers)
        {
            var h = Marshal.PtrToStructure<WAVEHDR>(p);
            Marshal.FreeHGlobal(h.lpData);
            Marshal.FreeHGlobal(p);
        }
        _headers.Clear();
        waveInClose(_wave);
        _wave = IntPtr.Zero;
        Level = 0;
        return (Wav(_pcm.ToArray()), ms);
    }

    private static byte[] Wav(byte[] pcm)
    {
        using var ms = new MemoryStream(44 + pcm.Length);
        using var w = new BinaryWriter(ms);
        w.Write("RIFF"u8.ToArray()); w.Write(36 + pcm.Length); w.Write("WAVE"u8.ToArray());
        w.Write("fmt "u8.ToArray()); w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(Rate); w.Write(Rate * 2); w.Write((short)2); w.Write((short)16);
        w.Write("data"u8.ToArray()); w.Write(pcm.Length); w.Write(pcm);
        w.Flush();
        return ms.ToArray();
    }

    public void Dispose() { if (_running) Stop(); }
}
