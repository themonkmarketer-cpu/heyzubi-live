using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HeyZubiDesktop;

/// <summary>
/// The whole of HeyZubi in its own window (Edge's WebView2), signed in through the pairing: Google refuses sign-in
/// inside app windows, so the app trades its device token for a one-time sign-in link. Mic, camera, notifications
/// and the clipboard are allowed for your HeyZubi only; links elsewhere open in your browser; HeyZubi's
/// notifications become Windows notifications. Closing the window keeps HeyZubi in the tray.
/// </summary>
internal sealed class MainWindow : Form
{
    private static readonly Color Ink = Color.FromArgb(18, 16, 28);
    private const string Cookie = "heyzubi_live_session";

    private readonly AppSettings _s;
    private readonly Action _paired;
    private readonly Action<string, string, string> _notify;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Ink };
    private readonly Panel _panel = new() { Dock = DockStyle.Fill, BackColor = Ink, Visible = false };
    private bool _signingIn;
    private DateTime _lastSignIn = DateTime.MinValue;
    /// <summary>You pressed Log out in this window: don't sign straight back in, ask first.</summary>
    private bool _userSignedOut;

    public bool AllowClose;
    public event Action? HiddenToTray;
    public static string Version => typeof(MainWindow).Assembly.GetName().Version?.ToString(3) ?? "0";

    public MainWindow(AppSettings s, Action paired, Action<string, string, string> notify)
    {
        _s = s;
        _paired = paired;
        _notify = notify;
        Text = "HeyZubi";
        Icon = TrayApp.AppIcon;
        BackColor = Ink;
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.Manual;
        PlaceWindow();
        Controls.Add(_web);
        Controls.Add(_panel);
        Shown += async (_, _) => await InitAsync();
    }

    private void PlaceWindow()
    {
        var parts = (_s.WindowBounds ?? "").Split(',').Select(p => int.TryParse(p, out var n) ? n : (int?)null).ToArray();
        var area = Screen.PrimaryScreen!.WorkingArea;
        var want = parts.Length == 4 && parts.All(p => p.HasValue) ? new Rectangle(parts[0]!.Value, parts[1]!.Value, parts[2]!.Value, parts[3]!.Value) : Rectangle.Empty;
        if (want.Width < 400 || !Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(want)))
        {
            int w = Math.Min(1360, area.Width - 80), h = Math.Min(900, area.Height - 60);
            want = new Rectangle(area.X + (area.Width - w) / 2, area.Y + (area.Height - h) / 2, w, h);
        }
        Bounds = want;
        if (_s.WindowMaximized) WindowState = FormWindowState.Maximized;
    }

    private void SaveWindow()
    {
        var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        _s.WindowBounds = $"{b.X},{b.Y},{b.Width},{b.Height}";
        _s.WindowMaximized = WindowState == FormWindowState.Maximized;
        _s.Save();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        SaveWindow();
        if (!AllowClose && e.CloseReason == CloseReason.UserClosing)
        {
            // Like Vello: the window goes, HeyZubi stays in the tray (talk keys, notifications).
            e.Cancel = true;
            Hide();
            HiddenToTray?.Invoke();
            return;
        }
        base.OnFormClosing(e);
    }

    // ---- the web view ----

    private async Task InitAsync()
    {
        if (_web.CoreWebView2 != null) { await GoAsync(); return; }
        try
        {
            var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HeyZubi Desktop", "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, data, new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"));
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            ShowPanel("HeyZubi needs Microsoft Edge WebView2",
                "Windows 11 has it already; on Windows 10 install Microsoft's free “Evergreen WebView2 Runtime”, then open HeyZubi again.",
                "Get WebView2", () => OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/"));
            return;
        }
        catch (Exception e)
        {
            Log.Write($"webview: {e}");
            ShowPanel("HeyZubi couldn't start its window", e.Message, "Try again", () => _ = InitAsync());
            return;
        }

        var core = _web.CoreWebView2!; // set by EnsureCoreWebView2Async above
        core.Settings.UserAgent += $" HeyZubiDesktop/{Version}";
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.DocumentTitleChanged += (_, _) => Text = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "HeyZubi" : core.DocumentTitle;
        core.PermissionRequested += OnPermission;
        core.NewWindowRequested += OnNewWindow;
        core.NavigationStarting += OnNavigating;
        core.NavigationCompleted += OnNavigated;
        core.WebMessageReceived += OnMessage;
        // HeyZubi asks /api/auth/me on load; signed out it answers { user: null } (or 401). Then the session is gone
        // (expired, or this computer was removed and paired again): sign the window in again with the pairing,
        // instead of leaving it on Google's sign-in, which doesn't work inside an app window.
        // Log out in this window: remember it, so the next signed-out page asks instead of signing straight back in.
        core.WebResourceResponseReceived += (_, e) =>
        {
            if (Ours(e.Request.Uri) && new Uri(e.Request.Uri).AbsolutePath == "/api/auth/logout") { _userSignedOut = true; Log.Write("window: you logged out"); }
        };
        await core.AddScriptToExecuteOnDocumentCreatedAsync(NotificationShim);
        await GoAsync();
    }

    /// <summary>Opens HeyZubi (signing in first if there's no session yet), or the pairing screen.</summary>
    private async Task GoAsync()
    {
        if (_web.CoreWebView2 is not { } core) return;
        if (!_s.Paired && !_s.ReloadPairing()) { Log.Write("window: not paired, showing the pairing screen"); ShowPairing(null); return; }
        HidePanel();
        // Open HeyZubi only with a session that still works; a missing or dead one (expired, or this computer was
        // removed and paired again) is replaced through the pairing.
        var cookie = (await core.CookieManager.GetCookiesAsync(_s.Server)).FirstOrDefault(c => c.Name == Cookie);
        if (cookie != null && await Api.SessionAlive(_s.Server, Cookie, cookie.Value)) { core.Navigate($"{_s.Server}/"); return; }
        Log.Write(cookie == null ? "window: no session yet, signing in with the pairing" : "window: the session has ended, signing in with the pairing");
        if (cookie != null) core.CookieManager.DeleteCookies(Cookie, _s.Server);
        _lastSignIn = DateTime.MinValue;
        await SignInAsync();
    }

    public void Reload() { if (_web.CoreWebView2 != null) _ = GoAsync(); }

    /// <summary>Paired again (a new device key): drop the old session cookie and sign in afresh.</summary>
    public void ForceSignIn()
    {
        if (_web.CoreWebView2 is not { } core) return;
        if (_s.Paired) core.CookieManager.DeleteCookies(Cookie, _s.Server);
        _lastSignIn = DateTime.MinValue;
        _signIns.Clear();
        _ = GoAsync();
    }

    /// <summary>After a page load: signed out? Sign in with the pairing, or, right after Log out, ask first.</summary>
    private async Task CheckSessionAsync()
    {
        if (_web.CoreWebView2 is not { } core || !_s.Paired || _signingIn) return;
        var cookie = (await core.CookieManager.GetCookiesAsync(_s.Server)).FirstOrDefault(c => c.Name == Cookie);
        if (cookie != null && await Api.SessionAlive(_s.Server, Cookie, cookie.Value)) return;
        if (_userSignedOut)
        {
            ShowPanel("You signed out of HeyZubi in this window",
                "Sign in again with this PC's pairing. (To disconnect this PC for good, use the tray icon › Talk keys and pairing › Unpair, or remove it in HeyZubi › Settings › Windows app.)",
                "Sign in again", () => { _userSignedOut = false; ForceSignIn(); });
            return;
        }
        Log.Write("window: signed out after a page load, signing in with the pairing");
        await SignInAsync();
    }

    // At most 3 sign-ins in 10 minutes, so a sign-in that keeps failing can't loop.
    private readonly List<DateTime> _signIns = new();

    private async Task SignInAsync()
    {
        if (_signingIn || DateTime.Now - _lastSignIn < TimeSpan.FromSeconds(20) || _web.CoreWebView2 is not { } core) return;
        if (!_s.Paired) { ShowPairing(null); return; }
        _signIns.RemoveAll(t => DateTime.Now - t > TimeSpan.FromMinutes(10));
        if (_signIns.Count >= 3)
        {
            ShowPanel("HeyZubi keeps signing this window out",
                "The pairing works, but the session doesn't stick. Try again, or remove this computer in HeyZubi (Settings › Windows app) and pair it again.",
                "Try again", ForceSignIn);
            return;
        }
        _signIns.Add(DateTime.Now);
        _signingIn = true;
        try
        {
            var (url, error) = await Api.WebLogin(_s.Server, _s.Token!);
            _lastSignIn = DateTime.Now;
            if (url != null) { Log.Write("sign-in: got a one-time link, opening it"); HidePanel(); core.Navigate($"{_s.Server}{url}"); return; }
            Log.Write($"sign-in: {error}");
            if (error != null && error.Contains("not paired")) ShowPairing(error);
            else ShowPanel("Can't open HeyZubi", error ?? "Sign-in failed.", "Try again", () => { _lastSignIn = DateTime.MinValue; _ = GoAsync(); });
        }
        finally { _signingIn = false; }
    }

    private bool Ours(string uri) =>
        _s.Paired && Uri.TryCreate(uri, UriKind.Absolute, out var u) && Uri.TryCreate(_s.Server, UriKind.Absolute, out var home)
        && u.Scheme == home.Scheme && u.Host.Equals(home.Host, StringComparison.OrdinalIgnoreCase) && u.Port == home.Port;

    private void OnNavigating(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        // "Sign in with Google" can't work inside an app window (Google refuses it, and it would sign in your browser
        // instead): sign this window in with the PC's pairing.
        if (Ours(e.Uri) && new Uri(e.Uri).AbsolutePath.StartsWith("/api/auth/google"))
        {
            e.Cancel = true;
            Log.Write("window: Sign in with Google pressed, signing in with the pairing instead");
            _userSignedOut = false;
            BeginInvoke(ForceSignIn);
            return;
        }
        if (Ours(e.Uri) || !(e.Uri.StartsWith("http://") || e.Uri.StartsWith("https://"))) return;
        e.Cancel = true; // somewhere else on the web: the browser, not this window
        OpenExternal(e.Uri);
    }

    private void OnNewWindow(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (Ours(e.Uri)) _web.CoreWebView2.Navigate(e.Uri);
        else OpenExternal(e.Uri);
    }

    private void OnNavigated(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        // Each time HeyZubi's page loads, make sure this window is still signed in.
        if (e.IsSuccess && Ours(_web.CoreWebView2.Source) && new Uri(_web.CoreWebView2.Source).AbsolutePath == "/") { _ = CheckSessionAsync(); return; }
        if (e.IsSuccess || e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
        if (!Ours(_web.CoreWebView2.Source)) return;
        Log.Write($"navigation failed: {e.WebErrorStatus}");
        ShowPanel("Can't reach HeyZubi",
            $"{_s.Server} isn't answering ({e.WebErrorStatus}). Check that Tailscale is connected on this PC, then try again.",
            "Try again", () => _ = GoAsync());
    }

    private void OnPermission(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        if (!Ours(e.Uri)) { e.State = CoreWebView2PermissionState.Deny; return; }
        e.State = e.PermissionKind switch
        {
            CoreWebView2PermissionKind.Microphone or CoreWebView2PermissionKind.Camera or CoreWebView2PermissionKind.Notifications
                or CoreWebView2PermissionKind.ClipboardRead or CoreWebView2PermissionKind.Autoplay
                or CoreWebView2PermissionKind.MultipleAutomaticDownloads => CoreWebView2PermissionState.Allow,
            _ => CoreWebView2PermissionState.Default,
        };
    }

    // ---- notifications: the page's Notification API → Windows notifications ----

    private const string NotificationShim = """
        (() => {
          if (!window.chrome || !window.chrome.webview) return;
          const open = new Map();
          class HeyZubiNotification {
            constructor(title, opts = {}) {
              this.title = String(title || ''); this.body = String(opts.body || ''); this.tag = String(opts.tag || Math.random());
              this.onclick = null; this.onclose = null;
              open.set(this.tag, this);
              window.chrome.webview.postMessage({ type: 'notify', title: this.title, body: this.body, tag: this.tag });
            }
            close() { open.delete(this.tag); }
            static get permission() { return 'granted'; }
            static requestPermission(cb) { if (typeof cb === 'function') cb('granted'); return Promise.resolve('granted'); }
          }
          window.Notification = HeyZubiNotification;
          window.chrome.webview.addEventListener('message', (e) => {
            const d = e.data || {};
            if (d.type === 'notify-click') { const n = open.get(d.tag); if (n && typeof n.onclick === 'function') n.onclick({ target: n }); }
          });
        })();
        """;

    private void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!Ours(e.Source)) return;
        try
        {
            using var d = JsonDocument.Parse(e.WebMessageAsJson);
            var r = d.RootElement;
            if (r.TryGetProperty("type", out var t) && t.GetString() == "notify")
                _notify(r.GetProperty("title").GetString() ?? "HeyZubi", r.GetProperty("body").GetString() ?? "", r.GetProperty("tag").GetString() ?? "");
        }
        catch { /* not ours to understand */ }
    }

    /// <summary>The user clicked a notification: tell the page, which opens that chat.</summary>
    public void NotificationClicked(string tag)
    {
        if (_web.CoreWebView2 != null && tag.Length > 0) _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "notify-click", tag }));
    }

    // ---- the native screens: pairing, errors ----

    private void ShowPairing(string? problem)
    {
        var key = new TextBox { Width = 520, Font = new Font("Segoe UI", 11f), PlaceholderText = "hzpair1.…" };
        try { if (Clipboard.ContainsText() && Clipboard.GetText().Trim().StartsWith("hzpair1.")) key.Text = Clipboard.GetText().Trim(); } catch { }
        var status = new Label { AutoSize = true, ForeColor = Color.FromArgb(255, 170, 120), MaximumSize = new Size(560, 0), Text = problem ?? "" };
        var pair = new Button { Text = "Pair and open HeyZubi", AutoSize = true, Font = new Font("Segoe UI", 10f), BackColor = Color.FromArgb(140, 100, 255), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Padding = new Padding(10, 4, 10, 4) };
        pair.FlatAppearance.BorderSize = 0;
        async Task DoPair()
        {
            var k = Api.ParsePairingKey(key.Text);
            if (k is null) { status.Text = "That isn't a pairing key. Copy it from HeyZubi in your browser: Settings › Windows app › Pair a computer."; return; }
            pair.Enabled = false; status.Text = "Pairing…";
            var r = await Api.Pair(k.Value.server, k.Value.code, Environment.MachineName);
            pair.Enabled = true;
            if (r.Token is null) { status.Text = r.Error ?? "Pairing failed."; return; }
            _s.Server = k.Value.server; _s.Token = r.Token; _s.DeviceName = Environment.MachineName;
            var main = r.Bots?.FirstOrDefault(b => b.Primary) ?? r.Bots?.FirstOrDefault();
            _s.BotId = main?.Id; _s.BotName = main?.Name;
            _s.Save();
            try { Clipboard.Clear(); } catch { }
            _paired();
            await GoAsync();
        }
        pair.Click += async (_, _) => await DoPair();
        key.KeyDown += async (_, ev) => { if (ev.KeyCode == Keys.Enter) { ev.SuppressKeyPress = true; await DoPair(); } };
        BuildPanel("Welcome to HeyZubi for Windows",
            "Your whole HeyZubi in its own window, plus the talk keys: hold Ctrl + Win in any app to ask about your screen.\n\n" +
            "To connect this PC, open HeyZubi in your browser, go to Settings › Windows app › Pair a computer, copy the key and paste it here.",
            new Control[] { key, pair, status });
    }

    private void ShowPanel(string title, string text, string button, Action click)
    {
        var b = new Button { Text = button, AutoSize = true, Font = new Font("Segoe UI", 10f), BackColor = Color.FromArgb(140, 100, 255), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Padding = new Padding(10, 4, 10, 4) };
        b.FlatAppearance.BorderSize = 0;
        b.Click += (_, _) => click();
        BuildPanel(title, text, new Control[] { b });
    }

    private void BuildPanel(string title, string text, Control[] extra)
    {
        _panel.SuspendLayout();
        _panel.Controls.Clear();
        var col = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = Ink };
        col.Controls.Add(new PictureBox { Image = TrayApp.AppIcon.ToBitmap(), SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(56, 56), Margin = new Padding(0, 0, 0, 12) });
        col.Controls.Add(new Label { Text = title, AutoSize = true, ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 18f), Margin = new Padding(0, 0, 0, 10) });
        col.Controls.Add(new Label { Text = text, AutoSize = true, MaximumSize = new Size(560, 0), ForeColor = Color.FromArgb(200, 196, 220), Font = new Font("Segoe UI", 10.5f), Margin = new Padding(0, 0, 0, 16) });
        foreach (var c in extra) { c.Margin = new Padding(0, 0, 0, 10); col.Controls.Add(c); }
        _panel.Controls.Add(col);
        void Center() => col.Location = new Point(Math.Max(20, (_panel.Width - col.Width) / 2), Math.Max(20, (_panel.Height - col.Height) / 2 - 30));
        _panel.Resize += (_, _) => Center();
        _panel.ResumeLayout();
        _panel.Visible = true;
        _panel.BringToFront();
        Center();
    }

    private void HidePanel() => _panel.Visible = false;

    /// <summary>Opens a web or mail link in the PC's own app. Anything else (an empty page, another program's link) is left alone.</summary>
    private static void OpenExternal(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || !(u.Scheme == "https" || u.Scheme == "http" || u.Scheme == "mailto")) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }
}
