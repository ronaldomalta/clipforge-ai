"""Candidate detection, explainable 0–100 scoring and selection of highlight windows.

Highlight score (conceptual):
    positive = weighted mix of  audio energy, speech relevance, emotional reaction,
               visual action, context, scene dynamics           (each 0..1, absolute scales)
    score    = 100·(1 − e^(−2.3·raw)) − penalties(silence, loud-only, repetition)

Components use ABSOLUTE scales (dB above the local level, pixel differences, lexical
hits) instead of per-video percentiles, so a flat, uneventful recording gets low scores
and the selector returns fewer clips instead of inventing highlights.
"""
import math
import re
import unicodedata

import numpy as np

from .semantic import analyze_text, normalize
from .titles import make_title

HOP = 0.5
DEFAULT_WEIGHTS = {
    "audio": 1.0, "speech": 1.2, "reaction": 1.4, "visual": 1.0, "context": 0.6, "scene": 0.5,
    "silencePenalty": 1.0, "repetitionPenalty": 1.0, "loudOnlyPenalty": 1.0,
}
POSITIVE = ["audio", "speech", "reaction", "visual", "context", "scene"]


def _smooth(x, hops):
    if len(x) == 0 or hops <= 1:
        return x
    k = np.ones(hops, dtype=np.float32) / hops
    return np.convolve(x, k, mode="same").astype(np.float32)


class Timeline:
    """All per-hop signals for the video, built from audio, transcript and coarse vision."""

    def __init__(self, duration, audio_sig=None, segments=None, vis_act=None, vis_scene=None, signature=None):
        self.duration = float(duration)
        n = max(1, int(math.ceil(self.duration / HOP)))
        self.n = n
        z = np.zeros(n, dtype=np.float32)

        def fit(arr, fill=0.0):
            if arr is None:
                return np.full(n, fill, dtype=np.float32)
            arr = np.asarray(arr, dtype=np.float32)
            if len(arr) >= n:
                return arr[:n]
            return np.concatenate([arr, np.full(n - len(arr), fill, dtype=np.float32)])

        self.has_audio = audio_sig is not None and len(audio_sig.get("rel", [])) > 0
        self.rel = fit(audio_sig.get("rel") if self.has_audio else None)
        self.silent = fit(audio_sig.get("silent") if self.has_audio else None, 1.0 if not self.has_audio else 0.0) > 0.5
        self.burst = fit(audio_sig.get("burst") if self.has_audio else None)
        self.voice_like = fit(audio_sig.get("voice_like") if self.has_audio else None) > 0.5
        self.steady = fit(audio_sig.get("steady_loud") if self.has_audio else None) > 0.5
        self.segments = segments or []
        self.has_transcript = segments is not None
        self.speech = np.zeros(n, dtype=bool)
        self.lex = z.copy()
        self.seg_info = []
        for seg in self.segments:
            a, b = int(seg["start"] / HOP), int(math.ceil(seg["end"] / HOP))
            a, b = max(0, a), min(n, max(a + 1, b))
            self.speech[a:b] = True
            info = analyze_text(seg["text"])
            self.seg_info.append(info)
            if info["score"] > 0:
                self.lex[a:b] = np.maximum(self.lex[a:b], min(1.0, info["score"] / 10.0))
        self.voice = self.speech if self.has_transcript else self.voice_like
        self.vis = fit(vis_act)
        self.has_vision = vis_act is not None and len(vis_act) > 0
        self.scene = fit(vis_scene)
        self.signature = signature  # (times, hists) from the coarse pass
        a_rel = np.clip(self.rel / 12.0, 0, 1)
        self.reaction_hop = self.voice * np.clip((self.rel - 4.0) / 10.0, 0, 1)
        vis_n = np.clip((self.vis - 6.0) / 24.0, 0, 1)
        energy = 0.8 * a_rel + 1.3 * self.reaction_hop + 1.1 * self.lex + 0.9 * vis_n + 0.6 * self.burst + 0.3 * self.scene
        energy = np.where(self.steady & ~self.voice, energy * 0.6, energy)
        self.energy = _smooth(energy.astype(np.float32), 4)


