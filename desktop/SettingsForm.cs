namespace HeyZubiDesktop;

/// <summary>The app's one window: pairing, who answers, the talk keys, and a typed test.</summary>
internal sealed class SettingsForm : Form
{
    private readonly AppSettings _s;
    private readonly Action _changed;
    private readonly Func<string, Task> _askTyped;
    private readonly Label _status = new() { AutoSize = true, MaximumSize = new Size(460, 0) };
    private readonly TextBox _pairKey = new() { Width = 330, PlaceholderText = "Paste the pairing key from HeyZubi" };
    private readonly Button _pair = new() { Text = "Pair", AutoSize = true };
    private readonly LinkLabel _unpair = new() { Text = "Unpair this computer", AutoSize = true };
    private readonly ComboBox _bot = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 260 };
    private readonly ComboBox _chord = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 260 };
    private readonly CheckBox _speak = new() { Text = "Say answers out loud", AutoSize = true };
    private readonly CheckBox _startup = new() { Text = "Start HeyZubi when I sign in to Windows", AutoSize = true };
    private readonly TextBox _try = new() { Width = 330, PlaceholderText = "Type a question about your screen" };
    private readonly Button _ask = new() { Text = "Ask", AutoSize = true };
    private bool _loading;

    public SettingsForm(AppSettings s, Action changed, Func<string, Task> askTyped)
    {
        _s = s;
        _changed = changed;
        _askTyped = askTyped;
        Text = "HeyZubi for Windows";
        Font = new Font("Segoe UI", 9.75f);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(18);
        Icon = TrayApp.AppIcon;

        var col = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false };
        Label Head(string t) => new() { Text = t, AutoSize = true, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 14, 0, 4) };
        Label Hint(string t) => new() { Text = t, AutoSize = true, MaximumSize = new Size(460, 0), ForeColor = SystemColors.GrayText, Margin = new Padding(0, 2, 0, 2) };
        FlowLayoutPanel Row(params Control[] cs) { var r = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) }; r.Controls.AddRange(cs); return r; }

        col.Controls.Add(new Label { Text = "Hold the talk keys in any app, ask about what's on your screen, and let go. Your HeyZubi bot answers out loud and points at it.", AutoSize = true, MaximumSize = new Size(460, 0) });

        col.Controls.Add(Head("Connection"));
        col.Controls.Add(_status);
        col.Controls.Add(Row(_pairKey, _pair));
        col.Controls.Add(Hint("Make a pairing key in HeyZubi: Settings › Windows app › Pair a computer."));
        col.Controls.Add(_unpair);

        col.Controls.Add(Head("Who answers"));
        col.Controls.Add(_bot);

        col.Controls.Add(Head("Talk keys"));
        col.Controls.Add(_chord);
        col.Controls.Add(Hint("Hold them while you talk. Adding any other key cancels, so shortcuts like Ctrl + Win + D still work. Esc stops an answer."));

        col.Controls.Add(Head("Options"));
        col.Controls.Add(_speak);
        col.Controls.Add(_startup);

        col.Controls.Add(Head("Try it"));
        col.Controls.Add(Row(_try, _ask));
        col.Controls.Add(Hint("Each question sends a screenshot of your monitors to HeyZubi for that one answer. Nothing is saved, clicked or typed."));

        Controls.Add(col);

        _chord.Items.AddRange(Chord.All);
        _pair.Click += async (_, _) => await PairAsync();
        _pairKey.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await PairAsync(); } };
        _unpair.LinkClicked += (_, _) => Unpair();
        _bot.SelectedIndexChanged += (_, _) => { if (_loading || _bot.SelectedItem is not BotItem b) return; _s.BotId = b.Bot.Id; _s.BotName = b.Bot.Name; Save(); };
        _chord.SelectedIndexChanged += (_, _) => { if (_loading || _chord.SelectedItem is not Chord c) return; _s.Chord = c.Id; Save(); };
        _speak.CheckedChanged += (_, _) => { if (_loading) return; _s.Speak = _speak.Checked; Save(); };
        _startup.CheckedChanged += (_, _) => { if (_loading) return; try { AppSettings.StartsWithWindows = _startup.Checked; } catch (Exception e) { MessageBox.Show(this, e.Message, Text); } };
        _ask.Click += async (_, _) => await TryAsync();
        _try.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await TryAsync(); } };

        Shown += async (_, _) => await RefreshAsync();
    }

    private sealed record BotItem(BotInfo Bot) { public override string ToString() => Bot.Primary ? $"{Bot.Name} (main bot)" : Bot.Name; }

    private void Save() { _s.Save(); _changed(); }

    private async Task RefreshAsync()
    {
        _loading = true;
        _chord.SelectedItem = Chord.ById(_s.Chord);
        _speak.Checked = _s.Speak;
        try { _startup.Checked = AppSettings.StartsWithWindows; } catch { /* registry unavailable */ }
        _bot.Items.Clear();
        bool paired = _s.Paired;
        _unpair.Visible = paired;
        _bot.Enabled = _try.Enabled = _ask.Enabled = paired;
        _status.Text = paired ? $"Paired with {_s.Server} as “{_s.DeviceName}”. Checking…" : "Not paired yet.";
        _loading = false;
        if (!paired) return;
        var me = await Api.Me(_s.Server, _s.Token!);
        _loading = true;
        if (me.Error is not null) _status.Text = $"Paired with {_s.Server}, but: {me.Error}";
        else
        {
            _status.Text = $"Paired with {_s.Server} as “{_s.DeviceName}”.";
            foreach (var b in me.Bots ?? Array.Empty<BotInfo>()) _bot.Items.Add(new BotItem(b));
            _bot.SelectedItem = _bot.Items.Cast<BotItem>().FirstOrDefault(i => i.Bot.Id == _s.BotId) ?? _bot.Items.Cast<BotItem>().FirstOrDefault();
            if (_bot.SelectedItem is BotItem pick && pick.Bot.Id != _s.BotId) { _s.BotId = pick.Bot.Id; _s.BotName = pick.Bot.Name; _s.Save(); }
        }
        _loading = false;
    }

    private async Task PairAsync()
    {
        var key = Api.ParsePairingKey(_pairKey.Text);
        if (key is null) { _status.Text = "That isn't a pairing key. Copy it from HeyZubi: Settings › Windows app › Pair a computer."; return; }
        _pair.Enabled = false;
        _status.Text = "Pairing…";
        var name = Environment.MachineName;
        var r = await Api.Pair(key.Value.server, key.Value.code, name);
        _pair.Enabled = true;
        if (r.Error is not null || r.Token is null) { _status.Text = r.Error ?? "Pairing failed."; return; }
        _s.Server = key.Value.server;
        _s.Token = r.Token;
        _s.DeviceName = name;
        var main = r.Bots?.FirstOrDefault(b => b.Primary) ?? r.Bots?.FirstOrDefault();
        _s.BotId = main?.Id;
        _s.BotName = main?.Name;
        _pairKey.Text = "";
        Save();
        await RefreshAsync();
    }

    private void Unpair()
    {
        if (MessageBox.Show(this, "Unpair this computer? You can pair it again any time. (To cut it off on HeyZubi's side too, remove it in Settings › Windows app.)", Text, MessageBoxButtons.OKCancel) != DialogResult.OK) return;
        _s.Token = null;
        _s.Server = "";
        _s.BotId = _s.BotName = null;
        Save();
        _ = RefreshAsync();
    }

    private async Task TryAsync()
    {
        var q = _try.Text.Trim();
        if (q.Length == 0) return;
        _try.Text = "";
        await _askTyped(q);
    }
}
