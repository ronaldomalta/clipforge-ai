"""ClipForge AI analysis CLI (called by the Node backend).

Usage:
    python analyze.py --config analysis-config.json
    python analyze.py --input video.mp4 --output analysis.json [--count 5 --duration 30]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from clipforge_ai.media import probe  # noqa: E402
from clipforge_ai.pipeline import run  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description="ClipForge AI highlight analysis")
    parser.add_argument("--config")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument("--duration", default="30")
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--no-transcribe", action="store_true")
    parser.add_argument("--no-vision", action="store_true")
    parser.add_argument("--allow-download", action="store_true")
    args = parser.parse_args(argv)

    if args.config:
        with open(args.config, encoding="utf-8") as f:
            cfg = json.load(f)
    else:
        if not args.input or not args.output:
            parser.error("--input e --output são obrigatórios sem --config")
        ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")
        ffprobe = os.environ.get("FFPROBE_PATH", "ffprobe")
        work = os.path.join(os.path.dirname(os.path.abspath(args.output)), "_work")
        cfg = {
            "input": args.input, "output": args.output, "work_dir": work,
            "cache_dir": os.path.join(work, "cache"), "ffmpeg": ffmpeg, "ffprobe": ffprobe,
            "count": args.count, "duration": "auto" if args.duration == "auto" else int(args.duration),
            "smart": True, "transcribe": not args.no_transcribe, "language": args.language, "model": args.model,
            "device": "auto", "allow_download": args.allow_download, "vision": not args.no_vision,
            "min_score": 50, "weights": {}, "media": probe(ffprobe, args.input),
        }
    if not os.path.isfile(cfg["input"]):
        raise FileNotFoundError(cfg["input"])
    result = run(cfg)
    print(f"Análise concluída: {len(result['moments'])} momento(s).", flush=True)


if __name__ == "__main__":
    main()