def find_peaks(energy, k, min_sep_hops, floor=0.05):
    order = np.argsort(-energy)
    taken = np.zeros(len(energy), dtype=bool)
    peaks = []
    for i in order:
        if energy[i] < floor or len(peaks) >= k:
            break
        if taken[i]:
            continue
        peaks.append(int(i))
        taken[max(0, i - min_sep_hops): i + min_sep_hops + 1] = True
    return peaks


def _onset_and_reaction(tl, peak):
    e = tl.energy
    pv = e[peak] if e[peak] > 0 else 1e-6
    onset = peak
    for i in range(peak, max(-1, peak - int(12 / HOP)), -1):
        if e[i] < 0.35 * pv:
            break
        onset = i
    react = peak
    gap = 0
    for i in range(peak, min(tl.n, peak + int(10 / HOP))):
        active = (tl.voice[i] and tl.rel[i] > 2) or e[i] > 0.5 * pv
        if active:
            react = i
            gap = 0
        else:
            gap += 1
            if gap > int(1.5 / HOP):
                break
    return onset * HOP, (react + 1) * HOP


def _snap(tl, s, e, tol):
    for seg in tl.segments:
        if seg["start"] < s < seg["end"]:
            if s - seg["start"] <= tol:
                s = seg["start"] - 0.15
            elif seg["end"] - s <= tol:
                s = seg["end"] + 0.05
            break
    for seg in tl.segments:
        if seg["start"] < e < seg["end"]:
            if seg["end"] - e <= tol:
                e = seg["end"] + 0.3
            elif e - seg["start"] <= tol:
                e = seg["start"] - 0.05
            break
    return s, e


def make_window(tl, peak, duration):
    """Place a window around a peak keeping the build-up and the full reaction."""
    total = tl.duration
    pt = peak * HOP
    onset, react_end = _onset_and_reaction(tl, peak)
    if duration == "auto":
        s, e = onset - 3.0, react_end + 2.0
        if e - s < 12:
            pad = 12 - (e - s)
            s -= pad * 0.6
            e += pad * 0.4
        if e - s > 75:
            s, e = pt - 45, pt + 30
        tol = 2.0
        target = None
    else:
        D = float(duration)
        s = pt - 0.55 * D
        if s > onset - 1.5:
            s = onset - 1.5
        e = s + D
        if e < react_end + 1.0:
            s = react_end + 1.0 - D
            e = s + D
        tol = min(3.0, 0.15 * D)
        target = D
    s, e = max(0.0, s), min(total, e)
    if target is not None and e - s < target:  # pinned at a video edge
        if s == 0.0:
            e = min(total, target)
        else:
            s = max(0.0, e - target)
    s2, e2 = _snap(tl, s, e, tol)
    s2, e2 = max(0.0, s2), min(total, e2)
    if target is None or abs((e2 - s2) - target) <= tol:
        s, e = s2, e2
    return round(s, 2), round(e, 2), round(pt, 2)


