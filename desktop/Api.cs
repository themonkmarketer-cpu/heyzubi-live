using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HeyZubiDesktop;

internal sealed record BotInfo(string Id, string Name, bool Primary);
internal sealed record PairResult(string? Token, BotInfo[]? Bots, string? Error);
internal sealed record MeResult(BotInfo[]? Bots, string? Error);
internal sealed record PointDto(int Screen, double X, double Y, string? Label);
internal sealed record MarkDto(string Kind, int? Step, int Screen, double X, double Y, string? Label);
internal sealed record AskResult(string? Heard, string? Question, string? BotName, string? Text, PointDto? Point, MarkDto[]? Marks, string? Audio, string? Error, string? Note);

/// <summary>Talks to HeyZubi: pairing, the bot list, and questions.</summary>
internal static class Api
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(90) };
    // A Cookie header set by hand is dropped while the handler keeps its own cookie jar, so this one has none.
    private static readonly HttpClient NoCookieJar = new(new HttpClientHandler { UseCookies = false }) { Timeout = TimeSpan.FromSeconds(15) };
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    /// <summary>
    /// A pairing key from HeyZubi (hzpair1.&lt;base64url {"u": server, "c": code}&gt;), or "server code" pasted by hand.
    /// </summary>
    public static (string server, string code)? ParsePairingKey(string text)
    {
        text = text.Trim();
        if (text.StartsWith("hzpair1.", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                var b64 = text[8..].Replace('-', '+').Replace('_', '/');
                b64 = b64.PadRight(b64.Length + (4 - b64.Length % 4) % 4, '=');
                using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(b64)));
                var u = doc.RootElement.GetProperty("u").GetString();
                var c = doc.RootElement.GetProperty("c").GetString();
                if (!string.IsNullOrEmpty(u) && !string.IsNullOrEmpty(c) && u.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return (u.TrimEnd('/'), c);
            }
            catch { return null; }
            return null;
        }
        var parts = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 2 && parts[0].StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return (parts[0].TrimEnd('/'), parts[1]);
        return null;
    }

    private static async Task<T> Read<T>(HttpResponseMessage r, Func<string, T> onError)
    {
        var body = await r.Content.ReadAsStringAsync();
        if (!r.IsSuccessStatusCode)
        {
            string msg = $"HeyZubi answered {(int)r.StatusCode}.";
            try { using var d = JsonDocument.Parse(body); if (d.RootElement.TryGetProperty("error", out var e)) msg = e.GetString() ?? msg; } catch { }
            return onError(msg);
        }
        return JsonSerializer.Deserialize<T>(body, Json) ?? onError("HeyZubi sent an empty answer.");
    }

    public static async Task<PairResult> Pair(string server, string code, string deviceName)
    {
        try
        {
            var r = await Http.PostAsync($"{server}/api/desktop/pair", new StringContent(JsonSerializer.Serialize(new { code, name = deviceName }), Encoding.UTF8, "application/json"));
            return await Read(r, e => new PairResult(null, null, e));
        }
        catch (Exception e) { return new PairResult(null, null, $"Couldn't reach HeyZubi at {server}: {e.Message}"); }
    }

    public static async Task<MeResult> Me(string server, string token)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{server}/api/desktop/me");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            return await Read(await Http.SendAsync(req), e => new MeResult(null, e));
        }
        catch (Exception e) { return new MeResult(null, $"Couldn't reach HeyZubi: {e.Message}"); }
    }

    /// <summary>
    /// Whether a session cookie from the app's window still signs someone in (HeyZubi answers { user: null } when
    /// not). A network failure counts as alive, so it never causes a sign-in loop; the window shows that error.
    /// </summary>
    public static async Task<bool> SessionAlive(string server, string cookieName, string cookieValue)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{server}/api/auth/me");
            req.Headers.TryAddWithoutValidation("Cookie", $"{cookieName}={cookieValue}");
            var r = await NoCookieJar.SendAsync(req);
            if (r.StatusCode == System.Net.HttpStatusCode.Unauthorized) return false;
            if (!r.IsSuccessStatusCode) return true;
            using var d = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
            return !(d.RootElement.TryGetProperty("user", out var u) && u.ValueKind == JsonValueKind.Null);
        }
        catch { return true; }
    }

    /// <summary>A one-time sign-in link for the app's HeyZubi window (relative to the server), or an error.</summary>
    public static async Task<(string? url, string? error)> WebLogin(string server, string token)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{server}/api/desktop/web-login");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            var r = await Http.SendAsync(req);
            var body = await r.Content.ReadAsStringAsync();
            using var d = JsonDocument.Parse(body);
            if (r.IsSuccessStatusCode && d.RootElement.TryGetProperty("url", out var u) && u.GetString() is { } url && url.StartsWith("/api/desktop/login/")) return (url, null);
            return (null, d.RootElement.TryGetProperty("error", out var e) ? e.GetString() : $"HeyZubi answered {(int)r.StatusCode}.");
        }
        catch (Exception e) { return (null, $"Couldn't reach HeyZubi: {e.Message}"); }
    }

    public static async Task<AskResult> Ask(string server, string token, string? botId, string? question, byte[]? wav, int ms,
        IReadOnlyList<Shot> shots, IReadOnlyList<(string q, string a)> history, bool speak, CancellationToken ct)
    {
        try
        {
            // A plain boundary and quoted field names: .NET's defaults (a quoted boundary, bare names) trip up
            // the web-standard form parser HeyZubi's server uses.
            var boundary = $"heyzubi{Guid.NewGuid():N}";
            var form = new MultipartFormDataContent(boundary);
            form.Headers.ContentType = new MediaTypeHeaderValue("multipart/form-data");
            form.Headers.ContentType.Parameters.Add(new NameValueHeaderValue("boundary", boundary));
            void Add(HttpContent c, string name, string? file = null)
            {
                c.Headers.ContentDisposition = new ContentDispositionHeaderValue("form-data") { Name = $"\"{name}\"", FileName = file is null ? null : $"\"{file}\"" };
                form.Add(c);
            }
            if (!string.IsNullOrEmpty(botId)) Add(new StringContent(botId), "botId");
            if (!string.IsNullOrEmpty(question)) Add(new StringContent(question), "question");
            if (wav is { Length: > 0 })
            {
                var audio = new ByteArrayContent(wav);
                audio.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
                Add(audio, "audio", "question.wav");
                Add(new StringContent(ms.ToString()), "ms");
            }
            var meta = new
            {
                screens = shots.Select(s => new { w = s.W, h = s.H, primary = s.Primary, cursor = s.Cursor is { } c ? new { x = c.X, y = c.Y } : null }),
                history = history.Select(h => new { q = h.q, a = h.a }),
                speak,
            };
            Add(new StringContent(JsonSerializer.Serialize(meta)), "meta");
            for (int i = 0; i < shots.Count; i++)
            {
                var img = new ByteArrayContent(shots[i].Jpeg);
                img.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
                Add(img, $"screen{i}", $"screen{i}.jpg");
            }
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{server}/api/desktop/ask") { Content = form };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            return await Read(await Http.SendAsync(req, ct), e => new AskResult(null, null, null, null, null, null, null, e, null));
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception e) { return new AskResult(null, null, null, null, null, null, null, $"Couldn't reach HeyZubi: {e.Message}", null); }
    }
}
