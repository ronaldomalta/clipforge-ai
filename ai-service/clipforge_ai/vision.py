"""Computer-vision signals, in two passes so 4-hour recordings stay cheap:

1. Coarse pass over the WHOLE video using keyframes only (FFmpeg `-skip_frame nokey`,
   64×36 thumbnails): scene changes and a visual-activity curve. Decoding only keyframes
   is typically 20–50× faster than decoding every frame.
2. Fine pass ONLY on candidate windows (4 fps, 160×90): motion intensity, motion
   centroid (for smart crop), sudden flashes (possible explosions), sudden loss of
   colour (common on death / "wasted" screens) and fades to black.

These are generic, game-agnostic heuristics. They do not "understand" the scene; the
reasons shown to the user name exactly what was measured.
"""
import re
import threading

import numpy as np

from .media import popen

COARSE_W, COARSE_H = 64, 36
FINE_W, FINE_H, FINE_FPS = 160, 90, 4


def _read_frames(cmd, frame_bytes, collect_pts=False):
    proc = popen(cmd, stdout=-1, stderr=-1)
    pts = []
    err_tail = []

    def read_err():
        pattern = re.compile(rb"pts_time:\s*([-\d.]+)")
        for line in proc.stderr:
            if collect_pts:
                m = pattern.search(line)
                if m:
                    pts.append(float(m.group(1)))
                    continue
            err_tail.append(line[-300:])
            if len(err_tail) > 20:
                err_tail.pop(0)

    t = threading.Thread(target=read_err, daemon=True)
    t.start()
    frames = []
    while True:
        buf = proc.stdout.read(frame_bytes)
        if not buf or len(buf) < frame_bytes:
            break
        frames.append(np.frombuffer(buf, dtype=np.uint8))
    code = proc.wait()
    t.join(timeout=5)
    if code != 0 and not frames:
        raise RuntimeError("FFmpeg falhou na análise visual: " + b"".join(err_tail).decode("utf-8", "ignore")[-400:])
    return frames, pts