def window_components(tl, s, e, peak_t, fine=None):
    a, b = int(s / HOP), max(int(s / HOP) + 1, int(math.ceil(e / HOP)))
    b = min(b, tl.n)
    rel = tl.rel[a:b]
    comps = {}
    detail = {}
    rel_p90 = float(np.percentile(rel, 90)) if len(rel) and tl.has_audio else 0.0
    burst = float(tl.burst[a:b].max()) if b > a else 0.0
    comps["audio"] = max(float(np.clip(rel_p90 / 12.0, 0, 1)), 0.8 * burst)
    comps["burst"] = burst
    detail["rel_db_p90"] = round(rel_p90, 1)
    comps["reaction"] = float(tl.reaction_hop[a:b].max()) if b > a else 0.0
    react_idx = int(np.argmax(tl.reaction_hop[a:b])) + a if b > a else a
    detail["reaction_db"] = round(float(tl.rel[react_idx]), 1) if tl.has_audio else 0.0

    lex_total = 0.0
    hits, laughs, exclam = [], 0, 0
    texts = []
    for seg, info in zip(tl.segments, tl.seg_info):
        if seg["end"] <= s or seg["start"] >= e:
            continue
        overlap = (min(e, seg["end"]) - max(s, seg["start"])) / max(0.1, seg["end"] - seg["start"])
        lex_total += info["score"] * overlap
        laughs += info["laughs"]
        exclam += info["exclamations"]
        texts.append(seg["text"])
        for h in info["hits"]:
            hits.append((h, seg["text"]))
    comps["speech"] = float(1 - math.exp(-lex_total / 6.0))
    detail.update({"lexical": round(lex_total, 1), "laughs": laughs, "exclamations": exclam})

    vis_coarse = float(np.clip((np.percentile(tl.vis[a:b], 90) - 6.0) / 24.0, 0, 1)) if tl.has_vision and b > a else 0.0
    events = []
    visual = vis_coarse
    if fine:
        visual = max(visual, float(np.clip((fine["motion_p90"] - 3.0) / 12.0, 0, 1)))
        events = [ev for ev in fine["events"] if s <= ev["t"] <= e]
        for ev in events:
            if ev["type"] == "flash":
                visual = min(1.0, visual + 0.25 * ev["strength"])
            elif ev["type"] == "desaturate":
                visual = min(1.0, visual + 0.2 * ev["strength"])
        detail["motion_p90"] = round(fine["motion_p90"], 1)
    comps["visual"] = visual
    scenes = float(tl.scene[a:b].sum()) if b > a else 0.0
    comps["scene"] = float(np.clip(scenes / max(1.0, (e - s) / 15.0), 0, 1))
    detail["scene_changes"] = int(scenes)

    active = (tl.voice[a:b] | (tl.rel[a:b] > 3) | (tl.vis[a:b] > 8)) if b > a else np.zeros(0, bool)
    coverage = float(active.mean()) if len(active) else 0.0
    pk = int(peak_t / HOP)
    before = bool(tl.voice[max(a, pk - int(8 / HOP)): pk].any()) if pk > a else False
    after = bool(tl.voice[pk: min(b, pk + int(8 / HOP))].any())
    comps["context"] = 0.7 * coverage + 0.3 * (1.0 if before and after else 0.0)
    detail["context_both_sides"] = before and after

    silent = tl.silent[a:b] & ~tl.voice[a:b] & (tl.vis[a:b] < 4) if b > a else np.zeros(0, bool)
    silence_frac = float(silent.mean()) if len(silent) else 0.0
    steady_frac = float(tl.steady[a:b].mean()) if b > a else 0.0
    loud_only = comps["audio"] > 0.5 and comps["speech"] < 0.2 and comps["reaction"] < 0.25 and comps["visual"] < 0.25
    pens = {
        "silence": max(0.0, silence_frac - 0.2) * 0.8,
        "loudOnly": (0.25 if loud_only else 0.0) + (0.1 if steady_frac > 0.6 and comps["speech"] < 0.2 else 0.0),
        "repetition": 0.0,
    }
    detail["silence_frac"] = round(silence_frac, 2)
    return comps, pens, detail, events, hits, " ".join(texts)


def combine(comps, pens, weights):
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    total_w = sum(w[k] for k in POSITIVE) or 1.0
    mean_w = sum(w[k] * comps[k] for k in POSITIVE) / total_w
    top = sorted((comps[k] for k in POSITIVE if k != "context"), reverse=True)[:2]
    raw = 0.6 * mean_w + 0.4 * (sum(top) / 2.0)
    score = 100.0 * (1.0 - math.exp(-2.3 * raw))
    score -= 100.0 * (w["silencePenalty"] * pens["silence"] + w["loudOnlyPenalty"] * pens["loudOnly"] + w["repetitionPenalty"] * pens["repetition"])
    return max(0.0, min(99.0, score))


def _display_phrase(phrase, text):
    """Recover the accented original spelling of a lexicon phrase from the transcript."""
    orig = unicodedata.normalize("NFC", text)
    norm = "".join(c for c in unicodedata.normalize("NFD", orig.lower()) if unicodedata.category(c) != "Mn")
    if len(norm) == len(orig):
        m = re.search(r"(?<![a-z0-9])" + re.escape(phrase) + r"(?![a-z0-9])", norm)
        if m:
            return orig[m.start(): m.end()].lower()
    return phrase


