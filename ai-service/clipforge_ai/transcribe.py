"""Chunked faster-whisper transcription with word timestamps, GPU→CPU fallback and caching.

Audio is read from the 16 kHz WAV in ~5-minute chunks cut at quiet points, so a 4-hour
recording never needs more than ~20 MB of samples in RAM at once.
"""
import os
import wave

import numpy as np

from .audio import SR, quiet_points

MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}

HALLUCINATIONS = {
    "obrigado por assistir", "obrigado.", "legendas pela comunidade amara.org", "thanks for watching!",
    "thank you for watching.", "inscreva-se no canal", "subtitles by the amara.org community", "♪",
}


def available():
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:  # pragma: no cover - depends on install
        return False


def model_cached(name):
    repo = MODEL_REPOS.get(name)
    if not repo:
        return False
    try:
        from huggingface_hub import try_to_load_from_cache
        found = try_to_load_from_cache(repo, "model.bin")
        return isinstance(found, str) and os.path.exists(found)
    except Exception:
        return False


def cuda_devices():
    try:
        import ctranslate2
        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def load_model(name, device_pref, allow_download):
    from faster_whisper import WhisperModel

    local_only = not allow_download
    attempts = []
    if device_pref in ("auto", "cuda") and cuda_devices() > 0:
        attempts.append(("cuda", "int8_float16"))
        attempts.append(("cuda", "float16"))
    if device_pref != "cuda" or not attempts:
        attempts.append(("cpu", "int8"))
    if device_pref == "cuda":
        attempts.append(("cpu", "int8"))
    errors = []
    threads = max(1, (os.cpu_count() or 4) - 1)
    for device, compute in attempts:
        try:
            model = WhisperModel(name, device=device, compute_type=compute, cpu_threads=threads, local_files_only=local_only)
            return model, device, compute, errors
        except Exception as exc:  # pragma: no cover - hardware dependent
            msg = str(exc)
            if local_only and ("local" in msg.lower() or "snapshot" in msg.lower() or "not found" in msg.lower() or "cannot find" in msg.lower()):
                raise ModelNotDownloaded(name) from exc
            errors.append(f"{device}/{compute}: {msg[:160]}")
    raise RuntimeError("Não foi possível carregar o Whisper: " + " | ".join(errors))


class ModelNotDownloaded(RuntimeError):
    def __init__(self, name):
        super().__init__(f"Modelo Whisper '{name}' não está baixado. Baixe em Configurações → Diagnóstico ou permita o download.")
        self.model = name


def _read_chunk(wav_path, start_s, end_s):
    with wave.open(wav_path, "rb") as wav:
        a = int(start_s * SR)
        b = min(wav.getnframes(), int(end_s * SR))
        wav.setpos(min(a, wav.getnframes()))
        raw = wav.readframes(max(0, b - a))
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def _clean_segment(seg, offset):
    text = (seg.text or "").strip()
    if not text:
        return None
    if text.lower() in HALLUCINATIONS:
        return None
    if getattr(seg, "no_speech_prob", 0) > 0.7 and getattr(seg, "avg_logprob", 0) < -1.0:
        return None
    if getattr(seg, "compression_ratio", 0) > 2.6:
        return None
    words = []
    for w in getattr(seg, "words", None) or []:
        token = (w.word or "").strip()
        if token:
            words.append({"start": round(w.start + offset, 2), "end": round(w.end + offset, 2), "word": token, "p": round(float(w.probability or 0), 2)})
    return {"start": round(seg.start + offset, 2), "end": round(seg.end + offset, 2), "text": text, "words": words}


def transcribe(wav_path, db_per_hop, cfg, progress):
    """Returns dict(segments, language, device, compute, warnings)."""
    name = cfg.get("model") or "base"
    model, device, compute, load_errors = load_model(name, cfg.get("device") or "auto", bool(cfg.get("allow_download")))
    warnings = []
    if load_errors and device == "cpu":
        warnings.append("GPU indisponível para o Whisper; transcrição executada na CPU.")
    lang_pref = cfg.get("language") or "auto"
    language = None if lang_pref == "auto" else lang_pref

    total = len(db_per_hop) * 0.5
    bounds = quiet_points(db_per_hop, every_s=300, search_s=20) if len(db_per_hop) else [0.0, total]
    segments = []
    detected = None
    for i in range(len(bounds) - 1):
        start_s, end_s = bounds[i], bounds[i + 1]
        audio = _read_chunk(wav_path, start_s, end_s)
        if len(audio) < SR // 2:
            continue
        # Skip chunks that are pure silence (saves time on long AFK parts).
        if float(np.sqrt(np.mean(audio ** 2))) < 10 ** (-55 / 20):
            progress(end_s / total, start_s, total)
            continue
        kwargs = dict(
            language=language or detected,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            word_timestamps=True,
            beam_size=5 if device == "cuda" else 3,
            condition_on_previous_text=False,
        )
        try:
            seg_iter, info = model.transcribe(audio, **kwargs)
            chunk = []
            for seg in seg_iter:
                cleaned = _clean_segment(seg, start_s)
                if cleaned:
                    chunk.append(cleaned)
                progress((start_s + seg.end) / total, start_s + seg.end, total)
        except Exception as exc:  # pragma: no cover - hardware dependent
            if device != "cuda":
                raise
            warnings.append(f"Falha na GPU durante a transcrição ({str(exc)[:120]}); continuando na CPU.")
            model, device, compute, _ = load_model(name, "cpu", bool(cfg.get("allow_download")))
            seg_iter, info = model.transcribe(audio, **{**kwargs, "beam_size": 3})
            chunk = [c for c in (_clean_segment(s, start_s) for s in seg_iter) if c]
        if detected is None and language is None and getattr(info, "language_probability", 0) >= 0.5 and chunk:
            detected = info.language
        segments.extend(chunk)
        progress(end_s / total, end_s, total)

    # Remove consecutive duplicated lines (classic Whisper loop on noise).
    deduped = []
    for seg in segments:
        if deduped and seg["text"] == deduped[-1]["text"] and seg["start"] - deduped[-1]["end"] < 2:
            deduped[-1]["end"] = seg["end"]
            continue
        deduped.append(seg)
    return {
        "segments": deduped,
        "language": language or detected,
        "device": device,
        "compute": compute,
        "warnings": warnings,
    }