def _gray(rgb):
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def _hist(rgb):
    q = (rgb // 64).reshape(-1, 3).astype(np.int32)
    idx = q[:, 0] * 16 + q[:, 1] * 4 + q[:, 2]
    h = np.bincount(idx, minlength=64).astype(np.float32)
    return h / max(1.0, h.sum())


def coarse_pass(ffmpeg, source, duration, on_progress=None):
    """Keyframe sampling of the whole video → arrays (times, activity, scene_cut, luma, signature)."""
    select = "select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,0.9)'"
    cmd = [ffmpeg, "-hide_banner", "-nostats", "-loglevel", "info", "-skip_frame", "nokey", "-i", source,
           "-an", "-sn", "-dn", "-vf", f"{select},scale={COARSE_W}:{COARSE_H}:flags=area,showinfo",
           "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]
    frames, pts = _read_frames(cmd, COARSE_W * COARSE_H * 3, collect_pts=True)
    method = "keyframes"
    if duration > 60 and len(frames) < duration / 12:
        # Very sparse keyframes: decode at 0.5 fps instead (slower, but still bounded).
        cmd = [ffmpeg, "-hide_banner", "-nostats", "-loglevel", "info", "-i", source, "-an", "-sn", "-dn",
               "-vf", f"fps=0.5,scale={COARSE_W}:{COARSE_H}:flags=area,showinfo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]
        frames, pts = _read_frames(cmd, COARSE_W * COARSE_H * 3, collect_pts=True)
        method = "fps0.5"
    n = min(len(frames), len(pts)) if pts else len(frames)
    if n == 0:
        return {"times": np.zeros(0), "activity": np.zeros(0), "scene": np.zeros(0), "luma": np.zeros(0), "sig": np.zeros((0, 64)), "method": method}
    times = np.array(pts[:n], dtype=np.float32) if pts else np.linspace(0, duration, n, dtype=np.float32)
    imgs = np.stack(frames[:n]).reshape(n, COARSE_H, COARSE_W, 3).astype(np.float32)
    gray = _gray(imgs)
    hists = np.stack([_hist(imgs[i].astype(np.uint8)) for i in range(n)])
    diff = np.zeros(n, dtype=np.float32)
    scene = np.zeros(n, dtype=np.float32)
    if n > 1:
        dt = np.maximum(np.diff(times), 0.25)
        raw = np.abs(gray[1:] - gray[:-1]).mean(axis=(1, 2))
        diff[1:] = raw / np.sqrt(dt / 2.0)  # normalise to a ~2 s keyframe gap
        hd = 0.5 * np.abs(hists[1:] - hists[:-1]).sum(axis=1)  # total-variation distance 0..1
        scene[1:] = (hd > 0.45).astype(np.float32)
    if on_progress:
        on_progress(1.0)
    return {"times": times, "activity": diff, "scene": scene, "luma": gray.mean(axis=(1, 2)), "sig": hists, "method": method}


def coarse_to_hops(coarse, n_hops, hop_s=0.5):
    """Spread keyframe measurements onto the 0.5 s hop grid."""
    act = np.zeros(n_hops, dtype=np.float32)
    scene = np.zeros(n_hops, dtype=np.float32)
    t = coarse["times"]
    if len(t) == 0 or n_hops == 0:
        return act, scene
    hop_t = np.arange(n_hops) * hop_s
    idx = np.clip(np.searchsorted(t, hop_t, side="right"), 0, len(t) - 1)
    # Activity measured between keyframe i-1 and i applies to that interval.
    act = coarse["activity"][idx].astype(np.float32)
    for ti, s in zip(t, coarse["scene"]):
        if s > 0:
            h = int(ti / hop_s)
            if 0 <= h < n_hops:
                scene[h] = 1.0
    return act, scene


def fine_pass(ffmpeg, source, start, end):
    """Dense analysis of one candidate window. Returns per-frame arrays + detected events."""
    length = max(0.5, end - start)
    cmd = [ffmpeg, "-hide_banner", "-nostats", "-loglevel", "error", "-ss", f"{max(0, start):.3f}", "-t", f"{length:.3f}",
           "-i", source, "-an", "-sn", "-dn", "-vf", f"fps={FINE_FPS},scale={FINE_W}:{FINE_H}:flags=area",
           "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]
    frames, _ = _read_frames(cmd, FINE_W * FINE_H * 3)
    n = len(frames)
    if n < 2:
        return None
    imgs = np.stack(frames).reshape(n, FINE_H, FINE_W, 3).astype(np.float32)
    gray = _gray(imgs)
    # light blur (2×2 box) to reduce compression noise
    g = (gray[:, :-1, :-1] + gray[:, 1:, :-1] + gray[:, :-1, 1:] + gray[:, 1:, 1:]) / 4
    diff = np.abs(g[1:] - g[:-1])
    motion = np.concatenate([[0.0], diff.mean(axis=(1, 2))]).astype(np.float32)
    col = diff.mean(axis=1)  # (n-1, W)
    xs = np.linspace(0, 1, col.shape[1])
    weights = np.maximum(col - np.median(col, axis=1, keepdims=True), 0) + 1e-6
    centroid = np.concatenate([[0.5], (weights * xs).sum(axis=1) / weights.sum(axis=1)]).astype(np.float32)
    mx = imgs.max(axis=3)
    mn = imgs.min(axis=3)
    sat = ((mx - mn) / np.maximum(mx, 1)).mean(axis=(1, 2)).astype(np.float32)
    luma = gray.mean(axis=(1, 2)).astype(np.float32)
    bright = (gray > 200).mean(axis=(1, 2)).astype(np.float32)
    times = start + np.arange(n, dtype=np.float32) / FINE_FPS

    events = []
    lag = 2  # 0.5 s
    for i in range(lag, n):
        if luma[i] - luma[i - lag] > 25 and bright[i] - bright[i - lag] > 0.12:
            events.append({"type": "flash", "t": float(times[i]), "strength": float(min(1.0, (luma[i] - luma[i - lag]) / 60))})
    w_before, w_after = 3 * FINE_FPS, FINE_FPS
    for i in range(w_before, n - w_after):
        before = sat[i - w_before: i - 1].mean()
        after = sat[i: i + w_after].mean()
        if before > 0.15 and after < 0.45 * before and luma[i: i + w_after].mean() > 25:
            events.append({"type": "desaturate", "t": float(times[i]), "strength": float(min(1.0, (before - after) / before))})
    dark = luma < 12
    run = 0
    for i in range(n):
        run = run + 1 if dark[i] else 0
        if run == FINE_FPS:
            events.append({"type": "black", "t": float(times[i - FINE_FPS + 1]), "strength": 1.0})
    events = _dedupe_events(events)

    # Smart-crop track: smoothed motion centroid sampled every 0.5 s.
    smooth = np.copy(centroid)
    alpha = 0.18
    for i in range(1, n):
        target = centroid[i] if motion[i] > 2.0 else smooth[i - 1] * 0.98 + 0.5 * 0.02
        smooth[i] = smooth[i - 1] + alpha * (target - smooth[i - 1])
    smooth = np.clip(smooth, 0.2, 0.8)
    track = [[round(float(times[i]), 2), round(float(smooth[i]), 3)] for i in range(0, n, 2)]

    return {
        "times": times,
        "motion": motion,
        "sat": sat,
        "luma": luma,
        "events": events,
        "track": track,
        "motion_p90": float(np.percentile(motion, 90)),
        "motion_mean": float(motion.mean()),
    }


def _dedupe_events(events, gap=1.5):
    out = []
    for ev in sorted(events, key=lambda e: (e["type"], e["t"])):
        if out and out[-1]["type"] == ev["type"] and ev["t"] - out[-1]["t"] < gap:
            if ev["strength"] > out[-1]["strength"]:
                out[-1] = ev
            continue
        out.append(ev)
    return sorted(out, key=lambda e: e["t"])