def explain(comps, pens, detail, events, hits, has_transcript):
    reasons, penalties = [], []
    if comps["reaction"] >= 0.45:
        src = "voz" if has_transcript else "voz (estimada pelo áudio)"
        reasons.append(f"Reação intensa do jogador: {src} {detail['reaction_db']:+.0f} dB acima do nível local.")
    if comps["audio"] >= 0.5 and detail["rel_db_p90"] >= 6:
        reasons.append(f"Pico de áudio: {detail['rel_db_p90']:+.0f} dB acima do nível dos 2 minutos ao redor.")
    if comps.get("burst", 0) >= 0.4:
        reasons.append("Som de impacto/explosão no áudio (ruído súbito de banda larga).")
    if hits:
        seen = []
        for h, text in sorted(hits, key=lambda x: -LEX_WEIGHT(x[0])):
            disp = _display_phrase(h["phrase"], text)
            if disp not in seen:
                seen.append(disp)
        quoted = ", ".join(f"“{p}”" for p in seen[:4])
        reasons.append(f"Expressões de reação na fala: {quoted}.")
    if detail.get("laughs"):
        reasons.append("Risadas identificadas na transcrição.")
    if detail.get("exclamations", 0) >= 2 and not hits:
        reasons.append("Fala exclamativa (várias exclamações na transcrição).")
    if comps["visual"] >= 0.45:
        reasons.append("Movimento visual elevado na gameplay.")
    types = {}
    for ev in events:
        types.setdefault(ev["type"], ev)
    if "flash" in types:
        reasons.append("Clarão súbito na imagem (possível explosão ou disparo).")
    if "desaturate" in types:
        reasons.append("A imagem perde a cor de repente (comum em morte ou fim de ação).")
    if comps["scene"] >= 0.5:
        reasons.append(f"Dinâmica de cena: {detail['scene_changes']} mudança(s) de cena no trecho.")
    if detail.get("context_both_sides"):
        reasons.append("Há fala antes e depois do pico: o contexto e a reação estão no corte.")
    if pens["silence"] > 0:
        penalties.append(f"Trecho com {round(detail['silence_frac'] * 100)}% de silêncio sem ação.")
    if pens["loudOnly"] > 0:
        penalties.append("Volume alto sem fala, reação ou ação visual (provável música/ruído constante).")
    if pens["repetition"] > 0:
        penalties.append("Parecido com outro clipe já selecionado.")
    if not reasons:
        reasons.append("Sinais fracos: selecionado apenas por estar acima da nota mínima.")
    return reasons, penalties


def LEX_WEIGHT(hit):
    from .semantic import LEXICON
    return LEXICON.get(hit["phrase"], (0, ""))[0]


def _words(text):
    return {w for w in re.findall(r"[a-z0-9]+", normalize(text)) if len(w) > 3}


def _signature(tl, s, e):
    if not tl.signature:
        return None
    times, hists = tl.signature
    if len(times) == 0:
        return None
    mask = (times >= s) & (times <= e)
    if not mask.any():
        return None
    v = hists[mask].mean(axis=0)
    return v / (np.linalg.norm(v) + 1e-9)


def similarity(tl, a, b):
    wa, wb = _words(a["transcript"]), _words(b["transcript"])
    jac = len(wa & wb) / len(wa | wb) if wa and wb else 0.0
    vis = 0.0
    sa, sb = a.get("_sig"), b.get("_sig")
    if sa is not None and sb is not None and abs(a["peak"] - b["peak"]) < 120:
        cos = float(np.dot(sa, sb))
        vis = 0.6 if cos > 0.995 else 0.0
    return max(jac, vis)


