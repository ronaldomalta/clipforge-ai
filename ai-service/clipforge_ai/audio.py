"""Audio extraction and per-hop acoustic features.

The source is decoded ONCE by FFmpeg into a 16 kHz mono PCM WAV on disk (≈460 MB for
4 h). Features are then computed by reading that WAV in 60-second blocks, so RAM use
stays at a few MB regardless of the recording length.
"""
import re
import wave

import numpy as np

from .media import popen

SR = 16000
HOP_S = 0.5
HOP = int(SR * HOP_S)
_BANDS = None


def extract_wav(ffmpeg, source, wav_path, duration, on_progress=None, track=0):
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostats", "-y",
        "-progress", "pipe:1",
        "-i", source, "-map", f"0:a:{track}", "-vn", "-sn", "-dn",
        "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", wav_path,
    ]
    proc = popen(cmd, stdout=-1, stderr=-1, text=True)
    pattern = re.compile(r"^out_time_(?:us|ms)=(\d+)")
    for line in proc.stdout:
        m = pattern.match(line.strip())
        if m and on_progress and duration:
            on_progress(min(1.0, int(m.group(1)) / 1e6 / duration))
    err = proc.stderr.read()
    if proc.wait() != 0:
        raise RuntimeError(f"FFmpeg falhou ao extrair o áudio: {err[-500:]}")


def _band_edges():
    global _BANDS
    if _BANDS is None:
        freqs = np.fft.rfftfreq(HOP, 1.0 / SR)
        edges = np.geomspace(60, 7600, 25)
        _BANDS = (freqs, [(np.searchsorted(freqs, a), np.searchsorted(freqs, b)) for a, b in zip(edges[:-1], edges[1:])])
    return _BANDS


