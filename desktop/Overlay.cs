using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using static HeyZubiDesktop.Native;

namespace HeyZubiDesktop;

/// <summary>
/// A see-through, always-on-top window that clicks pass through, drawn with per-pixel alpha. Windows leaves it out
/// of screenshots (so the bot never sees the spark), unless ShowInCaptures is on for testing.
/// </summary>
internal class LayeredWindow : Form
{
    public static bool ShowInCaptures;

    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);

    public LayeredWindow()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        Size = new Size(1, 1);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    protected override bool ShowWithoutActivation => true;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (!ShowInCaptures) SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE);
    }

    protected float DpiScale => IsHandleCreated ? Math.Max(1f, GetDpiForWindow(Handle) / 96f) : 1f;

    /// <summary>Puts a 32-bit ARGB bitmap on screen at the given physical position.</summary>
    protected void Present(Bitmap bmp, Point at)
    {
        // Show first: WinForms sizes the window when it is shown, which would wipe a picture already put there.
        if (!Visible) Show();
        IntPtr screenDc = GetDC(IntPtr.Zero);
        IntPtr memDc = CreateCompatibleDC(screenDc);
        IntPtr hBmp = bmp.GetHbitmap(Color.FromArgb(0));
        IntPtr old = SelectObject(memDc, hBmp);
        try
        {
            var size = new SIZE(bmp.Width, bmp.Height);
            var src = new POINT(0, 0);
            var dst = new POINT(at.X, at.Y);
            var blend = new BLENDFUNCTION { BlendOp = AC_SRC_OVER, SourceConstantAlpha = 255, AlphaFormat = AC_SRC_ALPHA };
            if (!UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, ULW_ALPHA))
                Log.Write($"overlay: UpdateLayeredWindow failed ({Marshal.GetLastWin32Error()}) at {at} size {bmp.Size}");
        }
        finally
        {
            SelectObject(memDc, old);
            DeleteObject(hBmp);
            DeleteDC(memDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    protected static GraphicsPath Rounded(RectangleF r, float radius)
    {
        var p = new GraphicsPath();
        float d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static readonly Color Orange = Color.FromArgb(255, 122, 26);
}

internal enum SparkState { Hidden, Listening, Thinking, Answer, Note }

/// <summary>
/// The spark: follows the mouse while you talk, spins while the bot thinks, then flies to the thing it points at,
/// with a bubble holding what it heard and its answer.
/// </summary>
internal sealed class SparkWindow : LayeredWindow
{
    private readonly System.Windows.Forms.Timer _tick = new() { Interval = 30 };
    private SparkState _state = SparkState.Hidden;
    private PointF _at;
    private bool _follow;
    private PointF _flyFrom, _flyTo;
    private DateTime _flyStart, _arrived = DateTime.MinValue;
    private bool _flying;
    private string? _heard, _text;
    private Func<float> _level = () => 0;
    private readonly DateTime _born = DateTime.Now;

    public SparkState State => _state;

    public SparkWindow()
    {
        _tick.Tick += (_, _) => Frame();
    }

    public void Listen(Func<float> level)
    {
        _level = level;
        _state = SparkState.Listening;
        _follow = true;
        _flying = false;
        _heard = _text = null;
        Start();
    }

    public void Think(string? heard = null)
    {
        _state = SparkState.Thinking;
        _heard = heard;
        _text = null;
        Start();
    }

    /// <summary>Shows the answer. With a target, the spark flies there and stays.</summary>
    public void Answer(string? heard, string text, Point? target)
    {
        _state = SparkState.Answer;
        _heard = heard;
        _text = text;
        if (target is { } t)
        {
            _follow = false;
            _flyFrom = _at;
            _flyTo = t;
            _flyStart = DateTime.Now;
            _flying = true;
        }
        Start();
    }

    public void Note(string text)
    {
        _state = SparkState.Note;
        _text = text;
        _heard = null;
        Start();
    }

    public void Dismiss()
    {
        _state = SparkState.Hidden;
        _follow = false;
        _at = PointF.Empty;
        _tick.Stop();
        Hide();
    }

    private void Start()
    {
        if (_follow || _at == PointF.Empty) { var c = Cursor.Position; _at = new PointF(c.X + 18, c.Y + 20); }
        if (!_tick.Enabled) _tick.Start();
        Frame();
    }

    private void Frame()
    {
        if (_state == SparkState.Hidden) return;
        if (_follow) { var c = Cursor.Position; _at = new PointF(c.X + 18, c.Y + 20); }
        if (_flying)
        {
            double t = Math.Min(1, (DateTime.Now - _flyStart).TotalMilliseconds / 650.0);
            double e = 1 - Math.Pow(1 - t, 3);
            _at = new PointF((float)(_flyFrom.X + (_flyTo.X - _flyFrom.X) * e), (float)(_flyFrom.Y + (_flyTo.Y - _flyFrom.Y) * e));
            if (t >= 1) { _flying = false; _arrived = DateTime.Now; }
        }
        Render();
    }

    private void Render()
    {
        float s = DpiScale;
        float glow = 26 * s;
        string? status = _state switch { SparkState.Listening => "Listening…", SparkState.Thinking => "Looking…", _ => null };
        string? body = _state is SparkState.Answer or SparkState.Note ? _text : status;
        string? heard = _heard;

        using var bodyFont = new Font("Segoe UI", 10.5f * s, FontStyle.Regular, GraphicsUnit.Pixel);
        using var heardFont = new Font("Segoe UI", 9.5f * s, FontStyle.Italic, GraphicsUnit.Pixel);
        float maxW = 360 * s, padX = 12 * s, padY = 9 * s;
        SizeF bodySize = SizeF.Empty, heardSize = SizeF.Empty;
        using (var probe = Graphics.FromHwnd(IntPtr.Zero))
        {
            probe.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            if (!string.IsNullOrEmpty(body)) bodySize = probe.MeasureString(body, bodyFont, (int)maxW);
            if (!string.IsNullOrEmpty(heard) && _state != SparkState.Listening) heardSize = probe.MeasureString($"“{heard}”", heardFont, (int)maxW);
        }
        bool bubble = bodySize != SizeF.Empty;
        float bw = bubble ? Math.Max(bodySize.Width, heardSize.Width) + padX * 2 : 0;
        float bh = bubble ? bodySize.Height + (heardSize == SizeF.Empty ? 0 : heardSize.Height + 4 * s) + padY * 2 : 0;

        // Bubble to the lower right of the spark, or to the left / above near the screen's edges.
        var area = Screen.FromPoint(Point.Round(_at)).WorkingArea;
        bool left = _at.X + glow + bw + 16 * s > area.Right;
        bool up = _at.Y + glow + bh + 16 * s > area.Bottom;
        float sparkX = left ? bw + 14 * s + glow : glow, sparkY = up ? bh + 10 * s + glow : glow;
        int width = (int)Math.Ceiling(sparkX + glow + (left ? 0 : bw + 14 * s)) + 2;
        int height = (int)Math.Ceiling(sparkY + glow + (up ? 0 : bh + 10 * s)) + 2;

        using var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);
            DrawSpark(g, sparkX, sparkY, s);
            if (bubble)
            {
                float bx = left ? sparkX - glow - 6 * s - bw : sparkX + 14 * s;
                float by = up ? sparkY - glow - bh : sparkY + 10 * s;
                var rect = new RectangleF(bx, by, bw, bh);
                using var path = Rounded(rect, 12 * s);
                using var fill = new SolidBrush(Color.FromArgb(236, 26, 22, 40));
                using var edge = new Pen(Color.FromArgb(70, 255, 255, 255), 1 * s);
                g.FillPath(fill, path);
                g.DrawPath(edge, path);
                float ty = by + padY;
                if (heardSize != SizeF.Empty)
                {
                    using var grey = new SolidBrush(Color.FromArgb(200, 190, 186, 210));
                    g.DrawString($"“{heard}”", heardFont, grey, new RectangleF(bx + padX, ty, maxW, heardSize.Height + 2));
                    ty += heardSize.Height + 4 * s;
                }
                using var white = new SolidBrush(_state == SparkState.Answer ? Color.White : Color.FromArgb(230, 220, 216, 235));
                g.DrawString(body, bodyFont, white, new RectangleF(bx + padX, ty, maxW, bodySize.Height + 2));
            }
        }
        Present(bmp, new Point((int)(_at.X - sparkX), (int)(_at.Y - sparkY)));
    }

    private void DrawSpark(Graphics g, float x, float y, float s)
    {
        double t = (DateTime.Now - _born).TotalSeconds;
        float r = 7 * s;
        if (_state == SparkState.Listening) r = (7 + 7 * Math.Clamp(_level(), 0, 1)) * s;
        else if (_state == SparkState.Answer && !_flying) r = (7 + (float)Math.Sin(t * 3) * 0.8f) * s;
        float glow = r + 14 * s;

        // A ring that spreads out once the spark lands on its target.
        double since = (DateTime.Now - _arrived).TotalMilliseconds;
        if (since < 1400)
        {
            float k = (float)(since / 1400);
            using var ring = new Pen(Color.FromArgb((int)(200 * (1 - k)), Orange), 3 * s);
            float rr = r + 30 * s * k;
            g.DrawEllipse(ring, x - rr, y - rr, rr * 2, rr * 2);
        }

        using (var gp = new GraphicsPath())
        {
            gp.AddEllipse(x - glow, y - glow, glow * 2, glow * 2);
            using var pb = new PathGradientBrush(gp) { CenterColor = Color.FromArgb(150, Orange), SurroundColors = new[] { Color.FromArgb(0, Orange) } };
            g.FillEllipse(pb, x - glow, y - glow, glow * 2, glow * 2);
        }
        using (var core = new SolidBrush(Orange)) g.FillEllipse(core, x - r, y - r, r * 2, r * 2);
        using (var hi = new SolidBrush(Color.FromArgb(200, 255, 236, 210))) g.FillEllipse(hi, x - r * 0.45f, y - r * 0.55f, r * 0.7f, r * 0.7f);

        if (_state == SparkState.Thinking)
        {
            for (int i = 0; i < 3; i++)
            {
                double a = t * 5 + i * Math.PI * 2 / 3;
                float dx = (float)Math.Cos(a) * (r + 8 * s), dy = (float)Math.Sin(a) * (r + 8 * s);
                using var dot = new SolidBrush(Color.FromArgb(220 - i * 50, Orange));
                g.FillEllipse(dot, x + dx - 2.5f * s, y + dy - 2.5f * s, 5 * s, 5 * s);
            }
        }
    }
}

