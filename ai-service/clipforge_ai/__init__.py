"""ClipForge AI analysis service.

Pipeline (all local, no paid APIs):
  audio features (streamed, chunked)  →  faster-whisper transcription (chunked, cached)
  → semantic cues  →  coarse vision (keyframes)  →  candidate windows
  → fine vision on candidates only  →  explainable 0–100 score  →  selection.
"""

__version__ = "1.0.0"
ENGINE = "clipforge-multisignal-v1"
