"""Media worker for Social Automation: reels.py <command> '<json args>'. Prints progress lines "@ ..." and, last, "@@JSON {...}".

Runs in the server's existing Whisper environment (numpy, scipy, Pillow, torch, faster-whisper); no OpenCV. The screen
compositing is the series' own method (edge-fit quad per frame, temporal fit, the plate's light and softness, fingers and
notches kept in front) written for these libraries.
"""
import glob, json, os, subprocess, sys
import numpy as np

W, H = 1080, 1920


def say(s):
    print("@", s, flush=True)


def done(o):
    print("@@JSON " + json.dumps(o), flush=True)


# ---------- reading ----------
def info(video):
    j = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames", "-of", "json", video], capture_output=True, check=True).stdout)["streams"][0]
    a, b = j["r_frame_rate"].split("/")
    return j["width"], j["height"], float(a) / float(b)


def frames(video, f0=0, f1=None, size=None, fps=None):
    """Frames f0..f1 (inclusive) as uint8 RGB."""
    w, h, _ = info(video)
    vf = []
    if f0 or f1 is not None:
        vf.append("select='between(n,%d,%d)'" % (f0, f1 if f1 is not None else 10 ** 9))
    if fps:
        vf.append("fps=%s" % fps)
    if size:
        w, h = size
        vf.append("scale=%d:%d:flags=%s" % (w, h, "bicubic" if w >= 400 else "area"))
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", video] + (["-vf", ",".join(vf)] if vf else []) + ["-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    n = len(p) // (w * h * 3)
    return np.frombuffer(p[: n * w * h * 3], np.uint8).reshape(n, h, w, 3)


