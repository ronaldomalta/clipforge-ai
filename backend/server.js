
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 3001;

const ROOT_DIR = path.resolve(__dirname, "..");
const UPLOADS_DIR = path.join(ROOT_DIR, "storage", "uploads");
const CLIPS_DIR = path.join(ROOT_DIR, "storage", "clips");

const PYTHON = process.env.PYTHON_PATH || "python";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(CLIPS_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "16kb" }));

app.use("/clips", express.static(CLIPS_DIR));

app.get("/", (req, res) => {
  res.json({
    message: "ClipForge AI API is running!",
    status: "success"
  });
});

function validateYouTubeUrl(value) {
  try {
    const url = new URL(value);

    const allowedHosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be"
    ];

    return (
      url.protocol === "https:" &&
      allowedHosts.includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function runCommand(command, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString();

      if (stdout.length > 10_000_000) {
        child.kill();
      }
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();

      if (stderr.length > 30000) {
        stderr = stderr.slice(-30000);
      }
    });

    child.on("error", (error) => {
      finish(error);
    });

    child.on("close", (code) => {
      if (timedOut) {
        return finish(
          new Error(`${command} timed out`)
        );
      }

      if (code !== 0) {
        return finish(
          new Error(
            `${command} failed with code ${code}: ${stderr.slice(-4000)}`
          )
        );
      }

      finish(null, { stdout, stderr });
    });

    function finish(error, result) {
      if (finished) return;

      finished = true;
      clearTimeout(timeout);

      if (error) reject(error);
      else resolve(result);
    }
  });
}

function getYtDlpArgs() {
  return [
    "-m",
    "yt_dlp",
    "--js-runtimes",
    "node",
    "--remote-components",
    "ejs:github",
    "--ffmpeg-location",
    FFMPEG,
    "--no-playlist",
    "--no-config"
  ];
}

app.post("/api/videos/info", async (req, res) => {
  const { url } = req.body || {};

  if (
    typeof url !== "string" ||
    !validateYouTubeUrl(url)
  ) {
    return res.status(400).json({
      error: "Invalid YouTube URL"
    });
  }

  try {
    console.log("Analyzing video:", url);

    const result = await runCommand(
      PYTHON,
      [
        ...getYtDlpArgs(),
        "--dump-single-json",
        "--skip-download",
        "--",
        url
      ],
      120000
    );

    const video = JSON.parse(result.stdout);

    console.log("Video found:", video.title);

    res.json({
      title: video.title,
      duration: video.duration,
      uploader: video.uploader,
      thumbnail: video.thumbnail,
      isLive: video.is_live === true,
      status: "success"
    });
  } catch (error) {
    console.error(
      "Video info error:",
      error.message
    );

    res.status(422).json({
      error: "Could not retrieve video information"
    });
  }
});

let processing = false;

app.post("/api/clips/generate", async (req, res) => {
  const { url, duration } = req.body || {};

  if (
    typeof url !== "string" ||
    !validateYouTubeUrl(url)
  ) {
    return res.status(400).json({
      error: "Invalid YouTube URL"
    });
  }

  const clipDuration = Number(duration);

  if (![15, 30, 45, 60, 90].includes(clipDuration)) {
    return res.status(400).json({
      error: "Invalid clip duration"
    });
  }

  if (processing) {
    return res.status(409).json({
      error: "Another clip is currently processing"
    });
  }

  processing = true;

  const id = crypto.randomUUID();
  const jobDir = path.join(UPLOADS_DIR, id);
  const clipName = `${id}.mp4`;
  const clipPath = path.join(CLIPS_DIR, clipName);

  fs.mkdirSync(jobDir, { recursive: true });

  try {
    console.log("Starting clip generation:", id);

    await runCommand(
      FFMPEG,
      ["-version"],
      15000
    );

    const outputTemplate = path.join(
      jobDir,
      "source.%(ext)s"
    );

    console.log("Downloading and merging video...");

    const downloadResult = await runCommand(
      PYTHON,
      [
        ...getYtDlpArgs(),
        "--no-progress",
        "--no-simulate",
        "--format",
        "bv*+ba/b",
        "--merge-output-format",
        "mp4",
        "--print",
        "after_move:filepath",
        "--output",
        outputTemplate,
        "--",
        url
      ],
      600000
    );

    const outputLines = downloadResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const reportedPath = outputLines.at(-1);

    if (!reportedPath) {
      throw new Error(
        "yt-dlp did not report the downloaded file"
      );
    }

    const sourcePath = path.resolve(reportedPath);
    const relativePath = path.relative(jobDir, sourcePath);

    if (
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      !relativePath
    ) {
      throw new Error(
        "Downloaded file is outside the job directory"
      );
    }

    if (!fs.existsSync(sourcePath)) {
      throw new Error(
        `Downloaded file not found: ${sourcePath}`
      );
    }

    console.log("Download completed:", sourcePath);
    console.log("Generating MP4 clip...");

    await runCommand(
      FFMPEG,
      [
        "-hide_banner",
        "-y",
        "-ss",
        "10",
        "-i",
        sourcePath,
        "-t",
        String(clipDuration),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        clipPath
      ],
      300000
    );

    if (
      !fs.existsSync(clipPath) ||
      fs.statSync(clipPath).size === 0
    ) {
      throw new Error(
        "FFmpeg did not create a valid MP4 clip"
      );
    }

    console.log(
      "Clip generated successfully:",
      clipName
    );

    res.json({
      status: "success",
      message: "Clip generated successfully",
      filename: clipName,
      clipUrl: `http://localhost:${PORT}/clips/${clipName}`,
      duration: clipDuration
    });
  } catch (error) {
    console.error(
      "Clip generation error:",
      error.message
    );

    if (fs.existsSync(clipPath)) {
      try {
        fs.unlinkSync(clipPath);
      } catch (cleanupError) {
        console.error(
          "Clip cleanup error:",
          cleanupError.message
        );
      }
    }

    res.status(500).json({
      error:
        "Could not generate clip. Check the backend terminal."
    });
  } finally {
    processing = false;

    try {
      fs.rmSync(jobDir, {
        recursive: true,
        force: true
      });
    } catch (cleanupError) {
      console.error(
        "Temporary cleanup error:",
        cleanupError.message
      );
    }
  }
});

app.listen(PORT, () => {
  console.log(`ClipForge AI running on port ${PORT}`);
});
