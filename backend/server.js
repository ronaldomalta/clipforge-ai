

"use strict";



const express = require("express");

const cors = require("cors");

const dotenv = require("dotenv");

const { spawn } = require("child_process");

const fs = require("fs");

const path = require("path");

const crypto = require("crypto");

const multer = require("multer");



dotenv.config({ path: path.join(__dirname, ".env") });



const app = express();

const PORT = Number(process.env.PORT || 3001);

const ROOT = path.resolve(__dirname, "..");



const UPLOADS = path.join(ROOT, "storage", "uploads");

const CLIPS = path.join(ROOT, "storage", "clips");

const JOBS = path.join(ROOT, "storage", "jobs");



for (const dir of [UPLOADS, CLIPS, JOBS]) {

  fs.mkdirSync(dir, { recursive: true });

}



const PYTHON = process.env.PYTHON_PATH || "python";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

const FFPROBE =

  process.env.FFPROBE_PATH ||

  (process.env.FFMPEG_PATH

    ? path.join(path.dirname(FFMPEG), "ffprobe.exe")

    : "ffprobe");



const BASE =

  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;



const VIDEO_QUALITY = {

  width: 1080,

  height: 1920,

  crf: 18,

  preset: "medium",

  audioBitrate: "192k",

  maxFps: 60,

};



const jobs = new Map();

const queue = [];

let active = false;



app.use(cors());

app.use(express.json({ limit: "32kb" }));

app.use("/clips", express.static(CLIPS));



app.get("/", (_req, res) => {

  res.json({

    status: "success",

    message: "ClipForge AI API running",

  });

});



const upload = multer({

  dest: UPLOADS,

  limits: {

    fileSize: Number(process.env.MAX_UPLOAD_GB || 20) * 1024 ** 3,

  },

  fileFilter(_req, file, cb) {

    const ext = path.extname(file.originalname).toLowerCase();



    if (![".mp4", ".mkv", ".mov", ".webm", ".avi"].includes(ext)) {

      return cb(new Error("Unsupported video format"));

    }



    cb(null, true);

  },

});



function isYoutube(value) {

  try {

    const url = new URL(value);

    return (

      url.protocol === "https:" &&

      [

        "youtube.com",

        "www.youtube.com",

        "m.youtube.com",

        "youtu.be",

      ].includes(url.hostname)

    );

  } catch {

    return false;

  }

}



function execute(command, args, timeout = 3600000) {

  return new Promise((resolve, reject) => {

    let stdout = "";

    let stderr = "";

    let finished = false;



    const child = spawn(command, args, {

      windowsHide: true,

      shell: false,

    });



    const timer = setTimeout(() => {

      child.kill();

      finish(new Error("Process timeout"));

    }, timeout);



    function finish(error, result) {

      if (finished) return;

      finished = true;

      clearTimeout(timer);



      if (error) reject(error);

      else resolve(result);

    }



    child.stdout.on("data", (data) => {

      stdout += data.toString();

      if (stdout.length > 12000000) {

        stdout = stdout.slice(-12000000);

      }

    });



    child.stderr.on("data", (data) => {

      stderr += data.toString();

      if (stderr.length > 200000) {

        stderr = stderr.slice(-200000);

      }

    });



    child.on("error", finish);



    child.on("close", (code) => {

      finish(

        code === 0

          ? null

          : new Error(

              `${path.basename(command)} exit ${code}: ` +

              stderr.slice(-2000)

            ),

        { stdout, stderr }

      );

    });

  });

}



async function probe(file) {

  const result = await execute(

    FFPROBE,

    [

      "-v", "error",

      "-show_entries",

      "format=duration:stream=codec_type",

      "-of", "json",

      file,

    ],

    30000

  );



  const data = JSON.parse(result.stdout);

  const duration = Number(data.format?.duration);



  if (!Number.isFinite(duration) || duration <= 0) {

    throw new Error("Unable to read video duration");

  }



  return {

    duration,

    hasVideo: (data.streams || []).some(

      (stream) => stream.codec_type === "video"

    ),

    hasAudio: (data.streams || []).some(

      (stream) => stream.codec_type === "audio"

    ),

  };

}



