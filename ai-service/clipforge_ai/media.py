"""FFmpeg/FFprobe helpers shared by the analysis modules."""
import hashlib
import json
import os
import subprocess

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def run(cmd, **kwargs):
    return subprocess.run(cmd, creationflags=CREATE_NO_WINDOW, **kwargs)


def popen(cmd, **kwargs):
    return subprocess.Popen(cmd, creationflags=CREATE_NO_WINDOW, **kwargs)


def probe(ffprobe, path):
    result = run(
        [ffprobe, "-v", "error", "-show_entries",
         "format=duration,size:stream=index,codec_type,width,height,avg_frame_rate",
         "-of", "json", path],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(result.stdout or "{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    return {
        "duration": float(data.get("format", {}).get("duration") or 0),
        "size": int(data.get("format", {}).get("size") or os.path.getsize(path)),
        "hasVideo": video is not None,
        "hasAudio": len(audio) > 0,
        "width": int(video.get("width") or 0) if video else 0,
        "height": int(video.get("height") or 0) if video else 0,
    }


def fingerprint(path, sample=1 << 20):
    """Content fingerprint (size + three 1 MB samples). Fast even for 20 GB files."""
    size = os.path.getsize(path)
    h = hashlib.sha1(str(size).encode())
    with open(path, "rb") as f:
        for pos in (0, max(0, size // 2 - sample // 2), max(0, size - sample)):
            f.seek(pos)
            h.update(f.read(sample))
    return h.hexdigest()[:20]