/// <summary>A numbered step, circle or arrow on one monitor.</summary>
internal sealed record ScreenMark(string Kind, int? Step, Point At, string? Label);

/// <summary>Draws the answer's marks over one whole monitor, once.</summary>
internal sealed class MarksWindow : LayeredWindow
{
    public void ShowMarks(Rectangle bounds, IReadOnlyList<ScreenMark> marks)
    {
        if (!IsHandleCreated) CreateHandle();
        float s = DpiScale;
        using var bmp = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);
            using var labelFont = new Font("Segoe UI Semibold", 10f * s, FontStyle.Bold, GraphicsUnit.Pixel);
            using var numFont = new Font("Segoe UI", 12f * s, FontStyle.Bold, GraphicsUnit.Pixel);
            foreach (var m in marks)
            {
                float x = m.At.X - bounds.X, y = m.At.Y - bounds.Y;
                using var pen = new Pen(Color.FromArgb(235, Orange), 3 * s);
                if (m.Kind == "circle")
                {
                    float r = 26 * s;
                    g.DrawEllipse(pen, x - r, y - r, r * 2, r * 2);
                }
                else if (m.Kind == "arrow")
                {
                    pen.CustomEndCap = new AdjustableArrowCap(4, 4);
                    g.DrawLine(pen, x - 60 * s, y - 60 * s, x - 6 * s, y - 6 * s);
                }
                else
                {
                    float r = 13 * s;
                    using var fill = new SolidBrush(Orange);
                    g.FillEllipse(fill, x - r, y - r, r * 2, r * 2);
                    var num = (m.Step ?? 1).ToString();
                    var ns = g.MeasureString(num, numFont);
                    g.DrawString(num, numFont, Brushes.White, x - ns.Width / 2, y - ns.Height / 2);
                }
                if (!string.IsNullOrEmpty(m.Label))
                {
                    var ls = g.MeasureString(m.Label, labelFont);
                    var rect = new RectangleF(x + 18 * s, y - ls.Height / 2 - 3 * s, ls.Width + 12 * s, ls.Height + 6 * s);
                    using var path = Rounded(rect, 7 * s);
                    using var bg = new SolidBrush(Color.FromArgb(230, 26, 22, 40));
                    g.FillPath(bg, path);
                    g.DrawString(m.Label, labelFont, Brushes.White, rect.X + 6 * s, rect.Y + 3 * s);
                }
            }
        }
        Present(bmp, bounds.Location);
    }
}