function update(job, patch) {

  Object.assign(job, patch, {

    updatedAt: new Date().toISOString(),

  });



  fs.writeFileSync(

    path.join(JOBS, `${job.id}.json`),

    JSON.stringify(job, null, 2)

  );

}



function publicJob(job) {

  const {

    id, status, progress, step, error, clips,

    createdAt, sourceName, settings, analysis, reviewedAt,

  } = job;



  return {

    id, status, progress, step, error, clips,

    createdAt, sourceName, settings, analysis, reviewedAt,

  };

}



function settings(body) {

  const flag = (value, defaultValue) =>

    value === undefined

      ? defaultValue

      : value === true || value === "true";



  const count = Number(body.count || 3);

  const duration = Number(body.duration || 30);



  if (

    !Number.isInteger(count) ||

    count < 1 ||

    count > 10 ||

    ![15, 30, 45, 60, 90].includes(duration)

  ) {

    throw new Error("Invalid clip count or duration");

  }



  return {

    count,

    duration,

    vertical: flag(body.vertical, true),

    captions: flag(body.captions, false),

    autoEdit: flag(body.autoEdit, false),

    smart: flag(body.smart, false),

  };

}



function makeJob(data) {

  const id = crypto.randomUUID();



  const {

    sourceType, url, filePath, sourceName,

    count, duration, vertical, captions, autoEdit, smart,

  } = data;



  const job = {

    id,

    sourceType,

    url,

    filePath,

    sourceName,

    status: "queued",

    progress: 0,

    step: "Na fila",

    error: null,

    clips: [],

    createdAt: new Date().toISOString(),

    settings: {

      count, duration, vertical, captions, autoEdit, smart,

    },

    analysis: null,

  };



  update(job, {});

  jobs.set(id, job);

  queue.push(id);

  void drain();



  return job;

}



app.post("/api/videos/info", async (req, res) => {

  const url = req.body?.url;



  if (!isYoutube(url)) {

    return res.status(400).json({

      error: "Invalid YouTube URL",

    });

  }



  try {

    const result = await execute(

      PYTHON,

      [

        "-m", "yt_dlp",

        "--js-runtimes", "node",

        "--remote-components", "ejs:github",

        "--no-playlist",

        "--no-config",

        "--dump-single-json",

        "--skip-download",

        "--", url,

      ],

      120000

    );



    const video = JSON.parse(result.stdout);



    res.json({

      status: "success",

      title: video.title,

      duration: video.duration,

      uploader: video.uploader,

      thumbnail: video.thumbnail,

      isLive: video.is_live === true,

    });

  } catch (error) {

    res.status(422).json({

      error: `Could not analyze video: ${error.message}`,

    });

  }

});



app.post("/api/jobs/youtube", (req, res) => {

  if (!isYoutube(req.body?.url)) {

    return res.status(400).json({

      error: "Invalid YouTube URL",

    });

  }



  try {

    const job = makeJob({

      sourceType: "youtube",

      url: req.body.url,

      sourceName: "YouTube",

      ...settings(req.body),

    });



    res.status(202).json(publicJob(job));

  } catch (error) {

    res.status(400).json({ error: error.message });

  }

});



app.post(

  "/api/jobs/upload",

  upload.single("video"),

  (req, res) => {

    if (!req.file) {

      return res.status(400).json({

        error: "Select a video file",

      });

    }



    try {

      const job = makeJob({

        sourceType: "upload",

        filePath: req.file.path,

        sourceName: path.basename(req.file.originalname),

        ...settings(req.body),

      });



      res.status(202).json(publicJob(job));

    } catch (error) {

      fs.rmSync(req.file.path, { force: true });

      res.status(400).json({ error: error.message });

    }

  }

);



