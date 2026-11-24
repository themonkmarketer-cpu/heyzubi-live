using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace HeyZubiDesktop;

/// <summary>One monitor's screenshot, as sent to HeyZubi.</summary>
internal sealed record Shot(byte[] Jpeg, int W, int H, Rectangle Bounds, bool Primary, Point? Cursor);

/// <summary>
/// Screenshots every monitor (the one with the mouse first, then the main one, at most three). The app's own
/// spark and bubble are left out of screenshots by Windows (display affinity), so the bot sees only your apps.
/// </summary>
internal static class ScreenGrab
{
    private const int MaxSide = 1600;

    public static List<Shot> CaptureAll(int most = 3)
    {
        var cursor = Cursor.Position;
        var screens = Screen.AllScreens
            .OrderByDescending(s => s.Bounds.Contains(cursor))
            .ThenByDescending(s => s.Primary)
            .Take(most)
            .ToList();
        var jpeg = ImageCodecInfo.GetImageEncoders().First(e => e.FormatID == ImageFormat.Jpeg.Guid);
        using var quality = new EncoderParameters(1);
        quality.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 78L);

        var shots = new List<Shot>();
        foreach (var s in screens)
        {
            var b = s.Bounds;
            using var full = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(full)) g.CopyFromScreen(b.Location, Point.Empty, b.Size, CopyPixelOperation.SourceCopy);
            double scale = Math.Min(1.0, (double)MaxSide / Math.Max(b.Width, b.Height));
            int w = Math.Max(1, (int)Math.Round(b.Width * scale)), h = Math.Max(1, (int)Math.Round(b.Height * scale));
            Bitmap shot = full;
            Bitmap? scaled = null;
            if (scale < 1)
            {
                scaled = new Bitmap(w, h, PixelFormat.Format24bppRgb);
                using var g = Graphics.FromImage(scaled);
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(full, 0, 0, w, h);
                shot = scaled;
            }
            using var ms = new MemoryStream();
            shot.Save(ms, jpeg, quality);
            scaled?.Dispose();
            Point? c = b.Contains(cursor) ? new Point((int)((cursor.X - b.X) * scale), (int)((cursor.Y - b.Y) * scale)) : null;
            shots.Add(new Shot(ms.ToArray(), w, h, b, s.Primary, c));
        }
        return shots;
    }
}