def hop_features(block):
    """block: (n_hops, HOP) float32 in [-1, 1] → dict of per-hop features."""
    freqs, bands = _band_edges()
    rms = np.sqrt(np.mean(block.astype(np.float64) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-9)
    window = np.hanning(HOP).astype(np.float32)
    spec = np.abs(np.fft.rfft(block * window, axis=1)) ** 2 + 1e-12
    total = spec[:, (freqs >= 40) & (freqs <= 7800)].sum(axis=1)
    low = spec[:, (freqs >= 40) & (freqs < 250)].sum(axis=1) / total
    voice = spec[:, (freqs >= 300) & (freqs < 3400)].sum(axis=1) / total
    high = spec[:, (freqs >= 4000) & (freqs <= 7800)].sum(axis=1) / total
    sel = (freqs >= 100) & (freqs <= 7000)
    s = spec[:, sel]
    flatness = np.exp(np.mean(np.log(s), axis=1)) / np.mean(s, axis=1)
    centroid = (spec[:, sel] * freqs[sel]).sum(axis=1) / spec[:, sel].sum(axis=1)
    band_db = np.stack([10 * np.log10(spec[:, a:b].sum(axis=1) + 1e-12) for a, b in bands], axis=1)
    zcr = np.mean(np.abs(np.diff(np.signbit(block), axis=1)), axis=1)
    # Envelope modulation inside the hop (20 ms frames): speech has syllabic bursts and
    # pauses (high variation); steady tones/music beds are flat.
    frames = block[:, : (HOP // 320) * 320].reshape(block.shape[0], -1, 320)
    env = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=2) + 1e-12)
    env_cv = env.std(axis=1) / (env.mean(axis=1) + 1e-9)
    return {
        "db": db.astype(np.float32),
        "low": low.astype(np.float32),
        "voice": voice.astype(np.float32),
        "high": high.astype(np.float32),
        "flatness": flatness.astype(np.float32),
        "centroid": centroid.astype(np.float32),
        "zcr": zcr.astype(np.float32),
        "env_cv": env_cv.astype(np.float32),
        "band_db": band_db.astype(np.float32),
    }


def compute_features(wav_path, on_progress=None, block_seconds=60):
    """Stream the WAV and compute features for every 0.5 s hop."""
    parts = {k: [] for k in ("db", "low", "voice", "high", "flatness", "centroid", "zcr", "env_cv", "band_db")}
    with wave.open(wav_path, "rb") as wav:
        if wav.getframerate() != SR or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError("WAV inesperado (precisa ser 16 kHz mono 16-bit)")
        total = wav.getnframes()
        per_block = int(block_seconds / HOP_S) * HOP
        read = 0
        while read < total:
            raw = wav.readframes(per_block)
            if not raw:
                break
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            read += len(samples)
            n = len(samples) // HOP
            rem = len(samples) - n * HOP
            if rem > HOP // 4:  # keep a final partial hop (zero-padded)
                samples = np.concatenate([samples, np.zeros(HOP - rem, dtype=np.float32)])
                n += 1
            if n == 0:
                break
            feats = hop_features(samples[: n * HOP].reshape(n, HOP))
            for k, v in feats.items():
                parts[k].append(v)
            if on_progress:
                on_progress(read / max(1, total))
    if not parts["db"]:
        return empty_features(0)
    out = {k: np.concatenate(v) for k, v in parts.items()}
    band = out.pop("band_db")
    flux = np.zeros(len(out["db"]), dtype=np.float32)
    if len(band) > 1:
        flux[1:] = np.maximum(band[1:] - band[:-1], 0).mean(axis=1)
    out["flux"] = flux
    return out


def empty_features(n):
    z = np.zeros(n, dtype=np.float32)
    return {"db": z - 90, "low": z, "voice": z, "high": z, "flatness": z, "centroid": z, "zcr": z, "env_cv": z, "flux": z}


def rolling_median(x, win):
    """Rolling median with a coarse stride (fast for 30k+ hops)."""
    n = len(x)
    if n == 0:
        return x
    stride = max(1, win // 8)
    centers = np.arange(0, n, stride)
    vals = np.array([np.median(x[max(0, c - win // 2): min(n, c + win // 2 + 1)]) for c in centers], dtype=np.float32)
    return np.interp(np.arange(n), centers, vals).astype(np.float32)


def derive_signals(feat):
    """Turn raw features into interpretable per-hop signals (absolute, not percentiles)."""
    db = feat["db"]
    n = len(db)
    if n == 0:
        return {}
    baseline = rolling_median(db, int(120 / HOP_S))  # local level over 2 minutes
    rel = db - baseline  # dB above the local level
    silent = (db < -50) | (rel < -12)
    # Sustained loud & steady sound (music / constant game noise), measured over 10 s.
    k = int(10 / HOP_S)
    if n >= k:
        kernel = np.ones(k) / k
        mean = np.convolve(rel, kernel, mode="same")
        sq = np.convolve(rel ** 2, kernel, mode="same")
        std = np.sqrt(np.maximum(sq - mean ** 2, 0))
        steady_loud = (mean > 5) & (std < 2.0)
    else:
        steady_loud = np.zeros(n, dtype=bool)
    # Impulsive impact (explosion / crash / gunshot): sudden rise vs the previous 1.5 s,
    # noise-like (not a pure tone) and not voice-dominated.
    prev_max = np.full(n, -120.0, dtype=np.float32)
    for lag in (1, 2, 3):
        prev_max[lag:] = np.maximum(prev_max[lag:], db[:-lag])
    jump = db - prev_max
    noisy = np.clip((feat["flatness"] - 0.03) / 0.05, 0, 1)
    nonvoice = np.clip((0.62 - feat["voice"]) / 0.3, 0, 1)
    burst = np.clip((jump - 10.0) / 15.0, 0, 1) * noisy * nonvoice * (rel > 6)
    # Voice-like (used only when there is no transcript): voice band dominates, tonal,
    # syllabic envelope modulation, not a steady bed.
    env_cv = feat.get("env_cv", np.ones(n, dtype=np.float32))
    voice_like = (feat["voice"] > 0.5) & (feat["flatness"] < 0.35) & (env_cv > 0.3) & ~silent & ~steady_loud
    return {
        "db": db,
        "rel": rel.astype(np.float32),
        "silent": silent,
        "burst": burst.astype(np.float32),
        "voice_like": voice_like,
        "steady_loud": steady_loud,
    }


def quiet_points(db, every_s, search_s):
    """Chunk boundaries for transcription placed at the quietest hop near each nominal cut."""
    n = len(db)
    step = int(every_s / HOP_S)
    search = int(search_s / HOP_S)
    cuts = [0]
    pos = step
    while pos < n - step // 3:
        a, b = max(cuts[-1] + 1, pos - search), min(n - 1, pos + search)
        cut = a + int(np.argmin(db[a:b])) if b > a else pos
        cuts.append(cut)
        pos = cut + step
    cuts.append(n)
    return [(c * HOP_S) for c in cuts]