app.get("/api/jobs", (_req, res) => {

  res.json(

    [...jobs.values()]

      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

      .map(publicJob)

  );

});



app.get("/api/jobs/:id", (req, res) => {

  const job = jobs.get(req.params.id);



  if (!job) {

    return res.status(404).json({

      error: "Job not found",

    });

  }



  res.json(publicJob(job));

});



// Approve selected clips and permanently discard other clips from a completed job.
// This only deletes known clip files inside the storage/clips directory.
app.post("/api/jobs/:id/finalize-selection", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Projeto não encontrado." });
  if (job.status !== "completed") {
    return res.status(409).json({ error: "Aguarde o projeto terminar antes de revisar." });
  }
  if (job.reviewedAt) {
    return res.status(409).json({ error: "Este projeto já teve a seleção finalizada." });
  }
  const keepIds = req.body?.keepIds;
  if (!Array.isArray(keepIds) || !keepIds.every(id => typeof id === "string")) {
    return res.status(400).json({ error: "Seleção inválida." });
  }
  const known = new Set((job.clips || []).map(c => c.id));
  if (new Set(keepIds).size !== keepIds.length || keepIds.some(id => !known.has(id))) {
    return res.status(400).json({ error: "A seleção contém clipes desconhecidos ou repetidos." });
  }
  const keep = new Set(keepIds);
  const removed = [];
  const kept = [];
  try {
    for (const clip of job.clips || []) {
      if (keep.has(clip.id)) { kept.push(clip); continue; }
      // Never use a user-supplied path; filenames must belong to this job.
      const expected = `${job.id}_`;
      const filename = clip.filename;
      if (typeof filename !== "string" || !filename.startsWith(expected) ||
          !/^[-a-zA-Z0-9_]+\.mp4$/.test(filename) || filename !== clip.id) {
        throw new Error("Nome de clipe inválido; exclusão interrompida.");
      }
      const target = path.join(CLIPS, filename);
      if (path.dirname(target) !== CLIPS) throw new Error("Caminho de clipe inválido.");
      fs.rmSync(target, { force: true });
      removed.push(clip.id);
    }
    update(job, { clips: kept, reviewedAt: new Date().toISOString() });
    res.json({ success: true, removed: removed.length, kept: kept.length, job: publicJob(job) });
  } catch (error) {
    // Reconcile metadata if a deletion partially succeeded.
    const remaining = (job.clips || []).filter(c => !removed.includes(c.id));
    update(job, { clips: remaining });
    res.status(500).json({ error: `Não foi possível finalizar: ${error.message}` });
  }
});

app.get("/api/clips", (_req, res) => {

  const clips = [...jobs.values()].flatMap((job) =>

    job.clips.map((clip) => ({

      ...clip,

      jobId: job.id,

      sourceName: job.sourceName,

    }))

  );



  res.json(clips.reverse());

});



app.post("/api/clips/generate", (req, res) => {

  if (!isYoutube(req.body?.url)) {

    return res.status(400).json({

      error: "Invalid YouTube URL",

    });

  }



  try {

    const job = makeJob({

      sourceType: "youtube",

      url: req.body.url,

      sourceName: "YouTube",

      count: 1,

      duration: Number(req.body.duration || 30),

      vertical: false,

      captions: false,

      autoEdit: false,

      smart: false,

    });



    res.status(202).json(publicJob(job));

  } catch (error) {

    res.status(400).json({ error: error.message });

  }

});



async function drain() {

  if (active) return;

  active = true;



  try {

    while (queue.length) {

      const job = jobs.get(queue.shift());

      if (!job) continue;



      try {

        await processJob(job);

      } catch (error) {

        console.error("Job failed:", job.id, error);



        update(job, {

          status: "failed",

          step: "Falha",

          error: error.message,

        });

      }

    }

  } finally {

    active = false;

  }

}



