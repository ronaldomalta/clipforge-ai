"use strict";

/**
 * Central configuration. Everything that depends on the environment lives here so
 * the rest of the backend can be tested with an isolated storage directory.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const IS_WINDOWS = process.platform === "win32";

// Load backend/.env first, then the project-root .env (both optional).
try {
  if (process.env.CLIPFORGE_SKIP_DOTENV === "1") throw new Error("skip");
  const dotenv = require("dotenv");
  dotenv.config({ path: path.join(ROOT, "backend", ".env"), quiet: true });
  dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
} catch {
  /* dotenv is optional at runtime */
}

function resolveFfprobe(ffmpeg) {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  if (process.env.FFMPEG_PATH && path.isAbsolute(process.env.FFMPEG_PATH)) {
    const dir = path.dirname(process.env.FFMPEG_PATH);
    const candidate = path.join(dir, IS_WINDOWS ? "ffprobe.exe" : "ffprobe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return ffmpeg === "ffmpeg" ? "ffprobe" : "ffprobe";
}

function resolvePython() {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  // Prefer the project virtual environment created by install-windows.bat / install.sh
  const venv = IS_WINDOWS
    ? path.join(ROOT, "ai-service", ".venv", "Scripts", "python.exe")
    : path.join(ROOT, "ai-service", ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return IS_WINDOWS ? "python" : "python3";
}

function buildConfig(overrides = {}) {
  const storage = path.resolve(
    overrides.storage || process.env.CLIPFORGE_STORAGE || path.join(ROOT, "storage")
  );
  const ffmpeg = overrides.ffmpeg || process.env.FFMPEG_PATH || "ffmpeg";
  const port = Number(overrides.port ?? process.env.PORT ?? 3001);

  const dirs = {
    storage,
    uploads: path.join(storage, "uploads"),
    clips: path.join(storage, "clips"),
    jobs: path.join(storage, "jobs"), // legacy JSON records (read-only after migration)
    thumbs: path.join(storage, "thumbs"),
    captions: path.join(storage, "captions"),
    segments: path.join(storage, "segments"),
    proxies: path.join(storage, "proxies"),
    work: path.join(storage, "work"),
    cache: path.join(storage, "cache"),
    db: path.join(storage, "db"),
    backups: path.join(storage, "backups"),
    logs: path.join(storage, "logs"),
  };

  return {
    root: ROOT,
    isWindows: IS_WINDOWS,
    port,
    host: overrides.host || process.env.HOST || "127.0.0.1",
    ffmpeg,
    ffprobe: overrides.ffprobe || resolveFfprobe(ffmpeg),
    python: overrides.python || resolvePython(),
    aiScript: path.join(ROOT, "ai-service", "analyze.py"),
    doctorScript: path.join(ROOT, "ai-service", "doctor.py"),
    fontsDir: path.join(ROOT, "assets", "fonts"),
    frontendDist: path.join(ROOT, "frontend", "dist"),
    dirs,
    dbFile: path.join(dirs.db, "clipforge.db"),
    maxUploadBytes:
      Number(overrides.maxUploadGB ?? process.env.MAX_UPLOAD_GB ?? 20) * 1024 ** 3,
    allowedOrigins: (
      process.env.CLIPFORGE_ALLOWED_ORIGINS ||
      `http://localhost:5173,http://127.0.0.1:5173,http://localhost:${port},http://127.0.0.1:${port}`
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowedHosts: (process.env.CLIPFORGE_ALLOWED_HOSTS || "localhost,127.0.0.1,[::1],::1")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    defaultExportDir: path.join(os.homedir(), "Videos", "ClipForge"),
    // Tests disable the background worker to drive the queue manually.
    startWorker: overrides.startWorker ?? true,
    logToFile: overrides.logToFile ?? true,
    ...overrides.extra,
  };
}

function ensureDirs(config) {
  for (const dir of Object.values(config.dirs)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = { buildConfig, ensureDirs, ROOT, IS_WINDOWS };