def select(tl, count, duration, weights, min_score, fine_fn=None, language=None, on_progress=None):
    """Return (moments, stats). `fine_fn(start, end)` runs the fine vision pass (optional)."""
    weights = {**DEFAULT_WEIGHTS, **(weights or {})}
    short_video = duration != "auto" and tl.duration <= float(duration) * 1.2
    if short_video:
        candidates = [(0.0, tl.duration, float(np.argmax(tl.energy)) * HOP)]
    else:
        sep = int(max(8.0, (30 if duration == "auto" else float(duration)) * 0.6) / HOP)
        k = int(min(120, max(count * 6, 24)))
        peaks = find_peaks(tl.energy, k, sep)
        candidates = [make_window(tl, p, duration) for p in peaks]

    scored = []
    for s, e, pt in candidates:
        comps, pens, detail, events, hits, text = window_components(tl, s, e, pt)
        scored.append({"start": s, "end": e, "peak": pt, "comps": comps, "pens": pens, "score": combine(comps, pens, weights), "transcript": text})
    scored.sort(key=lambda m: -m["score"])

    # Fine vision only on the best candidates.
    fine_budget = min(len(scored), max(6, int(count * 2.5)), 40)
    for i, m in enumerate(scored[:fine_budget]):
        fine = None
        if fine_fn:
            try:
                fine = fine_fn(m["start"], m["end"])
            except Exception as exc:  # noqa: BLE001 - vision is best-effort
                m["fine_error"] = str(exc)[:200]
        comps, pens, detail, events, hits, text = window_components(tl, m["start"], m["end"], m["peak"], fine)
        m.update({"comps": comps, "pens": pens, "detail": detail, "events": events, "hits": hits, "transcript": text,
                  "score": combine(comps, pens, weights), "track": fine["track"] if fine else []})
        if on_progress:
            on_progress((i + 1) / fine_budget)
    for m in scored[fine_budget:]:
        comps, pens, detail, events, hits, text = window_components(tl, m["start"], m["end"], m["peak"])
        m.update({"detail": detail, "events": events, "hits": hits, "track": []})
    for m in scored:
        m["_sig"] = _signature(tl, m["start"], m["end"])
    scored.sort(key=lambda m: -m["score"])

    chosen = []
    pool = list(scored)
    while pool and len(chosen) < count:
        best, best_score = None, -1.0
        for m in pool:
            rep = max((similarity(tl, m, c) for c in chosen), default=0.0)
            pens = {**m["pens"], "repetition": 0.25 * rep if rep >= 0.5 else 0.0}
            sc = combine(m["comps"], pens, weights)
            if sc > best_score:
                best, best_score, best_pens = m, sc, pens
        pool.remove(best)
        overlap = any(min(best["end"], c["end"]) - max(best["start"], c["start"]) > 0.25 * min(best["end"] - best["start"], c["end"] - c["start"]) for c in chosen)
        if overlap:
            continue
        if best_score < min_score and not short_video:
            break
        best["pens"] = best_pens
        best["score"] = best_score
        chosen.append(best)

    moments = []
    for m in sorted(chosen, key=lambda x: x["start"]):
        reasons, penalties = explain(m["comps"], m["pens"], m["detail"], m["events"], m["hits"], tl.has_transcript)
        if short_video:
            reasons.insert(0, "Vídeo mais curto que a duração escolhida: o clipe usa o vídeo inteiro.")
        moments.append({
            "start": m["start"], "end": m["end"], "peak": m["peak"], "score": int(round(m["score"])),
            "breakdown": {**{k: round(m["comps"][k], 2) for k in POSITIVE}, "penalties": {k: round(v, 2) for k, v in m["pens"].items()}},
            "reasons": reasons, "penalties": penalties,
            "title": make_title(tl.segments, m["start"], m["end"], m["comps"], m["events"], language),
            "transcript": m["transcript"][:600],
            "events": [{"type": ev["type"], "t": round(ev["t"], 2)} for ev in m["events"]],
            "crop_track": m["track"],
            "signals": m["detail"],
        })
    stats = {
        "candidates": len(scored),
        "fine_analyzed": fine_budget if fine_fn else 0,
        "selected": len(moments),
        "best_unselected": int(round(max((m["score"] for m in scored if all(m is not c for c in chosen)), default=0))),
    }
    return moments, stats
