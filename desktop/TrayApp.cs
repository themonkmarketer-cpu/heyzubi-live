using System.Drawing.Drawing2D;

namespace HeyZubiDesktop;

/// <summary>
/// The tray app: wires the talk keys, the microphone, the screenshots, HeyZubi and the spark together.
/// Hold the keys → listen; let go → screenshot every monitor, ask, then speak the answer and point.
/// </summary>
internal sealed class TrayApp : ApplicationContext
{
    private readonly AppSettings _s = AppSettings.Load();
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _hint = new() { Enabled = false };
    private readonly ToolStripMenuItem _pause = new("Pause the talk keys");
    private readonly KeyboardHook? _hook;
    private readonly Recorder _rec = new();
    private readonly Player _player = new();
    private readonly SparkWindow _spark = new();
    private readonly List<MarksWindow> _marks = new();
    private readonly System.Windows.Forms.Timer _after = new() { Interval = 250 };
    private readonly List<(string q, string a)> _history = new();
    private DateTime _lastAsk = DateTime.MinValue, _shownAt;
    private CancellationTokenSource? _cts;
    private SettingsForm? _settings;
    private MainWindow? _main;
    private string _lastNotifyTag = "";
    private string _pairedWith = "";
    private bool _busy;

    public static readonly Icon AppIcon = MakeIcon();
    /// <summary>Opening HeyZubi.exe again sets this, and the running copy shows its window.</summary>
    public const string OpenSignal = @"Local\HeyZubiDesktop.Open";
    private readonly Control _ui = new();
    private readonly EventWaitHandle _openSignal = new(false, EventResetMode.AutoReset, OpenSignal);