async function downloadYoutube(job, dir) {

  const template = path.join(dir, "source.%(ext)s");



  const common = [

    "-m", "yt_dlp",

    "--js-runtimes", "node",

    "--remote-components", "ejs:github",

    "--ffmpeg-location", path.dirname(FFMPEG),

    "--no-playlist",

    "--no-config",

    "--no-progress",

    "--print", "after_move:filepath",

    "-o", template,

  ];



  let lastError = null;



  // Prefer high-quality separate video and audio streams.

  // Verify that the merged output has both streams.

  for (const format of ["bv*+ba/b", "b"]) {

    for (const name of fs.readdirSync(dir)) {

      if (name.startsWith("source.")) {

        fs.rmSync(path.join(dir, name), { force: true });

      }

    }



    try {

      const result = await execute(

        PYTHON,

        [

          ...common,

          "-f", format,

          "--merge-output-format", "mkv",

          "--", job.url,

        ],

        7200000

      );



      const printed = result.stdout

        .split(/\r?\n/)

        .map((line) => line.trim())

        .filter(Boolean);



      const files = fs.readdirSync(dir)

        .filter((name) =>

          /^source\.(mp4|mkv|webm|mov)$/i.test(name)

        )

        .map((name) => path.join(dir, name));



      const candidates = [...printed, ...files];



      for (const candidate of candidates) {

        if (

          !fs.existsSync(candidate) ||

          !fs.statSync(candidate).isFile()

        ) {

          continue;

        }



        const media = await probe(candidate).catch(() => null);



        if (media?.hasVideo && media?.hasAudio) {

          console.log("YouTube video with audio:", candidate);

          return candidate;

        }

      }



      lastError = new Error(

        `Format ${format} did not produce merged video with audio`

      );

    } catch (error) {

      lastError = error;

      console.warn("Download attempt failed:", error.message);

    }

  }



  throw new Error(

    "Could not download video with audio: " +

    (lastError?.message || "Unknown error")

  );

}



function srtTime(seconds) {

  const ms = Math.max(0, Math.round(seconds * 1000));

  const h = Math.floor(ms / 3600000);

  const m = Math.floor((ms % 3600000) / 60000);

  const s = Math.floor((ms % 60000) / 1000);

  const r = ms % 1000;



  return (

    `${String(h).padStart(2, "0")}:` +

    `${String(m).padStart(2, "0")}:` +

    `${String(s).padStart(2, "0")},` +

    `${String(r).padStart(3, "0")}`

  );

}



function createSubtitleFile(transcript, start, length, dir, index) {

  if (!Array.isArray(transcript)) return null;



  const segments = transcript

    .filter((segment) =>

      Number(segment.end) > start &&

      Number(segment.start) < start + length

    )

    .map((segment) => ({

      start: Math.max(0, Number(segment.start) - start),

      end: Math.min(length, Number(segment.end) - start),

      text: String(segment.text || "").replace(/[\r\n]+/g, " "),

    }))

    .filter((segment) =>

      segment.end > segment.start && segment.text.trim()

    );



  if (!segments.length) return null;



  const file = path.join(dir, `caption_${index}.srt`);



  const content = segments.map((segment, i) =>

    `${i + 1}\n` +

    `${srtTime(segment.start)} --> ${srtTime(segment.end)}\n` +

    `${segment.text}\n`

  ).join("\n");



  fs.writeFileSync(file, content, "utf8");

  return file;

}



