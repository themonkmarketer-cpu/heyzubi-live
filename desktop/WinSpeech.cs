using System.Diagnostics;
using System.Text;

namespace HeyZubiDesktop;

/// <summary>
/// Windows' own speech, with nothing extra installed: the voices through SAPI (built into Windows, called over COM),
/// and the offline recognizer through Windows PowerShell's System.Speech (also built in). Used when Settings ›
/// Pointer Assistant › Voice is "Windows voice", and Settings › Dictation › Recognizer is "Windows offline".
/// </summary>
internal static class WinSpeech
{
    private static dynamic? _voice;

    private static dynamic? Voice()
    {
        if (_voice != null) return _voice;
        try
        {
            var t = Type.GetTypeFromProgID("SAPI.SpVoice");
            _voice = t is null ? null : Activator.CreateInstance(t);
        }
        catch (Exception e) { Log.Write($"speech: SAPI unavailable ({e.Message})"); }
        return _voice;
    }

    /// <summary>The installed voices' names, as Windows describes them.</summary>
    public static List<string> Voices()
    {
        var names = new List<string>();
        try
        {
            var v = Voice();
            if (v is null) return names;
            dynamic list = v.GetVoices();
            int n = list.Count;
            for (int i = 0; i < n; i++) names.Add((string)list.Item(i).GetDescription());
        }
        catch (Exception e) { Log.Write($"speech: voices not listed ({e.Message})"); }
        return names;
    }

    /// <summary>Speaks without waiting; a voice name that isn't installed falls back to the default voice.</summary>
    public static void Speak(string text, string? voiceName)
    {
        try
        {
            var v = Voice();
            if (v is null) return;
            v.Speak("", 2); // SVSFPurgeBeforeSpeak: stop anything still being said
            if (!string.IsNullOrWhiteSpace(voiceName))
            {
                dynamic list = v.GetVoices();
                int n = list.Count;
                for (int i = 0; i < n; i++)
                {
                    dynamic tok = list.Item(i);
                    if (string.Equals((string)tok.GetDescription(), voiceName, StringComparison.OrdinalIgnoreCase)) { v.Voice = tok; break; }
                }
            }
            v.Speak(text, 1); // SVSFlagsAsync
        }
        catch (Exception e) { Log.Write($"speech: couldn't speak ({e.Message})"); }
    }

    public static bool Speaking
    {
        get
        {
            try { var v = _voice; return v is not null && (int)v!.Status.RunningState == 2; } // SRSEIsSpeaking
            catch { return false; }
        }
    }

    public static void Stop()
    {
        try { _voice?.Speak("", 2); } catch { /* nothing playing */ }
    }

    /// <summary>
    /// Windows' offline recognizer on a WAV recording. Runs Windows PowerShell (it carries System.Speech); the recording
    /// stays on this PC. Returns the words, or an error to show.
    /// </summary>
    public static async Task<(string? text, string? error)> RecognizeAsync(byte[] wav)
    {
        var file = Path.Combine(Path.GetTempPath(), $"heyzubi-dictation-{Guid.NewGuid():N}.wav");
        try
        {
            await File.WriteAllBytesAsync(file, wav);
            const string script = """
                $ErrorActionPreference = 'Stop'
                [Console]::OutputEncoding = [Text.Encoding]::UTF8
                Add-Type -AssemblyName System.Speech
                $e = New-Object System.Speech.Recognition.SpeechRecognitionEngine
                $e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
                $e.InitialSilenceTimeout = [TimeSpan]::FromSeconds(20)
                $e.BabbleTimeout = [TimeSpan]::FromSeconds(20)
                $e.SetInputToWaveFile($env:HZ_WAV)
                $words = @()
                for ($i = 0; $i -lt 60; $i++) { $r = $e.Recognize(); if ($null -eq $r) { break }; $words += $r.Text }
                $e.Dispose()
                $words -join ' '
                """;
            var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
                $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {Convert.ToBase64String(Encoding.Unicode.GetBytes(script))}")
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            psi.Environment["HZ_WAV"] = file;
            using var p = Process.Start(psi);
            if (p is null) return (null, "Windows’ recognizer couldn’t start.");
            var outTask = p.StandardOutput.ReadToEndAsync();
            var errTask = p.StandardError.ReadToEndAsync();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            try { await p.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException) { try { p.Kill(true); } catch { } return (null, "Windows’ recognizer took too long."); }
            var text = (await outTask).Trim();
            if (p.ExitCode != 0)
            {
                var err = (await errTask).Trim();
                Log.Write($"speech: offline recognizer failed ({p.ExitCode}): {err[..Math.Min(200, err.Length)]}");
                return (null, "Windows’ offline recognizer isn’t set up on this PC (Windows Settings › Time & language › Speech). Switch the recognizer to Automatic in HeyZubi.");
            }
            return (text, null);
        }
        catch (Exception e) { Log.Write($"speech: recognize failed ({e.Message})"); return (null, $"Windows’ recognizer failed: {e.Message}"); }
        finally { try { File.Delete(file); } catch { /* temp folder */ } }
    }
}
