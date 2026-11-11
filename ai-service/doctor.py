"""Environment report for the ClipForge diagnostics page (prints one JSON line).

    python doctor.py                 → JSON report
    python doctor.py --download base → explicitly download a Whisper model (user-initiated)
"""
import importlib
import json
import os
import platform
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def version_of(module):
    try:
        mod = importlib.import_module(module)
        return getattr(mod, "__version__", "ok")
    except Exception:
        return None


def report():
    data = {
        "python": platform.python_version(),
        "executable": sys.executable,
        "numpy": version_of("numpy"),
        "faster_whisper": version_of("faster_whisper"),
        "ctranslate2": version_of("ctranslate2"),
        "yt_dlp": None,
        "cuda_devices": 0,
        "models_cached": [],
    }
    try:
        from yt_dlp.version import __version__ as ytv
        data["yt_dlp"] = ytv
    except Exception:
        pass
    if data["ctranslate2"]:
        try:
            import ctranslate2
            data["cuda_devices"] = int(ctranslate2.get_cuda_device_count())
        except Exception:
            data["cuda_devices"] = 0
    if data["faster_whisper"]:
        try:
            from clipforge_ai.transcribe import MODEL_REPOS, model_cached
            data["models_cached"] = [name for name in MODEL_REPOS if model_cached(name)]
        except Exception:
            pass
    return data


def download(model):
    from clipforge_ai.transcribe import MODEL_REPOS
    if model not in MODEL_REPOS:
        raise SystemExit(f"Modelo desconhecido: {model}")
    from faster_whisper import download_model
    path = download_model(model)
    print(json.dumps({"downloaded": model, "path": path}))


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--download":
        download(sys.argv[2])
    else:
        print(json.dumps(report()))
