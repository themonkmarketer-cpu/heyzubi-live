using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HeyZubiDesktop;

/// <summary>A small log for troubleshooting (%APPDATA%\HeyZubi Desktop\app.log). Never holds keys, audio or screenshots.</summary>
internal static class Log
{
    private static readonly object Gate = new();

    public static void Write(string line)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(AppSettings.Folder);
                var path = Path.Combine(AppSettings.Folder, "app.log");
                if (File.Exists(path) && new FileInfo(path).Length > 512 * 1024) File.Delete(path);
                File.AppendAllText(path, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}");
            }
        }
        catch { /* logging must never break the app */ }
    }
}

/// <summary>
/// The app's settings, in %APPDATA%\HeyZubi Desktop\settings.json. The device token is encrypted with Windows
/// DPAPI for this Windows user, so the file is useless copied to another account or PC.
/// </summary>
internal sealed class AppSettings
{
    public string Server { get; set; } = "";
    public string? TokenProtected { get; set; }
    public string DeviceName { get; set; } = "";
    public string Chord { get; set; } = "ctrlWin";
    public string? BotId { get; set; }
    public string? BotName { get; set; }
    public bool Speak { get; set; } = true;
    /// <summary>The HeyZubi window's last place and size ("x,y,w,h"), and whether it was maximized.</summary>
    public string? WindowBounds { get; set; }
    public bool WindowMaximized { get; set; }
    public bool ToldAboutTray { get; set; }
    /// <summary>The settings HeyZubi sends (Settings › Products, Pointer Assistant, Dictation); never written to the file.</summary>
    [JsonIgnore] public ServerSettings? Remote { get; set; }

    public static string Folder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HeyZubi Desktop");
    private static string FilePath => Path.Combine(Folder, "settings.json");
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    /// <summary>
    /// Reads the settings. A file another copy of the app is writing at that moment is retried, and a read that
    /// still fails is logged: it must never look like "not paired" by accident.
    /// </summary>
    public static AppSettings Load()
    {
        for (int i = 0; i < 8; i++)
        {
            try
            {
                if (!File.Exists(FilePath)) return new();
                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath)) ?? new();
            }
            catch (IOException) { Thread.Sleep(150); }
            catch (Exception e) { Log.Write($"settings: couldn't read ({e.GetType().Name}: {e.Message})"); return new(); }
        }
        Log.Write("settings: the file stayed locked");
        return new();
    }

    /// <summary>Writes a temporary file and swaps it in, so a reader never sees half a file.</summary>
    public void Save()
    {
        Directory.CreateDirectory(Folder);
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json));
        File.Move(tmp, FilePath, overwrite: true);
    }

    /// <summary>Picks the pairing up from the file again (another copy of the app may have just paired).</summary>
    public bool ReloadPairing()
    {
        var d = Load();
        if (!d.Paired) return false;
        Server = d.Server; TokenProtected = d.TokenProtected; DeviceName = d.DeviceName; BotId = d.BotId; BotName = d.BotName;
        return true;
    }

    /// <summary>The device token, decrypted on use. Never written to the file: only TokenProtected is.</summary>
    [JsonIgnore]
    public string? Token
    {
        get
        {
            if (string.IsNullOrEmpty(TokenProtected)) return null;
            try { return Encoding.UTF8.GetString(Native.Protect(Convert.FromBase64String(TokenProtected), encrypt: false)); }
            catch (Exception e) { Log.Write($"settings: the device key couldn't be decrypted ({e.Message})"); return null; }
        }
        set => TokenProtected = string.IsNullOrEmpty(value) ? null : Convert.ToBase64String(Native.Protect(Encoding.UTF8.GetBytes(value), encrypt: true));
    }

    [JsonIgnore]
    public bool Paired => !string.IsNullOrEmpty(Server) && Token is not null;

    // ---- start with Windows (the user's own Run entry; off unless they tick it) ----
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunName = "HeyZubi";

    public static bool StartsWithWindows
    {
        get
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey);
            return k?.GetValue(RunName) is string;
        }
        set
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunKey);
            if (value) k.SetValue(RunName, $"\"{Environment.ProcessPath}\" --background");
            else k.DeleteValue(RunName, throwOnMissingValue: false);
        }
    }
}
