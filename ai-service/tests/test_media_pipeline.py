"""Tests that run real FFmpeg on real (generated) media files."""
import json
import os

import numpy as np
import pytest

from conftest import ffmpeg, needs_ffmpeg
from clipforge_ai import audio as A
from clipforge_ai import transcribe as T
from clipforge_ai import vision as V
from clipforge_ai.pipeline import run


@needs_ffmpeg
def test_audio_features_silence_tone_and_burst(tmp_path):
    src = tmp_path / "a.wav"
    # 0-10 s silence, 10-20 s steady loud tone, 20-30 s quiet noise with an impact at 25 s
    ffmpeg("-f", "lavfi", "-i", "aevalsrc='if(lt(t,10),0,if(lt(t,20),0.5*sin(2*PI*440*t),0.01*random(0)+if(between(t,25,25.6),0.9*random(1)-0.45,0)))':s=16000:d=30", str(src))
    wav = tmp_path / "x.wav"
    A.extract_wav("ffmpeg", str(src), str(wav), 30)
    feats = A.compute_features(str(wav))
    sig = A.derive_signals(feats)
    assert len(feats["db"]) == 60
    assert sig["silent"][2:18].all(), "first 10 s must be silent"
    assert sig["steady_loud"][28:36].any(), "steady tone must be flagged as steady"
    assert not sig["voice_like"][20:40].any(), "a pure tone is not a voice"
    assert sig["burst"][49:53].max() > 0.3, "impact at 25 s must be detected"


@needs_ffmpeg
def test_fine_pass_detects_flash_and_track(tmp_path):
    src = tmp_path / "v.mp4"
    ffmpeg("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=8",
           "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white@0.95:t=fill:enable='between(t,4,4.5)'", "-pix_fmt", "yuv420p", str(src))
    fine = V.fine_pass("ffmpeg", str(src), 0, 8)
    assert fine is not None
    assert any(e["type"] == "flash" and 3.5 <= e["t"] <= 5 for e in fine["events"])
    assert all(0.2 <= x <= 0.8 for _, x in fine["track"])


@needs_ffmpeg
def test_coarse_pass_keyframes(tmp_path):
    src = tmp_path / "v.mp4"
    ffmpeg("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=30", "-g", "60", "-pix_fmt", "yuv420p", str(src))
    coarse = V.coarse_pass("ffmpeg", str(src), 30)
    assert 10 <= len(coarse["times"]) <= 31
    act, scene = V.coarse_to_hops(coarse, 60)
    assert act.shape == (60,) and scene.shape == (60,)


def test_quiet_points_cut_at_silence():
    db = np.full(2400, -20.0, dtype=np.float32)  # 20 min
    db[610] = -80  # quiet at 305 s
    cuts = A.quiet_points(db, every_s=300, search_s=20)
    assert cuts[0] == 0 and cuts[-1] == 1200
    assert abs(cuts[1] - 305) < 0.6


@pytest.mark.skipif(not T.available(), reason="faster-whisper not installed")
def test_missing_model_is_reported_not_downloaded(monkeypatch):
    # Never download silently: with allow_download=False and no cached model we get a clear error.
    if T.model_cached("tiny"):
        pytest.skip("model already cached on this machine")
    with pytest.raises(T.ModelNotDownloaded):
        T.load_model("tiny", "cpu", allow_download=False)


@needs_ffmpeg
def test_video_without_audio(tmp_path):
    src = tmp_path / "silent.mp4"
    ffmpeg("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=40", "-pix_fmt", "yuv420p", str(src))
    out = tmp_path / "analysis.json"
    cfg = {"input": str(src), "output": str(out), "work_dir": str(tmp_path / "w"), "cache_dir": str(tmp_path / "c"),
           "ffmpeg": "ffmpeg", "ffprobe": "ffprobe", "count": 3, "duration": 15, "smart": True, "transcribe": True,
           "language": "auto", "model": "tiny", "device": "cpu", "allow_download": False, "vision": True, "min_score": 50,
           "weights": {}, "media": {"duration": 40, "hasAudio": False, "hasVideo": True}}
    result = run(cfg)
    assert result["capabilities"]["audio"] is False
    assert result["segments"] is None
    assert json.loads(out.read_text())["moments"] == result["moments"]


@needs_ffmpeg
@pytest.mark.slow
def test_end_to_end_fixture_finds_the_real_events(fixture_video, tmp_path):
    out = tmp_path / "analysis.json"
    cfg = {"input": fixture_video, "output": str(out), "work_dir": str(tmp_path / "w"), "cache_dir": str(tmp_path / "c"),
           "ffmpeg": "ffmpeg", "ffprobe": "ffprobe", "count": 5, "duration": 15, "smart": True, "transcribe": False,
           "language": "auto", "model": "tiny", "device": "cpu", "allow_download": False, "vision": True, "min_score": 50,
           "weights": {}, "media": {"duration": 300, "hasAudio": True, "hasVideo": True}}
    result = run(cfg)
    peaks = [m["peak"] for m in result["moments"]]
    # The two staged events (explosion+flash ≈120 s, chase ≈240 s) must be found.
    assert any(115 <= p <= 128 for p in peaks)
    assert any(234 <= p <= 248 for p in peaks)
    # The loud steady music (60–90 s) must NOT be selected.
    assert not any(60 <= p <= 90 for p in peaks)
    # No overlapping clips and fewer clips than requested (no invented highlights).
    assert len(result["moments"]) < 5 and result["insufficient"]
    explosion = next(m for m in result["moments"] if 115 <= m["peak"] <= 128)
    types = {e["type"] for e in explosion["events"]}
    assert "flash" in types
    assert any("impacto" in r.lower() for r in explosion["reasons"])
    # Second run must hit the cache (no re-analysis of audio/vision).
    result2 = run({**cfg, "output": str(tmp_path / "a2.json")})
    assert result2["moments"] == result["moments"]
    assert os.listdir(cfg["cache_dir"])
