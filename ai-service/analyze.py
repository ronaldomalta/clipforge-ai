
import argparse
import json
import math
import os
import re
import subprocess
import tempfile
import wave

import numpy as np
from faster_whisper import WhisperModel


EXCITING_WORDS = {
    "caralho": 4,
    "porra": 3,
    "meu deus": 5,
    "não acredito": 5,
    "corre": 3,
    "foge": 3,
    "polícia": 3,
    "tiro": 3,
    "matei": 4,
    "morri": 3,
    "explodiu": 5,
    "explosão": 4,
    "ganhei": 4,
    "perdi": 2,
    "olha isso": 5,
    "que isso": 4,
    "mano": 1,
    "wtf": 4,
    "oh my god": 5,
    "no way": 5,
    "let's go": 4,
    "crazy": 3,
    "police": 3,
    "shoot": 3,
    "kill": 3,
    "explosion": 4,
}


def extract_audio(video_path, audio_path):
    ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")

    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", video_path,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        audio_path,
    ]

    subprocess.run(command, check=True)


def read_audio_energy(audio_path):
    with wave.open(audio_path, "rb") as wav:
        sample_rate = wav.getframerate()

        samples = np.frombuffer(
            wav.readframes(wav.getnframes()),
            dtype=np.int16,
        ).astype(np.float32)

    if len(samples) == 0:
        return np.array([]), 1

    samples /= 32768.0

    window_seconds = 1
    window_size = sample_rate * window_seconds

    energies = []

    for start in range(0, len(samples), window_size):
        chunk = samples[start:start + window_size]

        if len(chunk):
            rms = float(np.sqrt(np.mean(chunk ** 2)))
            energies.append(rms)

    return np.array(energies), window_seconds


def transcribe(audio_path, model_name):
    """
    Read PCM WAV directly as NumPy.

    This bypasses PyAV audio decoding and avoids the
    metadata_errors compatibility issue.
    """

    with wave.open(audio_path, "rb") as wav:
        sample_rate = wav.getframerate()
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()

        if sample_rate != 16000:
            raise ValueError(
                "Audio must have a 16000 Hz sample rate"
            )

        if channels != 1:
            raise ValueError(
                "Audio must be mono"
            )

        if sample_width != 2:
            raise ValueError(
                "Audio must be 16-bit PCM"
            )

        audio = np.frombuffer(
            wav.readframes(wav.getnframes()),
            dtype=np.int16,
        ).astype(np.float32)

    audio /= 32768.0

    print(
        f"Audio loaded: {len(audio) / 16000:.1f} seconds",
        flush=True,
    )

    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
    )

    segments, info = model.transcribe(
        audio,
        beam_size=5,
        vad_filter=True,
    )

    transcript = []

    for segment in segments:
        text = segment.text.strip()

        if text:
            transcript.append({
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "text": text,
            })

    return transcript, info.language


def keyword_score(text):
    text = text.lower()
    score = 0

    for word, weight in EXCITING_WORDS.items():
        if word in text:
            score += weight

    return score


def get_video_duration(video_path):
    ffprobe = os.environ.get("FFPROBE_PATH", "ffprobe")

    result = subprocess.run(
        [
            ffprobe,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )

    return float(result.stdout.strip())


def create_title(text):
    if not text.strip():
        return "Momento intenso do gameplay"

    cleaned = re.sub(r"\s+", " ", text).strip()

    if len(cleaned) > 55:
        cleaned = (
            cleaned[:52].rsplit(" ", 1)[0] + "..."
        )

    return cleaned


def score_window(
    start,
    duration,
    transcript,
    energies,
):
    end = start + duration

    matching = [
        segment
        for segment in transcript
        if segment["end"] > start
        and segment["start"] < end
    ]

    text = " ".join(
        segment["text"]
        for segment in matching
    )

    words_score = keyword_score(text)

    speech_score = min(
        len(matching) * 1.5,
        10,
    )

    start_index = max(0, int(start))
    end_index = min(
        len(energies),
        math.ceil(end),
    )

    window_energy = energies[
        start_index:end_index
    ]

    if len(window_energy):
        average_energy = float(
            np.mean(window_energy)
        )
        peak_energy = float(
            np.max(window_energy)
        )
    else:
        average_energy = 0
        peak_energy = 0

    energy_score = min(
        average_energy * 120
        + peak_energy * 60,
        25,
    )

    total_score = (
        words_score * 3
        + speech_score
        + energy_score
    )

    return {
        "start": round(start, 2),
        "end": round(end, 2),
        "score": round(total_score, 2),
        "title": create_title(text),
        "transcript": text[:400],
    }


def select_moments(
    duration,
    count,
    clip_duration,
    transcript,
    energies,
):
    max_start = max(
        0,
        duration - clip_duration,
    )

    if max_start == 0:
        return [
            score_window(
                0,
                min(duration, clip_duration),
                transcript,
                energies,
            )
        ]

    step = 5
    candidates = []

    position = 0.0

    while position <= max_start:
        candidates.append(
            score_window(
                position,
                clip_duration,
                transcript,
                energies,
            )
        )

        position += step

    candidates.sort(
        key=lambda moment: moment["score"],
        reverse=True,
    )

    selected = []

    for candidate in candidates:
        overlaps = any(
            candidate["start"] < chosen["end"]
            and candidate["end"] > chosen["start"]
            for chosen in selected
        )

        if not overlaps:
            selected.append(candidate)

        if len(selected) >= count:
            break

    selected.sort(
        key=lambda moment: moment["start"]
    )

    return selected


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--input",
        required=True,
    )

    parser.add_argument(
        "--output",
        required=True,
    )

    parser.add_argument(
        "--count",
        type=int,
        default=3,
    )

    parser.add_argument(
        "--duration",
        type=int,
        default=30,
    )

    parser.add_argument(
        "--model",
        default="base",
    )

    args = parser.parse_args()

    if not os.path.isfile(args.input):
        raise FileNotFoundError(
            args.input
        )

    if args.count < 1:
        raise ValueError(
            "Count must be greater than zero"
        )

    if args.duration < 1:
        raise ValueError(
            "Duration must be greater than zero"
        )

    video_duration = get_video_duration(
        args.input
    )

    print(
        f"Video duration: {video_duration:.1f}s",
        flush=True,
    )

    with tempfile.TemporaryDirectory() as temp_dir:
        audio_path = os.path.join(
            temp_dir,
            "audio.wav",
        )

        print(
            "Extracting audio...",
            flush=True,
        )

        extract_audio(
            args.input,
            audio_path,
        )

        print(
            "Analyzing audio intensity...",
            flush=True,
        )

        energies, _ = read_audio_energy(
            audio_path
        )

        print(
            "Transcribing with Whisper...",
            flush=True,
        )

        transcript, language = transcribe(
            audio_path,
            args.model,
        )

    print(
        "Selecting interesting moments...",
        flush=True,
    )

    moments = select_moments(
        video_duration,
        args.count,
        args.duration,
        transcript,
        energies,
    )

    result = {
        "engine": "faster-whisper-audio-v1",
        "language": language,
        "duration": round(
            video_duration,
            2,
        ),
        "segments": transcript,
        "moments": moments,
    }

    os.makedirs(
        os.path.dirname(
            os.path.abspath(args.output)
        ),
        exist_ok=True,
    )

    with open(
        args.output,
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            result,
            file,
            ensure_ascii=False,
            indent=2,
        )

    print(
        f"Analysis complete: {len(moments)} moments found.",
        flush=True,
    )


if __name__ == "__main__":
    main()