    public TrayApp(string[] args)
    {
        // A hidden control gives async code (and the open signal) a way back to the UI thread.
        _ui.CreateControl();
        new Thread(() =>
        {
            while (_openSignal.WaitOne())
            {
                try { _ui.BeginInvoke(ShowMain); } catch { return; }
            }
        }) { IsBackground = true, Name = "HeyZubi open signal" }.Start();
        LayeredWindow.ShowInCaptures = args.Contains("--show-in-captures");
        Log.Write($"start {MainWindow.Version}: paired={_s.Paired}{(args.Contains("--background") ? ", in the background" : "")}");
        // Rewrite the file once: 0.1.0–0.2.0 also wrote the device key in plain text next to its encrypted copy.
        if (_s.Paired) { try { _s.Save(); } catch (Exception e) { Log.Write($"settings: couldn't rewrite ({e.Message})"); } }
        KeyboardHook.Debug = args.Contains("--debug-keys"); // logs only the talk keys, never other typing

        var menu = new ContextMenuStrip();
        menu.Items.Add(_hint);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open HeyZubi", null, (_, _) => ShowMain());
        menu.Items.Add("Ask by typing…", null, (_, _) => AskByTyping());
        menu.Items.Add("Talk keys and pairing…", null, (_, _) => OpenSettings());
        menu.Items.Add(_pause);
        menu.Items.Add("Open HeyZubi in the browser", null, (_, _) => { if (_s.Paired) OpenUrl(_s.Server); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit HeyZubi", null, (_, _) => Quit());
        _pause.Click += (_, _) => { _pause.Checked = !_pause.Checked; if (_hook != null) _hook.Enabled = !_pause.Checked; UpdateHint(); };

        _tray = new NotifyIcon { Icon = AppIcon, Text = "HeyZubi", ContextMenuStrip = menu, Visible = true };
        _tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ShowMain(); };
        _tray.BalloonTipClicked += (_, _) => { ShowMain(); _main?.NotificationClicked(_lastNotifyTag); };
        _pairedWith = _s.Paired ? $"{_s.Server}|{_s.TokenProtected}" : "";

        try
        {
            _hook = new KeyboardHook { Chord = Chord.ById(_s.Chord) };
            _hook.ChordDown += OnChordDown;
            _hook.ChordUp += OnChordUp;
            _hook.ChordCancelled += OnChordCancelled;
            _hook.Escape += () => { if (_spark.State != SparkState.Hidden || _rec.Recording) StopAll(); };
        }
        catch (Exception e)
        {
            _tray.ShowBalloonTip(8000, "HeyZubi", e.Message, ToolTipIcon.Error);
        }
        _after.Tick += (_, _) => AfterTick();
        UpdateHint();

        _ = StartupAsync(args);
    }

    private async Task StartupAsync(string[] args)
    {
        int i = Array.IndexOf(args, "--pair");
        if (i >= 0 && i + 1 < args.Length && Api.ParsePairingKey(args[i + 1]) is { } key)
        {
            var r = await Api.Pair(key.server, key.code, Environment.MachineName);
            if (r.Token != null)
            {
                _s.Server = key.server; _s.Token = r.Token; _s.DeviceName = Environment.MachineName;
                var main = r.Bots?.FirstOrDefault(b => b.Primary) ?? r.Bots?.FirstOrDefault();
                _s.BotId = main?.Id; _s.BotName = main?.Name;
                _s.Save();
            }
            else _tray.ShowBalloonTip(8000, "HeyZubi", r.Error ?? "Pairing failed.", ToolTipIcon.Error);
        }
        UpdateHint();
        // Opened by hand: show HeyZubi (a tray icon alone looks like nothing happened). At sign-in: stay quiet.
        if (!args.Contains("--background")) ShowMain();
        else if (!_s.Paired) _tray.ShowBalloonTip(6000, "HeyZubi", "Not paired yet: click the tray icon to pair this computer.", ToolTipIcon.Info);

        int a = Array.IndexOf(args, "--ask");
        if (a >= 0 && a + 1 < args.Length) { await Task.Delay(1500); await AskAsync(args[a + 1], null, 0); }
        // Testing without a microphone: a WAV file goes through exactly the path a spoken question takes.
        int w = Array.IndexOf(args, "--ask-wav");
        if (w >= 0 && w + 1 < args.Length && File.Exists(args[w + 1]))
        {
            await Task.Delay(1500);
            var wav = await File.ReadAllBytesAsync(args[w + 1]);
            int ms = wav.Length > 44 ? (int)((wav.Length - 44) / 32.0) : 0; // 16 kHz mono 16-bit
            _spark.Listen(() => 0.3f);
            await Task.Delay(800);
            await AskAsync(null, wav, ms);
        }
    }

    private void UpdateHint()
    {
        _hint.Text = !_s.Paired ? "Not paired: open Settings to pair"
            : _pause.Checked ? "Talk keys paused"
            : $"Hold {Chord.ById(_s.Chord)} and ask {_s.BotName ?? "your bot"}";
        _tray.Text = _s.Paired ? $"HeyZubi · {_s.BotName ?? "ready"}" : "HeyZubi (not paired)";
    }

    private void SettingsChanged()
    {
        if (_hook != null) _hook.Chord = Chord.ById(_s.Chord);
        UpdateHint();
        // Paired, unpaired, paired again (a new key) or paired elsewhere: the HeyZubi window signs in afresh.
        var now = _s.Paired ? $"{_s.Server}|{_s.TokenProtected}" : "";
        if (now != _pairedWith) { _pairedWith = now; _main?.ForceSignIn(); }
    }

    // ---- the HeyZubi window ----

    private void ShowMain()
    {
        if (_main is null || _main.IsDisposed)
        {
            _main = new MainWindow(_s, SettingsChanged, ShowNotification);
            _main.HiddenToTray += () =>
            {
                if (_s.ToldAboutTray) return;
                _s.ToldAboutTray = true; _s.Save();
                _tray.ShowBalloonTip(6000, "HeyZubi is still here", $"It keeps running in the tray, so {Chord.ById(_s.Chord)} and notifications still work. Quit it from the tray icon.", ToolTipIcon.Info);
            };
        }
        if (!_main.Visible) _main.Show();
        if (_main.WindowState == FormWindowState.Minimized) _main.WindowState = FormWindowState.Normal;
        _main.Activate();
    }

    /// <summary>A HeyZubi notification (a bot is done or needs your OK), as a Windows notification.</summary>
    private void ShowNotification(string title, string body, string tag)
    {
        _lastNotifyTag = tag;
        _tray.ShowBalloonTip(6000, title, string.IsNullOrWhiteSpace(body) ? "Open HeyZubi to see it." : body, ToolTipIcon.None);
    }

    // ---- the talk keys ----

    private void OnChordDown()
    {
        if (!_s.Paired) { _spark.Note("Pair this computer first: click the HeyZubi tray icon."); _shownAt = DateTime.Now; _after.Start(); return; }
        if (_busy) return; // still thinking about the last question
        StopAnswer();
        var err = _rec.Start();
        if (err != null) { _spark.Note(err); _shownAt = DateTime.Now; _after.Start(); return; }
        _spark.Listen(() => _rec.Level);
    }

    private void OnChordUp()
    {
        if (!_rec.Recording) return;
        var (wav, ms) = _rec.Stop();
        if (ms < 400) { _spark.Dismiss(); return; } // a tap, not a question
        _ = AskAsync(null, wav, ms);
    }

    private void OnChordCancelled()
    {
        if (!_rec.Recording) return;
        _rec.Stop();
        _spark.Dismiss();
    }

    // ---- asking ----

    private async Task AskAsync(string? question, byte[]? wav, int ms)
    {
        if (!_s.Paired || _busy) return;
        _busy = true;
        _after.Stop();
        _spark.Think(question);
        if ((DateTime.Now - _lastAsk).TotalMinutes > 10) _history.Clear();
        _lastAsk = DateTime.Now;
        _cts = new CancellationTokenSource();
        try
        {
            var started = DateTime.Now;
            var shots = ScreenGrab.CaptureAll();
            var r = await Api.Ask(_s.Server, _s.Token!, _s.BotId, question, wav, ms, shots, _history, _s.Speak, _cts.Token);
            Log.Write($"ask: {(question != null ? "typed" : $"spoken {ms} ms")}, {shots.Count} screen(s), {(DateTime.Now - started).TotalSeconds:0.0}s → " +
                (r.Error != null ? $"error: {r.Error}" : $"answer {r.Text?.Length ?? 0} chars, point {(r.Point != null ? $"screen {r.Point.Screen + 1}" : "none")}, {r.Marks?.Length ?? 0} marks, audio {(r.Audio != null ? "yes" : "no")}"));
            if (_spark.State == SparkState.Hidden) return; // stopped with Esc meanwhile
            if (r.Error != null) { _spark.Note(r.Error); }
            else if (string.IsNullOrWhiteSpace(r.Text)) { _spark.Note(r.Note ?? "Didn't catch that. Hold the keys while you talk."); }
            else
            {
                _history.Add((r.Question ?? question ?? "", r.Text));
                if (_history.Count > 4) _history.RemoveAt(0);
                Point? target = null;
                if (r.Point is { } p && p.Screen >= 0 && p.Screen < shots.Count) target = ToScreen(shots[p.Screen].Bounds, p.X, p.Y);
                ShowMarks(shots, r.Marks);
                _spark.Answer(r.Heard is { Length: > 0 } h ? h : null, r.Text, target);
                if (r.Audio != null) { try { _player.Play(Convert.FromBase64String(r.Audio)); } catch { /* the text is on screen anyway */ } }
            }
        }
        catch (OperationCanceledException) { return; }
        catch (Exception e) { Log.Write($"ask failed: {e}"); _spark.Note($"Something went wrong: {e.Message}"); }
        finally { _busy = false; }
        _shownAt = DateTime.Now;
        _after.Start();
    }

    private static Point ToScreen(Rectangle b, double fx, double fy) => new(b.X + (int)Math.Round(fx * b.Width), b.Y + (int)Math.Round(fy * b.Height));

    private void ShowMarks(List<Shot> shots, MarkDto[]? marks)
    {
        ClearMarks();
        if (marks is not { Length: > 0 }) return;
        foreach (var group in marks.Where(m => m.Screen >= 0 && m.Screen < shots.Count).GroupBy(m => m.Screen))
        {
            var b = shots[group.Key].Bounds;
            var w = new MarksWindow();
            w.ShowMarks(b, group.Select(m => new ScreenMark(m.Kind, m.Step, ToScreen(b, m.X, m.Y), m.Label)).ToList());
            _marks.Add(w);
        }
    }

    private void ClearMarks()
    {
        foreach (var w in _marks) { w.Close(); w.Dispose(); }
        _marks.Clear();
    }

    /// <summary>The answer stays while it's spoken, then 8 more seconds (Esc or the talk keys clear it sooner).</summary>
    private void AfterTick()
    {
        if (_player.Playing || _busy || _rec.Recording) { _shownAt = DateTime.Now; return; }
        if ((DateTime.Now - _shownAt).TotalSeconds >= 8) StopAnswer();
    }

    private void StopAnswer()
    {
        _after.Stop();
        _player.Stop();
        ClearMarks();
        _spark.Dismiss();
    }

    private void StopAll()
    {
        _cts?.Cancel();
        if (_rec.Recording) _rec.Stop();
        StopAnswer();
    }

    private void AskByTyping()
    {
        if (!_s.Paired) { OpenSettings(); return; }
        using var f = new Form { Text = $"Ask {_s.BotName ?? "HeyZubi"}", FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, StartPosition = FormStartPosition.CenterScreen, Font = new Font("Segoe UI", 9.75f), AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(14), Icon = AppIcon, TopMost = true };
        var box = new TextBox { Width = 380, PlaceholderText = "Ask about what's on your screen" };
        var ok = new Button { Text = "Ask", DialogResult = DialogResult.OK, AutoSize = true };
        var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
        row.Controls.Add(box); row.Controls.Add(ok);
        f.Controls.Add(row);
        f.AcceptButton = ok;
        if (f.ShowDialog() == DialogResult.OK && box.Text.Trim() is { Length: > 0 } q)
        {
            // Give the dialog a moment to leave the screen before the screenshot.
            _ = Task.Delay(250).ContinueWith(_ => AskAsync(q, null, 0), TaskScheduler.FromCurrentSynchronizationContext());
        }
    }

    private void OpenSettings()
    {
        if (_settings is { IsDisposed: false })
        {
            if (!_settings.Visible) _settings.Show();
            if (_settings.WindowState == FormWindowState.Minimized) _settings.WindowState = FormWindowState.Normal;
            _settings.Activate();
            return;
        }
        _settings = new SettingsForm(_s, SettingsChanged, async q =>
        {
            _settings?.Hide();
            await Task.Delay(250);
            await AskAsync(q, null, 0);
        });
        _settings.FormClosed += (_, _) => _settings = null;
        _settings.Show();
        _settings.Activate();
    }

    private static void OpenUrl(string url)
    {
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    private void Quit()
    {
        if (_main is { IsDisposed: false }) { _main.AllowClose = true; _main.Close(); }
        StopAll();
        _hook?.Dispose();
        _rec.Dispose();
        _player.Dispose();
        _tray.Visible = false;
        _tray.Dispose();
        ExitThread();
    }

    /// <summary>The tray icon: HeyZubi's purple orb with the orange spark.</summary>
    private static Icon MakeIcon()
    {
        using var bmp = new Bitmap(64, 64);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using (var orb = new LinearGradientBrush(new Rectangle(2, 2, 60, 60), Color.FromArgb(168, 120, 255), Color.FromArgb(96, 48, 200), 60f))
                g.FillEllipse(orb, 2, 2, 60, 60);
            using (var shine = new SolidBrush(Color.FromArgb(90, 255, 255, 255))) g.FillEllipse(shine, 14, 10, 24, 16);
            using (var spark = new SolidBrush(LayeredWindow.Orange)) g.FillEllipse(spark, 38, 36, 20, 20);
            using (var core = new SolidBrush(Color.FromArgb(255, 236, 210))) g.FillEllipse(core, 43, 40, 8, 8);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }
}
