"use strict";

/** FFprobe/FFmpeg helpers: probing, keyframe-aligned segments, thumbnails, previews. */
const fs = require("fs");
const path = require("path");
const { execute } = require("./proc");

function parseRate(value) {
  if (!value || typeof value !== "string") return null;
  const [num, den] = value.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return null;
  return num / den;
}

async function probe(config, file, { signal } = {}) {
  const result = await execute(
    config.ffprobe,
    [
      "-v", "error",
      "-show_entries",
      "format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames:stream_tags=rotate:stream_side_data=rotation",
      "-of", "json",
      file,
    ],
    { timeout: 60000, signal }
  );
  const data = JSON.parse(result.stdout || "{}");
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === "video" && s.codec_name !== "mjpeg" && s.codec_name !== "png");
  const audio = streams.filter((s) => s.codec_type === "audio");
  let duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Não foi possível ler a duração do vídeo.");

  let width = video?.width || 0;
  let height = video?.height || 0;
  const rotation = Math.abs(
    Number(video?.tags?.rotate || video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0)
  );
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];

  const avg = parseRate(video?.avg_frame_rate);
  const real = parseRate(video?.r_frame_rate);
  const fps = avg || real || 30;
  const vfr = !!(avg && real && Math.abs(avg - real) / real > 0.02);

  return {
    duration,
    size: Number(data.format?.size) || fs.statSync(file).size,
    container: data.format?.format_name || null,
    hasVideo: !!video,
    hasAudio: audio.length > 0,
    audioTracks: audio.length,
    videoCodec: video?.codec_name || null,
    audioCodec: audio[0]?.codec_name || null,
    width,
    height,
    rotation,
    fps: Math.round(fps * 1000) / 1000,
    vfr,
    orientation: width && height ? (height > width ? "vertical" : width > height ? "horizontal" : "square") : null,
  };
}

/** Output frame rate: keep the source rate (never up-convert), cap at 60, normalise odd VFR averages. */
function outputFps(media, cap = 60) {
  const src = Number(media?.fps) || 30;
  const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  let best = src;
  let bestDiff = 0.03;
  for (const c of common) {
    const diff = Math.abs(c - src) / c;
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return Math.min(best, cap);
}

/** Last keyframe time <= t (seconds). Returns null if none found nearby. */
async function keyframeBefore(config, file, t, { signal, window = 20 } = {}) {
  const from = Math.max(0, t - window);
  const result = await execute(
    config.ffprobe,
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-skip_frame", "nokey",
      "-show_entries", "frame=best_effort_timestamp_time",
      "-read_intervals", `${from.toFixed(3)}%${(t + 0.05).toFixed(3)}`,
      "-of", "csv=p=0",
      file,
    ],
    { timeout: 120000, signal }
  );
  const times = result.stdout
    .split(/\r?\n/)
    .map((l) => Number(l.split(",")[0]))
    .filter((n) => Number.isFinite(n) && n <= t + 0.001);
  if (!times.length) return null;
  return Math.max(...times);
}

/**
 * Save a padded piece of the source so the clip can be re-edited later without keeping
 * the full multi-hour recording. Uses keyframe-aligned stream copy (fast, lossless);
 * falls back to a high-quality re-encode when the keyframe can't be found.
 */
async function extractSegment(config, { source, start, end, media, target, signal, pad = 30 }) {
  const wantStart = Math.max(0, start - pad);
  const wantEnd = Math.min(media.duration, end + pad);
  let offset = null;
  if (media.hasVideo) {
    try {
      offset = await keyframeBefore(config, source, wantStart, { signal, window: 30 });
    } catch {
      offset = null;
    }
  }
  if (offset !== null && wantStart - offset < 30) {
    const length = wantEnd - offset;
    try {
      await execute(
        config.ffmpeg,
        [
          "-hide_banner", "-loglevel", "error", "-y",
          "-ss", (offset + 0.001).toFixed(3),
          "-i", source,
          "-t", length.toFixed(3),
          "-map", "0:v:0", "-map", "0:a?",
          "-c", "copy",
          "-avoid_negative_ts", "make_zero",
          target,
        ],
        { timeout: 600000, signal }
      );
      if (fs.existsSync(target) && fs.statSync(target).size > 1024) {
        return { offset, duration: length, method: "copy" };
      }
    } catch (error) {
      if (error.code === "CANCELED") throw error;
    }
  }
  // Fallback: frame-accurate high quality re-encode.
  const length = wantEnd - wantStart;
  await execute(
    config.ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", wantStart.toFixed(3),
      "-i", source,
      "-t", length.toFixed(3),
      "-map", "0:v:0", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "256k",
      target,
    ],
    { timeout: Math.max(600000, length * 20000), signal }
  );
  return { offset: wantStart, duration: length, method: "reencode" };
}

async function makeThumbnail(config, { video, at, target, signal }) {
  await execute(
    config.ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-ss", Math.max(0, at).toFixed(3), "-i", video,
      "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", target],
    { timeout: 60000, signal }
  );
  return fs.existsSync(target);
}

/** Lightweight H.264 preview of a segment for the editor (browser-friendly). */
async function makePreview(config, { source, target, signal }) {
  const tmp = `${target}.part.mp4`;
  await execute(
    config.ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-i", source,
      "-map", "0:v:0", "-map", "0:a?",
      "-vf", "scale=-2:540,fps=30", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", tmp],
    { timeout: 900000, signal }
  );
  fs.renameSync(tmp, target);
  return target;
}

/** Downsampled audio waveform peaks for the editor timeline. */
async function waveform(config, file, { points = 600, signal } = {}) {
  const media = await probe(config, file, { signal });
  if (!media.hasAudio) return { peaks: [], duration: media.duration };
  const rate = 2000;
  const chunks = [];
  await new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const child = spawn(config.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], { windowsHide: true });
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("waveform failed"))));
  });
  const buf = Buffer.concat(chunks);
  const samples = buf.length / 2;
  const per = Math.max(1, Math.floor(samples / points));
  const peaks = [];
  for (let i = 0; i < samples; i += per) {
    let max = 0;
    for (let j = i; j < Math.min(samples, i + per); j++) max = Math.max(max, Math.abs(buf.readInt16LE(j * 2)));
    peaks.push(Math.round((max / 32768) * 1000) / 1000);
  }
  return { peaks, duration: media.duration };
}

module.exports = { probe, outputFps, keyframeBefore, extractSegment, makeThumbnail, makePreview, waveform, parseRate };
