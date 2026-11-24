namespace HeyZubiDesktop;

/// <summary>
/// HeyZubi for Windows.
///   --background          start quietly in the tray (used by "Start when I sign in")
///   --pair &lt;key&gt;         pair with a pairing key from HeyZubi's Settings › Windows app
///   --ask "&lt;question&gt;"   ask once at startup, as if typed (for testing)
///   --ask-wav &lt;file&gt;      ask once with a recording, as if spoken (for testing without a microphone)
///   --show-in-captures    let screenshots include the spark (for testing)
/// </summary>
internal static class Program
{
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(int processId);

    [STAThread]
    private static void Main(string[] args)
    {
        using var single = new Mutex(true, @"Local\HeyZubiDesktop", out bool first);
        if (!first)
        {
            // Already running (usually in the tray): ask that copy to show its window, then leave.
            AllowSetForegroundWindow(-1); // you just opened it, so let the running copy come to the front
            try { using var open = EventWaitHandle.OpenExisting(TrayApp.OpenSignal); open.Set(); } catch { /* it is just starting or closing */ }
            return;
        }
        // Opened from Downloads (or anywhere else)? Install into this user's Programs folder with a Start menu entry,
        // then carry on from there. --portable runs it where it is.
        if (!args.Contains("--portable") && Install.Elsewhere(out var installed))
        {
            bool handOver = Install.Copy(installed);
            single.ReleaseMutex();
            single.Dispose();
            if (handOver)
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(installed) { Arguments = string.Join(" ", args.Select(Install.Quote)), UseShellExecute = false });
                return;
            }
            using var again = new Mutex(true, @"Local\HeyZubiDesktop", out bool stillFirst);
            if (!stillFirst) return;
            Run(args);
            return;
        }
        Install.StartMenuShortcut();
        Run(args);
    }

    private static void Run(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApp(args));
    }
}

/// <summary>The per-user install: %LOCALAPPDATA%\Programs\HeyZubi\HeyZubi.exe and a Start menu shortcut. No admin needed.</summary>
internal static class Install
{
    public static string Folder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "HeyZubi");
    public static string Exe => Path.Combine(Folder, "HeyZubi.exe");
    private static string Shortcut => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "HeyZubi.lnk");

    public static string Quote(string a) => a.Length > 0 && !a.Any(c => c == ' ' || c == '"') ? a : $"\"{a.Replace("\"", "\\\"")}\"";

    /// <summary>True when this copy is not the installed one.</summary>
    public static bool Elsewhere(out string installed)
    {
        installed = Exe;
        var me = Environment.ProcessPath ?? "";
        return !string.Equals(Path.GetFullPath(me), Path.GetFullPath(installed), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Copies this exe into place unless a newer one is there. Returns whether the installed copy should run now.</summary>
    public static bool Copy(string installed)
    {
        try
        {
            var mine = Version.Parse(System.Diagnostics.FileVersionInfo.GetVersionInfo(Environment.ProcessPath!).FileVersion ?? "0.0.0");
            var theirs = File.Exists(installed) ? Version.Parse(System.Diagnostics.FileVersionInfo.GetVersionInfo(installed).FileVersion ?? "0.0.0") : new Version(0, 0);
            Directory.CreateDirectory(Folder);
            if (mine < theirs) return true;
            // The copy being replaced may still be closing (its window and web view take a moment): wait for it.
            for (int i = 0; ; i++)
            {
                try { File.Copy(Environment.ProcessPath!, installed, overwrite: true); return true; }
                catch (IOException) when (i < 25) { Thread.Sleep(200); }
            }
        }
        catch (Exception e)
        {
            Log.Write($"install: {e.Message}");
            return File.Exists(installed);
        }
    }

    /// <summary>A Start menu entry for the installed app (made once).</summary>
    public static void StartMenuShortcut()
    {
        try
        {
            if (File.Exists(Shortcut)) return;
            var type = Type.GetTypeFromProgID("WScript.Shell");
            if (type is null) return;
            dynamic shell = Activator.CreateInstance(type)!;
            dynamic link = shell.CreateShortcut(Shortcut);
            link.TargetPath = Exe;
            link.WorkingDirectory = Folder;
            link.Description = "HeyZubi: your team of AI agents";
            link.IconLocation = $"{Exe},0";
            link.Save();
        }
        catch (Exception e) { Log.Write($"shortcut: {e.Message}"); }
    }
}