function escapeFilterPath(file) {

  return file

    .replace(/**\\\**/g, "/")

    .replace(/:/g, "\\\:")

    .replace(/'/g, "\\\\'");

}



function buildVideoFilter({ vertical, autoEdit, subtitleFile }) {

  const filters = [];



  if (vertical) {

    // Background: fill the entire portrait canvas and blur.

    // Foreground: preserve the entire landscape gameplay.

    const background =

      `[0:v]` +

      `scale=${VIDEO_QUALITY.width}:${VIDEO_QUALITY.height}:` +

      `force_original_aspect_ratio=increase,` +

      `crop=${VIDEO_QUALITY.width}:${VIDEO_QUALITY.height},` +

      `boxblur=20:2,setsar=1[bg]`;



    const foreground =

      `[0:v]` +

      `scale=${VIDEO_QUALITY.width}:${VIDEO_QUALITY.height}:` +

      `force_original_aspect_ratio=decrease,` +

      `setsar=1[fg]`;



    filters.push(background);

    filters.push(foreground);



    filters.push(

      `[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,` +

      `format=yuv420p[vbase]`

    );

  } else {

    filters.push(

      `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,` +

      `format=yuv420p[vbase]`

    );

  }



  let current = "vbase";



  if (autoEdit) {

    filters.push(

      `[${current}]eq=contrast=1.04:saturation=1.10` +

      `[vedit]`

    );

    current = "vedit";

  }



  if (subtitleFile) {

    const escaped = escapeFilterPath(subtitleFile);



    const style =

      "FontSize=18," +

      "PrimaryColour=&H00FFFFFF," +

      "OutlineColour=&H00000000," +

      "BorderStyle=1," +

      "Outline=2," +

      "Alignment=2," +

      "MarginV=90";



    filters.push(

      `[${current}]subtitles='${escaped}':` +

      `force_style='${style}'[vsub]`

    );



    current = "vsub";

  }



  filters.push(`[${current}]fps=${VIDEO_QUALITY.maxFps}:round=down[vout]`);



  return filters.join(";");

}



async function renderClip({

  source,

  target,

  start,

  length,

  vertical,

  autoEdit,

  subtitleFile,

}) {

  const filter = buildVideoFilter({

    vertical,

    autoEdit,

    subtitleFile,

  });



  const args = [

    "-hide_banner",

    "-loglevel", "error",

    "-y",

    "-ss", String(start),

    "-i", source,

    "-t", String(length),



    "-filter_complex", filter,



    "-map", "[vout]",

    "-map", "0:a:0",



    "-c:v", "libx264",

    "-preset", VIDEO_QUALITY.preset,

    "-crf", String(VIDEO_QUALITY.crf),

    "-pix_fmt", "yuv420p",



    "-c:a", "aac",

    "-b:a", VIDEO_QUALITY.audioBitrate,



    "-movflags", "+faststart",

    "-max_muxing_queue_size", "1024",



    target,

  ];



  await execute(

    FFMPEG,

    args,

    Math.max(600000, length * 60000)

  );



  if (

    !fs.existsSync(target) ||

    fs.statSync(target).size < 1024

  ) {

    throw new Error("Output video is empty");

  }



  const output = await probe(target);



  if (!output.hasVideo || !output.hasAudio) {

    throw new Error("Rendered clip is missing video or audio");

  }

}



async function processJob(job) {

  const dir = path.join(UPLOADS, job.id);

  fs.mkdirSync(dir, { recursive: true });



  let source = job.filePath;



  update(job, {

    status: "running",

    progress: 2,

    step: "Preparando vídeo",

  });



  try {

    if (job.sourceType === "youtube") {

      update(job, {

        progress: 5,

        step: "Baixando vídeo e áudio em alta qualidade",

      });



      source = await downloadYoutube(job, dir);

    }



    const media = await probe(source);



    if (!media.hasVideo || !media.hasAudio) {

      throw new Error(

        "Source video must contain video and audio streams"

      );

    }



    const total = media.duration;



    const {

      count,

      duration,

      vertical,

      captions,

      autoEdit,

      smart,

    } = job.settings;



    let suggestions = [];

    let transcript = null;



    if (smart || captions) {

      update(job, {

        progress: 25,

        step: "Analisando vídeo com Whisper",

      });



      try {

        const analysisPath = path.join(dir, "analysis.json");



        await execute(

          PYTHON,

          [

            path.join(ROOT, "ai-service", "analyze.py"),

            "--input", source,

            "--output", analysisPath,

            "--count", String(count),

            "--duration", String(duration),

            "--model", process.env.WHISPER_MODEL || "base",

          ],

          Math.max(3600000, total * 2500)

        );



        const result = JSON.parse(

          fs.readFileSync(analysisPath, "utf8")

        );



        suggestions = Array.isArray(result.moments)

          ? result.moments

          : [];



        transcript = Array.isArray(result.segments)

          ? result.segments

          : null;



        update(job, {

          analysis: {

            engine: result.engine,

            transcribed: !!transcript,

            moments: suggestions.length,

          },

        });

      } catch (error) {

        console.warn(

          "AI unavailable; using timeline fallback:",

          error.message

        );



        update(job, {

          analysis: {

            engine: "timeline-fallback",

            warning: "AI failed; using timeline selection",

          },

        });

      }

    }



    const maxStart = Math.max(0, total - duration);

    const starts = [];



    for (let i = 0; i < count; i++) {

      const suggested = Number(suggestions[i]?.start);



      const fallback = count === 1

        ? Math.min(10, maxStart)

        : (maxStart * (i + 0.5)) / count;



      starts.push(

        Math.max(

          0,

          Math.min(

            maxStart,

            suggestions[i] &&

            Number.isFinite(suggested)

              ? suggested

              : fallback

          )

        )

      );

    }



    for (let i = 0; i < count; i++) {

      const start = starts[i];

      const length = Math.min(duration, total - start);



      if (length <= 0) continue;



      const name =

        `${job.id}_${String(i + 1).padStart(2, "0")}.mp4`;



      const target = path.join(CLIPS, name);



      update(job, {

        progress: 35 + Math.round((60 * i) / count),

        step: `Renderizando clipe ${i + 1}/${count} em alta qualidade`,

      });



      const subtitleFile = captions

        ? createSubtitleFile(transcript, start, length, dir, i)

        : null;



      await renderClip({

        source,

        target,

        start,

        length,

        vertical,

        autoEdit,

        subtitleFile,

      });



      const clip = {

        id: name,

        filename: name,

        url: `${BASE}/clips/${name}`,

        start: Math.round(start),

        duration: Math.round(length),

        score: suggestions[i]?.score ?? null,

        title: suggestions[i]?.title || `Momento ${i + 1}`,

        captionsApplied: !!subtitleFile,

      };



      job.clips.push(clip);



      update(job, {

        progress: 35 + Math.round((60 * (i + 1)) / count),

      });

    }



    update(job, {

      status: "completed",

      progress: 100,

      step: "Clipes em alta qualidade prontos",

    });

  } finally {

    // Keep completed clips; remove temporary source files.

    if (job.filePath && fs.existsSync(job.filePath)) {

      fs.rmSync(job.filePath, { force: true });

    }



    fs.rmSync(dir, {

      recursive: true,

      force: true,

    });

  }

}



for (const filename of fs

  .readdirSync(JOBS)

  .filter((name) => name.endsWith(".json"))) {

  try {

    const job = JSON.parse(

      fs.readFileSync(path.join(JOBS, filename), "utf8")

    );



    if (["running", "queued"].includes(job.status)) {

      job.status = "interrupted";

      job.step = "Interrompido pelo reinício";

    }



    jobs.set(job.id, job);

  } catch {

    // Ignore invalid job records.

  }

}



app.use((error, _req, res, _next) => {

  res.status(400).json({

    error: error.message || "Upload error",

  });

});



app.listen(PORT, () => {

  console.log(`ClipForge AI API: ${BASE}`);

  console.log("Video quality: CRF 18 / medium / AAC 192k");

  console.log("Vertical mode: blurred background");

});