def audio(path, sr=16000, a=None, d=None):
    cmd = ["ffmpeg", "-v", "error"] + (["-ss", str(a)] if a is not None else []) + (["-t", str(d)] if d is not None else []) + ["-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, np.float32).copy()


# ---------- words, cuts, sheets, pitch ----------
def words(a):
    from faster_whisper import WhisperModel
    y = audio(a["file"])
    if len(y) < 1600 or np.abs(y).max() < 1e-4:
        return done({"words": []})
    say("listening")
    m = WhisperModel(a.get("model", "small.en"), device="cpu", compute_type="int8", cpu_threads=6)
    def hear(x, off, vad):
        seg, _ = m.transcribe(x, language="en", word_timestamps=True, vad_filter=vad, initial_prompt=a.get("prompt") or None)
        return [[round(w.start + off, 3), round(w.end + off, 3), w.word.strip()] for s in seg for w in (s.words or [])]
    ws = hear(y, 0.0, True)
    # the voice filter can swallow a line: listen again, without it, wherever nothing was heard for a while
    end = len(y) / 16000
    gaps, t = [], 0.0
    for w in ws + [[end, end, ""]]:
        if w[0] - t > 1.4:
            gaps.append((t, w[0]))
        t = max(t, w[1])
    for g0, g1 in gaps:
        a0, a1 = max(0, g0 - 0.15), min(end, g1 + 0.15)
        x = y[int(a0 * 16000): int(a1 * 16000)]
        if np.sqrt((x ** 2).mean()) > 0.25 * np.sqrt((y ** 2).mean()):
            ws += [w for w in hear(x, a0, False) if w[0] >= g0 - 0.05 and w[1] <= g1 + 0.1]
    done({"words": sorted(ws)})


def cuts_of(video):
    f = frames(video, size=(72, 128)).astype(np.float32)
    g = f.mean(3)
    hist = np.stack([np.histogramdd(x.reshape(-1, 3), bins=(6, 6, 6), range=((0, 256),) * 3)[0].ravel() / (72 * 128) for x in f])
    d = np.abs(np.diff(g, axis=0)).mean((1, 2))
    dh = np.abs(np.diff(hist, axis=0)).sum(1) / 2
    score = d / 40.0 + dh
    out = []
    for i in range(len(score)):
        lo = score[max(0, i - 6): i + 7]
        if score[i] > 0.55 and score[i] == lo.max() and score[i] > 2.2 * np.median(lo):
            if not out or i + 1 - out[-1] >= 8:
                out.append(i + 1)
    return out, len(f)


def cuts(a):
    c, n = cuts_of(a["file"])
    _, _, fps = info(a["file"])
    done({"cuts": c, "frames": n, "fps": fps})


def sheet(a):
    """A contact sheet of the given frames (or of evenly spaced ones), numbered."""
    from PIL import Image, ImageDraw
    _, _, fps = info(a["file"])
    n = a.get("frames")
    allf = frames(a["file"], size=(216, 384))
    if not n:
        k = a.get("count", 24)
        n = [int(i) for i in np.linspace(2, len(allf) - 3, k)]
    n = [min(max(0, i), len(allf) - 1) for i in n]
    cols = a.get("cols", 6)
    rows = (len(n) + cols - 1) // cols
    im = Image.new("RGB", (cols * 220, rows * 388), (18, 16, 24))
    dr = ImageDraw.Draw(im)
    for i, f in enumerate(n):
        x, y = (i % cols) * 220 + 2, (i // cols) * 388 + 2
        im.paste(Image.fromarray(allf[f]), (x, y))
        dr.rectangle((x, y, x + 74, y + 17), fill=(0, 0, 0))
        dr.text((x + 4, y + 2), "%d  %.1fs" % (i + 1, f / fps), fill=(255, 255, 255))
    os.makedirs(os.path.dirname(a["out"]), exist_ok=True)
    im.save(a["out"], quality=86)
    done({"out": a["out"], "frames": n, "fps": fps})


def f0_of(y, sr):
    """Median pitch of the voiced part (autocorrelation, 60 to 400 Hz)."""
    n, hop = int(sr * 0.04), int(sr * 0.01)
    if len(y) < n * 3:
        return None
    e = np.array([np.sqrt((y[i:i + n] ** 2).mean()) for i in range(0, len(y) - n, hop)])
    th = max(e.max() * 0.2, 1e-4)
    out = []
    for k, i in enumerate(range(0, len(y) - n, hop)):
        if e[k] < th:
            continue
        x = y[i:i + n] - y[i:i + n].mean()
        ac = np.correlate(x, x, "full")[n - 1:]
        lo, hi = int(sr / 400), min(int(sr / 60), n - 1)
        j = lo + int(np.argmax(ac[lo:hi]))
        if ac[0] > 0 and ac[j] / ac[0] > 0.45:
            out.append(sr / j)
    return float(np.median(out)) if len(out) >= 6 else None


def pitch(a):
    y = audio(a["file"])
    done({"f0": [f0_of(y[int(s * 16000): int(e * 16000)], 16000) for s, e in a["spans"]] if a.get("spans") else [f0_of(y, 16000)]})


# ---------- screens on devices ----------
def lit(f, v=215, s=40):
    mx, mn = f.max(2).astype(np.int32), f.min(2).astype(np.int32)
    sat = np.where(mx > 0, (mx - mn) * 255 // np.maximum(mx, 1), 0)
    return (mx > v) & (sat < s)


def order(p):
    c = p.mean(0)
    p = p[np.argsort(np.arctan2(p[:, 1] - c[1], p[:, 0] - c[0]))]
    return np.roll(p, -int(np.argmin(p.sum(1))), axis=0)


def min_rect(hull):
    best = None
    for i in range(len(hull)):
        e = hull[(i + 1) % len(hull)] - hull[i]
        L = np.linalg.norm(e)
        if L < 1e-6:
            continue
        u = e / L
        R = np.array([u, [-u[1], u[0]]])
        q = hull @ R.T
        lo, hi = q.min(0), q.max(0)
        area = np.prod(hi - lo)
        if best is None or area < best[0]:
            best = (area, np.array([[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]]) @ R)
    return best[1], best[0]


def poly_area(p):
    return 0.5 * abs(np.dot(p[:, 0], np.roll(p[:, 1], -1)) - np.dot(p[:, 1], np.roll(p[:, 0], -1)))


def fit_line(pts):
    """Huber line fit: (direction, point)."""
    w = np.ones(len(pts))
    for _ in range(6):
        c = (pts * w[:, None]).sum(0) / w.sum()
        d = pts - c
        _, v = np.linalg.eigh((d * w[:, None]).T @ d)
        u = v[:, 1]
        r = np.abs(d @ np.array([-u[1], u[0]]))
        w = np.where(r < 1.0, 1.0, 1.0 / np.maximum(r, 1e-6))
    return u, c


def cross(l1, l2):
    (u1, p1), (u2, p2) = l1, l2
    A = np.array([[u1[0], -u2[0]], [u1[1], -u2[1]]])
    if abs(np.linalg.det(A)) < 1e-6:
        return None
    return p1 + np.linalg.solve(A, p2 - p1)[0] * u1


def edge_fit(mask):
    """Quad from straight-edge fits to a display mask: (quad, residual) or (None, inf)."""
    from scipy.spatial import ConvexHull
    ys, xs = np.nonzero(mask)
    if len(xs) < 1500:
        return None, np.inf
    pts = np.stack([xs, ys], 1).astype(np.float64)
    hull = pts[ConvexHull(pts).vertices]
    # the boundary of the filled hull, sampled every pixel or so
    seg = []
    for i in range(len(hull)):
        a, b = hull[i], hull[(i + 1) % len(hull)]
        k = max(2, int(np.linalg.norm(b - a)))
        seg.append(a + (b - a) * np.linspace(0, 1, k, endpoint=False)[:, None])
    bd = np.concatenate(seg)
    q = order(min_rect(hull)[0])
    res = [np.inf]
    for tol in (0.08, 0.03, 0.02):
        lines, res = [], []
        for i in range(4):
            a, b = q[i], q[(i + 1) % 4]
            d = b - a
            L = np.linalg.norm(d)
            u = d / max(L, 1e-6)
            t = (bd - a) @ u / max(L, 1e-6)
            dist = np.abs((bd - a) @ np.array([-u[1], u[0]]))
            sel = bd[(t > 0.15) & (t < 0.85) & (dist < max(4.0, tol * L))]
            if len(sel) < 10:
                return None, np.inf
            ln = fit_line(sel)
            lines.append(ln)
            res.append(np.abs((sel - ln[1]) @ np.array([-ln[0][1], ln[0][0]])).mean())
        c = [cross(lines[i - 1], lines[i]) for i in range(4)]
        if any(x is None for x in c):
            return None, np.inf
        q = order(np.array(c))
    return q, float(np.mean(res))


def display(f, box, v, s, prev=None, aspect=None):
    """The blank display in a frame: the near-white patch that is most like a screen (solid, four-sided), near the last one."""
    from scipy import ndimage as nd
    from scipy.spatial import ConvexHull
    m = lit(f, v, s)
    roi = np.zeros_like(m)
    x0, y0, x1, y1 = box
    roi[y0:y1, x0:x1] = True
    m = nd.binary_opening(m & roi, np.ones((3, 3)))
    lab, n = nd.label(m)
    if not n:
        return np.zeros_like(m)
    sizes = np.bincount(lab.ravel())
    best, score = 0, -1.0
    for i in np.argsort(sizes[1:])[::-1][:14] + 1:
        area = sizes[i]
        if area < 0.0022 * W * H or area > 0.75 * W * H:
            continue
        ys, xs = np.nonzero(lab == i)
        p = np.stack([xs, ys], 1)[:: max(1, len(xs) // 6000)]
        h = p[ConvexHull(p).vertices].astype(np.float64)
        ha = poly_area(h)
        rq, rect = min_rect(h)
        solid, box4 = area / max(ha, 1), ha / max(rect, 1)
        sc = solid * box4 * (1.0 + 0.25 * min(1.0, area / (0.2 * W * H)))
        if aspect:  # a screen has its design's shape; a plate or a tablecloth doesn't
            e1, e2 = np.linalg.norm(rq[1] - rq[0]), np.linalg.norm(rq[2] - rq[1])
            sc *= np.exp(-0.75 * abs(np.log(max(e1, e2) / max(min(e1, e2), 1) / aspect)))
        near = False
        if prev is not None:
            far = np.linalg.norm(np.array([xs.mean(), ys.mean()]) - prev.mean(0))
            sc -= 0.8 * min(1.0, far / 500)
            # the same patch a moment later, turned or foreshortened, is still the display
            near = far < 0.45 * np.sqrt(poly_area(prev)) + 25 and 0.45 < area / max(poly_area(prev), 1) < 2.0 and solid > 0.8
            if near:
                sc = max(sc, 0.0) + 0.45
        if sc > score:
            best, score = i, sc
    return (lab == best) if best and score > (0.5 if aspect else 0.62) else np.zeros_like(m)


def smooth(qs, ok, half=3):
    n = len(qs)
    out = np.empty_like(qs)
    idx = np.arange(n)
    for k in range(n):
        w = idx[max(0, k - half): k + half + 1]
        w = w[ok[w]]
        if len(w) < 3:
            w = idx[ok]
            w = w[np.argsort(np.abs(w - k))][:5]
        deg = 2 if len(w) >= 5 else 1 if len(w) >= 2 else 0
        for c in range(4):
            for xy in range(2):
                out[k, c, xy] = np.polyval(np.polyfit(w - k, qs[w, c, xy], deg), 0)
    return out


def homography(src, dst):
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    h = np.linalg.solve(np.array(A, float), np.array(dst, float).ravel())
    return np.append(h, 1).reshape(3, 3)


def warp(img, q):
    """img (PIL RGB) laid onto quad q (TL, TR, BR, BL) at 1080x1920."""
    from PIL import Image
    w, h = img.size
    Hm = homography([(0, 0), (w, 0), (w, h), (0, h)], q)
    inv = np.linalg.inv(Hm)
    inv /= inv[2, 2]
    return np.asarray(img.transform((W, H), Image.PERSPECTIVE, inv.ravel()[:8], Image.BILINEAR)).astype(np.float32)


def quad_mask(q):
    from PIL import Image, ImageDraw
    im = Image.new("L", (W, H), 0)
    ImageDraw.Draw(im).polygon([tuple(p) for p in np.round(q).astype(int)], fill=255)
    return np.asarray(im) > 0


def soft_light(f, m, sigma):
    from scipy import ndimage as nd
    k = 8  # low-frequency light: worked out small
    sm = nd.zoom(m.astype(np.float32), 1 / k, order=1)
    den = nd.gaussian_filter(sm, sigma / k) + 1e-6
    lo = []
    for c in range(3):
        x = nd.zoom(f[:, :, c].astype(np.float32) * m, 1 / k, order=1)
        lo.append(nd.gaussian_filter(x, sigma / k) / den)
    lo = np.stack(lo, 2)
    white = np.percentile(f[m], 97, axis=0) if m.any() else np.array([255.0] * 3)
    g = np.clip(lo / max(white.max(), 1.0), 0.5, 1.05)
    return np.stack([nd.zoom(g[:, :, c], (H / g.shape[0], W / g.shape[1]), order=1) for c in range(3)], 2)


def save_seq(out, name, seq):
    os.makedirs(out, exist_ok=True)
    for old in glob.glob(os.path.join(out, "*.png")):
        os.remove(old)
    from PIL import Image
    for k, rgba in enumerate(seq):
        Image.fromarray(rgba).save(os.path.join(out, "%s_%03d.png" % (name, k)), compress_level=1)


def preview(path, items):
    from PIL import Image
    os.makedirs(os.path.dirname(path), exist_ok=True)
    ims = [Image.fromarray(np.clip(x, 0, 255).astype(np.uint8)).resize((360, 640)) for x in items]
    im = Image.new("RGB", (360 * len(ims), 640))
    for i, x in enumerate(ims):
        im.paste(x, (360 * i, 0))
    im.save(path, quality=88)


def screen(a):
    """Composite a built screen onto the blank display in frames f0..f1 of a 9:16 render."""
    from PIL import Image
    from scipy import ndimage as nd
    f0, f1, name = a["f0"], a["f1"], a["name"]
    v, s = a.get("v", 215), a.get("s", 40)
    fr = frames(a["video"], f0, f1, size=(W, H))
    box = a.get("box") or [0, 0, W, H]
    say("finding the screen")
    sw, sh = Image.open(a["screen"]).size
    aspect = max(sw, sh) / min(sw, sh)
    masks, fits, prev = [], [], None
    for f in fr:
        m = display(f, box, v, s, prev, aspect)
        q, r = edge_fit(m)
        if q is not None and prev is not None and np.linalg.norm(q.mean(0) - prev.mean(0)) < 0.5 * np.sqrt(poly_area(prev)) + 40:
            # a device that tilts past the diagonal keeps its own corners: its top stays its top
            q = min((np.roll(q, k, axis=0) for k in range(4)), key=lambda z: np.linalg.norm((z - z.mean(0)) - (prev - prev.mean(0))))
        masks.append(m)
        fits.append((q, r))
        prev = q if q is not None else prev
    qs = np.array([q if q is not None else np.zeros((4, 2)) for q, _ in fits])
    res = np.array([r for _, r in fits])
    ok = np.isfinite(res)
    if ok.sum() < max(3, 0.3 * len(fr)):
        return done({"ok": False, "why": "no blank display found in %d of %d frames" % (len(fr) - int(ok.sum()), len(fr))})
    med = np.median(res[ok])
    ok &= res <= max(2.5 * med, 1.5)
    # one odd patch among good ones (a tablecloth, a plate) is not the display
    ctr, ar = qs.mean(1), np.array([poly_area(q) for q in qs])
    okc, oka = np.median(ctr[ok], 0), np.median(ar[ok])
    ok &= (np.linalg.norm(ctr - okc, axis=1) < 420) & (ar > 0.35 * oka) & (ar < 2.6 * oka)
    if ok.sum() < 3:
        return done({"ok": False, "why": "the display moves too much to follow"})
    static = a.get("motion") == "static"
    if static:
        sm = np.repeat(np.median(qs[ok], 0)[None], len(qs), 0)
    else:
        sm = smooth(qs, ok)
        size = np.linalg.norm(qs[ok][:, 2] - qs[ok][:, 0], axis=1).mean()
        ends = np.zeros(len(qs), bool)
        ends[:3] = ends[-3:] = True
        dev = np.abs(sm - qs).max((1, 2))
        ok2 = ok & ((dev < max(6.0, 0.025 * size)) | ends)
        if ok2.sum() >= 3 and (ok2 != ok).any():
            sm = smooth(qs, ok2)
        # A device that really jumps or swings is followed as it was measured: smoothing would lag behind it. Only a measurement
        # with straight edges that its neighbours do not contradict counts, so one bad frame is still smoothed over.
        sharp = ok & (res <= max(0.3, 3 * med))
        for k in range(len(qs)):
            if sharp[k] and np.abs(sm[k] - qs[k]).max() > 2.0:
                nb = [j for j in (k - 1, k + 1) if 0 <= j < len(qs) and sharp[j]]
                if nb and min(np.abs(qs[j] - qs[k]).max() for j in nb) < 0.22 * size:
                    sm[k] = qs[k]
        ok = ok & (np.abs(sm - qs).max((1, 2)) < max(6.0, 0.025 * size))
    scr = Image.open(a["screen"]).convert("RGB")
    # the design is turned when the display is landscape and the design portrait (or the other way round)
    seq, prevs = [], []
    say("laying it on")
    blank = set(range(a.get("blank_first", 0)))
    lead = int(np.argmax(ok)) if ok.any() else 0
    tail = len(ok) - 1 - int(np.argmax(ok[::-1]))
    for k, (f, q, m) in enumerate(zip(fr, sm, masks)):
        if k in blank or k < lead - 3 or k > tail + 3:  # the display isn't up yet (or has gone)
            seq.append(np.zeros((H, W, 4), np.uint8))
            continue
        tw = max(np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[3]))
        th = max(np.linalg.norm(q[3] - q[0]), np.linalg.norm(q[2] - q[1]))
        Ws, Hs = scr.size
        fx, fy = min(1.0, 1.5 * tw / Ws), min(1.0, 1.5 * th / Hs)
        small = scr.resize((max(2, int(Ws * fx)), max(2, int(Hs * fy))), Image.BOX)
        w = warp(small, q)
        qm = quad_mask(q)
        if m.any():
            w *= soft_light(f, m, max(8.0, 0.06 * min(tw, th)))
        w = np.stack([nd.gaussian_filter(w[:, :, c], a.get("blur", 0.8)) for c in range(3)], 2)
        disp = nd.binary_closing(m, np.ones((5, 5))) if m.any() else qm
        inv = ~disp & qm
        edge = qm & ~nd.binary_erosion(qm, np.ones((9, 9)))
        lab, n = nd.label(inv)
        vis = disp.copy()
        if n:
            touch = set(np.unique(lab[edge]).tolist())
            cnt = np.bincount(lab.ravel(), minlength=n + 1)
            for i in range(1, n + 1):
                if i not in touch and cnt[i] < 0.003 * qm.sum():
                    vis[lab == i] = True
        vis = np.where(qm, nd.binary_dilation(vis, np.ones((5, 5))), False)
        al = nd.gaussian_filter((nd.binary_erosion(qm, np.ones((3, 3))) & vis).astype(np.float32), 0.8)
        seq.append(np.dstack([np.clip(w, 0, 255), al * 255]).astype(np.uint8))
        if k in (max(lead, 1), len(fr) // 2, max(0, min(tail, len(fr) - 1))):
            prevs.append(f * (1 - al[:, :, None]) + np.clip(w, 0, 255) * al[:, :, None])
    save_seq(os.path.join(a["out"], name), name, seq)
    if a.get("preview") and prevs:
        preview(a["preview"], prevs)
    jit = float(np.abs(np.diff(sm, 2, axis=0)).mean()) if len(sm) > 2 else 0.0
    done({"ok": True, "frames": len(fr), "good": int(ok.sum()), "residual": float(np.median(res[np.isfinite(res)])), "jitter": jit, "first": lead, "last": tail})


def laptop(a):
    """Lay the exact design over the copy of it the render drew: the design is lined up with each frame (homography, coarse to fine)."""
    import torch
    import torch.nn.functional as F
    from PIL import Image
    from scipy import ndimage as nd
    torch.set_num_threads(6)
    f0, f1, name = a["f0"], a["f1"], a["name"]
    fr = frames(a["video"], f0, f1, size=(W, H))
    scr = Image.open(a["screen"]).convert("RGB")
    Ws, Hs = scr.size

    def prep(arr, sz, sig):  # local-contrast grey, so exposure and tint don't matter
        g = np.asarray(Image.fromarray(arr).convert("L").resize(sz, Image.BOX)).astype(np.float32) / 255
        mu = nd.gaussian_filter(g, sig)
        sd = np.sqrt(np.maximum(nd.gaussian_filter((g - mu) ** 2, sig), 3e-4))
        return torch.tensor(np.clip((g - mu) / sd, -3, 3))[None, None]

    def sample(q, ft, dt):
        """Match of the design with the frame under each quad of q (n,4,2): correlation over the part that is in the picture."""
        fh, fw = ft.shape[2:]
        dh, dw = dt.shape[2:]
        yy, xx = torch.meshgrid(torch.linspace(0, 1, dh), torch.linspace(0, 1, dw), indexing="ij")
        p0, p1, p2, p3 = [q[:, i, :, None, None] for i in range(4)]
        d1, d2, s_ = p1 - p2, p3 - p2, p0 - p1 + p2 - p3
        den = d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]
        den = torch.where(den.abs() < 1e-3, torch.full_like(den, 1e-3), den)
        g = (s_[:, 0] * d2[:, 1] - s_[:, 1] * d2[:, 0]) / den
        h = (d1[:, 0] * s_[:, 1] - d1[:, 1] * s_[:, 0]) / den
        zz = (g * xx + h * yy + 1).clamp(min=0.05)
        X = ((p1[:, 0] - p0[:, 0] + g * p1[:, 0]) * xx + (p3[:, 0] - p0[:, 0] + h * p3[:, 0]) * yy + p0[:, 0]) / zz
        Y = ((p1[:, 1] - p0[:, 1] + g * p1[:, 1]) * xx + (p3[:, 1] - p0[:, 1] + h * p3[:, 1]) * yy + p0[:, 1]) / zz
        m = ((X >= 0) & (X <= fw - 1) & (Y >= 0) & (Y <= fh - 1)).float()
        grid = torch.stack([X / (fw - 1) * 2 - 1, Y / (fh - 1) * 2 - 1], -1)
        s2 = F.grid_sample(ft.expand(len(q), -1, -1, -1), grid, align_corners=True)[:, 0]
        n = m.sum((1, 2)).clamp(min=1)
        d = dt[0, 0][None]
        ma, mb = (s2 * m).sum((1, 2)) / n, (d * m).sum((1, 2)) / n
        x1, x2 = (s2 - ma[:, None, None]) * m, (d - mb[:, None, None]) * m
        ncc = (x1 * x2).sum((1, 2)) / torch.sqrt((x1 ** 2).sum((1, 2)) * (x2 ** 2).sum((1, 2)) + 1e-6)
        frac = n / (dh * dw)
        return ncc * torch.clamp(frac / 0.55, max=1.0)  # at least about half of it has to be in the picture

    def fit(fa, q0, iters, scale, sig, lr):
        ft = prep(fa, (int(W * scale), int(H * scale)), sig)
        dw = 360
        dt = prep(np.asarray(scr), (dw, int(dw * Hs / Ws)), sig * dw / (W * scale))
        q = torch.tensor(np.asarray(q0, np.float32)[None] * scale, requires_grad=True)
        opt = torch.optim.Adam([q], lr=lr * scale)
        best, bq = -1.0, q.detach().clone()
        for it in range(iters):
            v_ = sample(q, ft, dt)[0]
            if v_.item() > best:
                best, bq = v_.item(), q.detach().clone()
            opt.zero_grad()
            (-v_).backward()
            opt.step()
            if it == int(iters * 0.6):
                for gp in opt.param_groups:
                    gp["lr"] *= 0.3
        return bq.numpy()[0] / scale, best

    say("lining up the laptop screen")
    mid = len(fr) // 2
    cs = 0.2

    def soft(arr, sz, sig, bl):  # for the first search: brightness detail and colour (the icons), blurred so near misses still score
        im = np.asarray(Image.fromarray(arr).convert("RGB").resize(sz, Image.BOX)).astype(np.float32) / 255
        out = []
        for ch in (im.mean(2), im.max(2) - im.min(2)):
            x = ch - nd.gaussian_filter(ch, sig)
            x = nd.gaussian_filter(x, bl)
            out.append(torch.tensor(x / (x.std() + 1e-6))[None, None].clamp(-4, 4))
        return out

    ft0 = soft(fr[mid], (int(W * cs), int(H * cs)), 12, 1.6)
    dt0 = soft(np.asarray(scr), (170, int(170 * Hs / Ws)), 12, 1.6)
    starts = []
    for ang in (-16, -8, 0, 8, 16):
        ca, sa = np.cos(np.radians(ang)), np.sin(np.radians(ang))
        for sw in (0.7, 0.8, 0.9, 1.02, 1.18, 1.4):
            hw, hh = sw * W / 2, sw * W * Hs / Ws / 2
            for squash in (0.8, 1.0):
                base = np.array([[-hw, -hh * squash], [hw, -hh * squash], [hw, hh * squash], [-hw, hh * squash]]) @ np.array([[ca, sa], [-sa, ca]])
                for cx in np.linspace(0.3, 0.85, 8):
                    for cy in np.linspace(0.22, 0.75, 12):
                        starts.append(base + [cx * W, cy * H])
    starts = np.array(starts, np.float32)
    if a.get("quad"):
        starts = np.concatenate([np.array([a["quad"]], np.float32), starts])
    with torch.no_grad():
        sc0 = sum(torch.cat([sample(torch.tensor(starts[i:i + 300] * cs), fx, dx) for i in range(0, len(starts), 300)]).numpy() for fx, dx in zip(ft0, dt0)) / 2
    picks = []
    for i in np.argsort(-sc0):
        if all(np.abs(starts[i] - starts[j]).max() > 70 for j in picks):
            picks.append(int(i))
        if len(picks) >= 14:
            break
    cand = sorted([fit(fr[mid], starts[i], 90, 0.24, 8.0, 7.0) for i in picks], key=lambda c: -c[1])[:4]
    cand = sorted([fit(fr[mid], q_, 80, 0.36, 4.0, 4.0) for q_, _ in cand], key=lambda c: -c[1])
    q, sc = fit(fr[mid], cand[0][0], 70, 0.6, 5.0, 1.5)
    if sc < 0.5:
        return done({"ok": False, "why": "the laptop screen couldn't be lined up (match %.2f)" % sc})
    qs, scs = [None] * len(fr), [0.0] * len(fr)
    qs[mid], scs[mid] = q, sc
    for rng in (range(mid + 1, len(fr)), range(mid - 1, -1, -1)):
        last = q
        for k in rng:
            qk, sk = fit(fr[k], last, 26, 0.45, 4.5, 1.6)
            qs[k], scs[k] = qk, sk
            if sk > 0.3:
                last = qk
            if k % 12 == 0:
                say("lining up frame %d of %d" % (k + 1, len(fr)))
    qs = np.array(qs)
    good = np.array(scs) > max(0.32, 0.75 * np.median(scs))
    idx = np.arange(len(qs))
    sm = np.zeros_like(qs)
    for k in idx:
        wt = np.exp(-0.5 * ((idx - k) / 2.5) ** 2) * good
        sm[k] = np.tensordot(wt / max(wt.sum(), 1e-9), qs, axes=1)
    seq, prevs = [], []
    for k, (f, qk) in enumerate(zip(fr, sm)):
        w = warp(scr, qk)
        region = nd.binary_erosion(quad_mask(qk), np.ones((3, 3)))
        # hands in front: where the picture differs clearly from the design (lower half of the frame only)
        A = nd.gaussian_filter(f.astype(np.float32), (6, 6, 0))
        B = nd.gaussian_filter(w, (6, 6, 0))
        gain = np.clip(np.median(A[region], 0) / np.maximum(np.median(B[region], 0), 1), 0.5, 1.6) if region.any() else 1.0
        oc = (np.linalg.norm(A - B * gain, axis=2) > 62) & region
        oc[:1100] = False
        oc = nd.binary_opening(oc, np.ones((9, 9)))
        al = region.astype(np.float32) * (1 - nd.gaussian_filter(oc.astype(np.float32), 3))
        seq.append(np.dstack([np.clip(w, 0, 255), al * 255]).astype(np.uint8))
        if k in (0, len(fr) // 2, len(fr) - 1):
            prevs.append(f * (1 - al[:, :, None]) + w * al[:, :, None])
    save_seq(os.path.join(a["out"], name), name, seq)
    if a.get("preview"):
        preview(a["preview"], prevs)
    done({"ok": True, "frames": len(fr), "good": int(good.sum()), "match": float(np.median(scs))})


def stills(a):
    """Clean full-size frames for the cover: no captions, no clock."""
    from PIL import Image
    os.makedirs(a["out"], exist_ok=True)
    res = []
    for t, name in a["times"]:
        p = os.path.join(a["out"], name)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", a["file"], "-frames:v", "1", "-vf", "scale=1080:1920:flags=lanczos", "-q:v", "2", p], check=True)
        res.append([t, name, os.path.exists(p)])
    done({"stills": res})


def voiceline(a):
    """One line laid over a render in the character's own voice: the original is muted under it, the picture is copied."""
    sr, hop = 48000, 0.01
    # The part keeps its stereo; only the new line is in the middle.
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", a["file"], "-vn", "-f", "f32le", "-ar", str(sr), "-ac", "2", "-"], capture_output=True, check=True).stdout
    track, y = np.frombuffer(raw, np.float32).reshape(-1, 2).copy(), audio(a["take"], sr)
    n = int(sr * hop)

    def env(x):
        return np.array([np.sqrt((x[i:i + n] ** 2).mean() + 1e-12) for i in range(0, len(x) - n, n)])

    def rms(x):
        x = x[np.abs(x) > 0.01]
        return 20 * np.log10(np.sqrt((x ** 2).mean() + 1e-12)) if len(x) else -30.0

    e = env(y)
    th, keep, i, gap = e.max() * 0.05, np.ones(len(y), bool), 0, a.get("gap", 0.22)
    while i < len(e):  # long pauses inside the take
        if e[i] < th:
            j = i
            while j < len(e) and e[j] < th:
                j += 1
            if (j - i) * hop > gap and i > 0 and j < len(e):
                keep[i * n + int(gap / 2 * sr): j * n - int(gap / 2 * sr)] = False
            i = j
        else:
            i += 1
    y = y[keep]
    nz = np.nonzero(np.abs(y) > 0.02)[0]
    y = y[max(0, nz[0] - int(0.03 * sr)): nz[-1] + int(0.05 * sr)]
    natural = len(y) / sr
    a["from"] = a["a"]
    if natural > a["limit"] - a["a"]:  # a longer take may begin a little earlier, inside its own shot
        a["a"] = min(a["a"], max(a.get("earliest", a["a"]), a["limit"] - natural))
    room = max(0.3, a["limit"] - a["a"])
    tempo = min(natural / room, 1.6) if natural > room else 1.0
    if tempo > 1.005:
        y = np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "-", "-af", "atempo=%.4f" % tempo, "-f", "f32le", "-ar", str(sr), "-ac", "1", "-"], input=y.tobytes(), capture_output=True, check=True).stdout, np.float32).copy()
    y = y * 10 ** ((rms(track[int(a["from"] * sr):int(a["end"] * sr)].ravel()) - rms(y)) / 20)
    f = int(0.012 * sr)
    s0, s1 = max(0, int((a["a"] - 0.04) * sr)), int((a["end"] + 0.06) * sr)
    g = np.ones(len(track), np.float32)
    g[s0:s1] = 0
    b0 = max(0, s0 - f)
    g[b0:s0] = np.linspace(1, 0, s0 - b0)
    g[s1:s1 + f] = np.linspace(0, 1, len(g[s1:s1 + f]))
    track = track * g[:, None]
    y[:f] *= np.linspace(0, 1, f)
    y[-f:] *= np.linspace(1, 0, f)
    at = int(a["a"] * sr)
    m = min(len(track), at + len(y))
    track[at:m] += y[: m - at, None]
    pk = np.abs(track).max()
    if pk > 0.99:
        track = track * (0.99 / pk)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a["file"], "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "-", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ac", "2", a["out"]], input=track.astype(np.float32).tobytes(), check=True)
    done({"natural": natural, "tempo": tempo})


if __name__ == "__main__":
    {"words": words, "cuts": cuts, "sheet": sheet, "pitch": pitch, "screen": screen, "laptop": laptop, "stills": stills, "voiceline": voiceline}[sys.argv[1]](json.loads(sys.argv[2]))
