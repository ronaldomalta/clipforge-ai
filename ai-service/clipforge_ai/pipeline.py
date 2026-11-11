"""Analysis orchestrator: runs the stages, caches expensive results, writes analysis.json."""
import json
import os
import shutil
import time

import numpy as np

from . import ENGINE, __version__
from . import audio as A
from . import transcribe as T
from . import vision as V
from .media import fingerprint
from .progress import Progress, log
from .scoring import Timeline, select

CACHE_VERSION = "v1"


def _cache_paths(cfg, fp):
    root = os.path.join(cfg["cache_dir"], f"{fp}-{CACHE_VERSION}")
    os.makedirs(root, exist_ok=True)
    lang = cfg.get("language") or "auto"
    return {
        "root": root,
        "audio": os.path.join(root, "audio.npz"),
        "vision": os.path.join(root, "vision.npz"),
        "transcript": os.path.join(root, f"transcript-{cfg.get('model') or 'base'}-{lang}.json"),
    }


def _save_npz(path, data):
    tmp = path + ".tmp.npz"
    np.savez_compressed(tmp, **data)
    os.replace(tmp, path)


def run(cfg):
    t0 = time.time()
    media = cfg["media"]
    duration = float(media["duration"])
    source = cfg["input"]
    work = cfg["work_dir"]
    os.makedirs(work, exist_ok=True)
    warnings = []
    capabilities = {"audio": bool(media.get("hasAudio")), "transcription": False, "vision": False, "gpu": False}

    fp = fingerprint(source)
    cache = _cache_paths(cfg, fp)
    want_transcript = bool(cfg.get("transcribe")) and media.get("hasAudio")
    whisper_ok = T.available()
    if want_transcript and not whisper_ok:
        warnings.append("faster-whisper não está instalado: sem transcrição (legendas e análise de fala desativadas).")
    if want_transcript and whisper_ok and not cfg.get("allow_download") and not T.model_cached(cfg.get("model") or "base"):
        warnings.append(f"Modelo Whisper '{cfg.get('model')}' ainda não foi baixado. Baixe-o em Configurações → Diagnóstico (ou permita o download) para ter transcrição e legendas.")
        want_transcript = False
    want_vision = bool(cfg.get("vision", True)) and bool(cfg.get("smart")) and media.get("hasVideo")

    need_audio = media.get("hasAudio") and not os.path.exists(cache["audio"])
    need_tx = want_transcript and whisper_ok and not os.path.exists(cache["transcript"])
    need_wav = need_audio or need_tx
    stages = []
    if need_wav:
        stages.append(("extract", max(1.0, duration / 3600 * 2)))
    if need_audio:
        stages.append(("features", max(0.3, duration / 3600 * 0.6)))
    if need_tx:
        stages.append(("transcribe", max(2.0, duration / 3600 * 12)))
    if want_vision and not os.path.exists(cache["vision"]):
        stages.append(("vision", max(0.5, duration / 3600 * 3)))
    if cfg.get("smart"):
        stages.append(("select", 1.5))
    progress = Progress(stages or [("select", 1)])

    wav = os.path.join(work, "audio16k.wav")
    audio_sig = None
    segments = None
    language = None
    device = None
    try:
        if need_wav:
            progress.update("extract", 0, "Extraindo áudio...", force=True)
            A.extract_wav(cfg["ffmpeg"], source, wav, duration, on_progress=lambda f: progress.update("extract", f, "Extraindo áudio...", f * duration, duration))

        if media.get("hasAudio"):
            if os.path.exists(cache["audio"]):
                feats = dict(np.load(cache["audio"]))
                log("Características de áudio carregadas do cache.")
            else:
                progress.update("features", 0, "Analisando áudio...", force=True)
                feats = A.compute_features(wav, on_progress=lambda f: progress.update("features", f, "Analisando áudio...", f * duration, duration))
                _save_npz(cache["audio"], feats)
            audio_sig = A.derive_signals(feats)
        else:
            feats = None

        if want_transcript and whisper_ok:
            if os.path.exists(cache["transcript"]):
                with open(cache["transcript"], encoding="utf-8") as f:
                    tx = json.load(f)
                log("Transcrição reaproveitada do cache (Whisper não foi executado de novo).")
            else:
                progress.update("transcribe", 0, "Transcrevendo...", force=True)
                try:
                    tx = T.transcribe(wav, feats["db"] if feats is not None else np.zeros(0), cfg,
                                      lambda f, done, total: progress.update("transcribe", f, "Transcrevendo...", done, total))
                    with open(cache["transcript"] + ".tmp", "w", encoding="utf-8") as f:
                        json.dump(tx, f, ensure_ascii=False)
                    os.replace(cache["transcript"] + ".tmp", cache["transcript"])
                except T.ModelNotDownloaded as exc:
                    warnings.append(str(exc))
                    tx = None
                except Exception as exc:  # noqa: BLE001
                    warnings.append(f"A transcrição falhou: {str(exc)[:300]}")
                    tx = None
            if tx is not None:
                segments = tx["segments"]
                language = tx.get("language")
                device = tx.get("device")
                warnings.extend(tx.get("warnings", []))
                capabilities["transcription"] = True
                capabilities["gpu"] = device == "cuda"
                if not segments:
                    warnings.append("Nenhuma fala detectada no vídeo.")
    finally:
        if os.path.exists(wav):
            os.remove(wav)

    vis_act = vis_scene = signature = None
    if want_vision:
        try:
            if os.path.exists(cache["vision"]):
                vc = dict(np.load(cache["vision"]))
            else:
                progress.update("vision", 0, "Analisando eventos visuais...", force=True)
                vc = V.coarse_pass(cfg["ffmpeg"], source, duration)
                vc = {k: v for k, v in vc.items() if k != "method"}
                _save_npz(cache["vision"], vc)
                progress.update("vision", 1, "Analisando eventos visuais...", force=True)
            n_hops = int(np.ceil(duration / A.HOP_S))
            vis_act, vis_scene = V.coarse_to_hops(vc, n_hops, A.HOP_S)
            signature = (vc["times"], vc["sig"])
            capabilities["vision"] = True
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Análise visual indisponível: {str(exc)[:200]}")

    moments, stats = [], {}
    insufficient, message = False, None
    if cfg.get("smart"):
        progress.update("select", 0, "Identificando melhores momentos...", force=True)
        tl = Timeline(duration, audio_sig, segments, vis_act, vis_scene, signature)
        fine_fn = (lambda s, e: V.fine_pass(cfg["ffmpeg"], source, s, e)) if capabilities["vision"] else None
        moments, stats = select(
            tl, int(cfg.get("count") or 5), cfg.get("duration") or 30, cfg.get("weights"), float(cfg.get("min_score", 50)),
            fine_fn=fine_fn, language=language,
            on_progress=lambda f: progress.update("select", f, "Identificando melhores momentos..."),
        )
        want = int(cfg.get("count") or 5)
        if len(moments) == 0:
            insufficient = True
            message = "Nenhum trecho atingiu a nota mínima. Nenhum clipe foi gerado para não inventar destaques."
        elif len(moments) < want:
            insufficient = True
            message = f"Só {len(moments)} de {want} momentos atingiram a nota mínima ({cfg.get('min_score', 50):.0f}). Os demais não foram gerados para não inventar destaques."

    result = {
        "version": __version__,
        "engine": ENGINE,
        "request_hash": cfg.get("request_hash"),
        "language": language,
        "model": cfg.get("model") if capabilities["transcription"] else None,
        "device": device,
        "duration": round(duration, 2),
        "capabilities": capabilities,
        "warnings": warnings,
        "segments": segments,
        "moments": moments,
        "insufficient": insufficient,
        "message": message,
        "stats": {**stats, "seconds": round(time.time() - t0, 1), "fingerprint": fp},
    }
    tmp = cfg["output"] + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, cfg["output"])
    return result


def clear_cache(cache_dir):
    if os.path.isdir(cache_dir):
        shutil.rmtree(cache_dir, ignore_errors=True)
