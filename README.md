# ClipForge AI — Vice City Studio MVP

Local video clip studio for gaming recordings. React + Vite, Node.js/Express, Python/faster-whisper (optional), FFmpeg.

## Windows installation

1. Unzip the project into `C:\Users\PC\clipforge-ai` (back up your existing folder first).
2. Open a PowerShell terminal in `backend`. Run `npm install` then `npm start`.
3. Open another PowerShell terminal in `frontend`. Run `npm install` then `npm run dev`.
4. Open `http://localhost:5173`.
5. Make sure `python -m yt_dlp --version` and `ffmpeg -version` work. Install yt-dlp with `python -m pip install -U yt-dlp` if needed.
6. For smart moments and subtitles, install `python -m pip install -r ai-service/requirements.txt` from the project root. Whisper downloads its model on first use. Without it, the app generates timeline-based clips.
7. Copy `.env.example` to `backend/.env` and set the Windows paths for `FFMPEG_PATH`, `FFPROBE_PATH` and optionally `PYTHON_PATH`. If `FFMPEG_PATH` is a full path, set `FFPROBE_PATH` to the adjacent `ffprobe.exe`.

## Features implemented

- Import MP4/MKV/MOV/WebM/AVI files up to 20 GB, or download from YouTube with yt-dlp.
- Async jobs, progress updates, persistent job metadata, and library of rendered clips.
- Generate 1–10 clips of 15/30/45/60/90 seconds, vertical 9:16 or original aspect ratio.
- Optional faster-whisper transcription, keyword/speech-density moment heuristic and burned-in SRT captions.
- Viral TikTok V1: contrast and saturation adjustment. Dynamic zooms and silence removal are **not yet implemented**.
- Source uploaded to the backend is a temporary copy, deleted after processing. **Your original local recording is never deleted.**

## Known limitations

- AI score is heuristic, not a trained virality predictor; it may select uninteresting clips.
- If faster-whisper fails or isn't installed, generation falls back to evenly spaced timestamps, and captions are omitted.
- All jobs run sequentially to limit RAM/CPU pressure. Large uploads may take time, and active uploads do not show progress yet.
- Job history survives backend restarts, but interrupted jobs are not automatically resumed.
- This MVP does **not** capture TikTok LIVE Studio in real time or publish to TikTok.
- Vertical format currently uses center crop, which can cut off important action; advanced smart tracking is future work.
- Whisper defaults to CPU int8 for Windows compatibility, which can be slow on multi-hour recordings.
- YouTube downloads should only be used for videos you own or are authorized to process.

## API

- `POST /api/videos/info` with JSON `{ "url": "..." }`
- `POST /api/jobs/youtube` with JSON `{ "url": "...", "count": 5, "duration": 30, "smart": true, "captions": true, "vertical": true, "autoEdit": true }`
- `POST /api/jobs/upload` multipart form with `video` and the same options
- `GET /api/jobs`, `GET /api/jobs/:id`, `GET /api/clips`

## Tests

Backend syntax: `cd backend && npm test`.
Frontend build: `cd frontend && npm run build`.
Recommended functional test: 2-minute local MP4, 3 clips, 15 seconds, AI off; then repeat with Whisper on; finally try a long recording.
