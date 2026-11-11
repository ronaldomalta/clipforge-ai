"use strict";

/** FFmpeg rendering: framing modes, auto-edit, burned captions, CPU/NVENC encoding. */
const fs = require("fs");
const { execute } = require("./proc");
const { probe } = require("./media");

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

const FORMATS = {
  "9:16": { high: [1080, 1920], fast: [720, 1280] },
  "16:9": { high: [1920, 1080], fast: [1280, 720] },
  "1:1": { high: [1080, 1080], fast: [720, 720] },
};

function outputSize(format, quality, media) {
  const f = FORMATS[format] || FORMATS["9:16"];
  let [w, h] = quality === "fast" ? f.fast : f.high;
  // Don't upscale a small landscape source for a landscape export.
  if (format === "16:9" && media?.height && media.height < h && media.width >= media.height) {
    h = even(media.height);
    w = even((h * 16) / 9);
  }
  return [w, h];
}

/** Piecewise-linear FFmpeg expression of `t` through points [[t, value], ...]. */
function piecewiseExpr(points) {
  if (!points.length) return "0";
  const pts = points.map(([t, v]) => [Math.max(0, Number(t)), Number(v)]).sort((a, b) => a[0] - b[0]);
  let expr = pts[0][1].toFixed(1);
  for (let i = 1; i < pts.length; i++) {
    const [t0, v0] = pts[i - 1];
    const [t1, v1] = pts[i];
    const delta = v1 - v0;
    if (Math.abs(delta) < 0.5) continue;
    const span = Math.max(0.05, t1 - t0);
    expr += `${delta >= 0 ? "+" : "-"}${Math.abs(delta).toFixed(1)}*clip((t-${t0.toFixed(2)})/${span.toFixed(2)}\\,0\\,1)`;
  }
  return expr;
}

/**
 * Build the -filter_complex graph. Pure function (unit-tested).
 * @returns {{graph:string, videoLabel:string, audioLabel:string}}
 */
function buildFilterGraph(opts) {
  const {
    W, H, srcW, srcH, fps,
    framing = "fit_blur",
    custom = null,
    cropTrack = null,
    autoEdit = false,
    zoomAt = null,
    length = 30,
    assFile = null,
    fontsDir = null,
    hasAudio = true,
  } = opts;
  const parts = [];
  const srcAspect = srcW / srcH;
  const outAspect = W / H;
  let base = "vbase";

  parts.push(`[0:v]fps=${fps},setsar=1[vin]`);

  const zoomExpr =
    autoEdit && Number.isFinite(zoomAt) && zoomAt > 0.4 && zoomAt < length - 0.4
      ? (() => {
          const a = Math.max(0, zoomAt - 0.35);
          const b = Math.min(length, zoomAt + 1.6);
          return `(1+0.07*if(between(t\\,${a.toFixed(2)}\\,${b.toFixed(2)})\\,sin(PI*(t-${a.toFixed(2)})/${(b - a).toFixed(2)})\\,0))`;
        })()
      : null;

  const nearlySameAspect = Math.abs(srcAspect - outAspect) / outAspect < 0.02;

  if (nearlySameAspect && framing !== "custom") {
    parts.push(`[vin]scale=${W}:${H}:flags=lanczos[vfit]`);
    if (zoomExpr) {
      parts.push(
        `[vfit]scale=w='trunc(iw*${zoomExpr}/2)*2':h='trunc(ih*${zoomExpr}/2)*2':eval=frame,crop=${W}:${H}:(iw-${W})/2:(ih-${H})/2[vbase]`
      );
    } else parts.push(`[vfit]null[vbase]`);
  } else if (framing === "smart_crop" || framing === "center_crop") {
    const cw = even(Math.min(srcW, srcH * outAspect));
    const ch = even(Math.min(srcH, srcW / outAspect));
    let xExpr = `(iw-${cw})/2`;
    if (framing === "smart_crop" && Array.isArray(cropTrack) && cropTrack.length > 1) {
      const pts = cropTrack.map(([t, cx]) => [t, Math.min(srcW - cw, Math.max(0, cx * srcW - cw / 2))]);
      xExpr = piecewiseExpr(pts);
    }
    parts.push(`[vin]crop=${cw}:${ch}:x='${xExpr}':y=(ih-${ch})/2,scale=${W}:${H}:flags=lanczos[vcrop]`);
    if (zoomExpr) {
      parts.push(
        `[vcrop]scale=w='trunc(iw*${zoomExpr}/2)*2':h='trunc(ih*${zoomExpr}/2)*2':eval=frame,crop=${W}:${H}:(iw-${W})/2:(ih-${H})/2[vbase]`
      );
    } else parts.push(`[vcrop]null[vbase]`);
  } else {
    // fit_blur (gameplay completa) and custom layout share the blurred background.
    const bw = even(W / 4);
    const bh = even(H / 4);
    parts.push(`[vin]split=2[vbgsrc][vfgsrc]`);
    parts.push(
      `[vbgsrc]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=10:2,eq=brightness=-0.05:saturation=1.15,scale=${W}:${H},setsar=1[vbg]`
    );
    const fit = Math.min(W / srcW, H / srcH);
    const zoom = framing === "custom" ? Math.min(3, Math.max(0.4, Number(custom?.zoom) || 1)) : 1;
    const fw = even(srcW * fit * zoom);
    const fh = even(srcH * fit * zoom);
    const ox = framing === "custom" ? Math.max(-1, Math.min(1, Number(custom?.x) || 0)) : 0;
    const oy = framing === "custom" ? Math.max(-1, Math.min(1, Number(custom?.y) || 0)) : 0;
    const x = Math.round((W - fw) / 2 + (ox * Math.abs(W - fw)) / 2);
    const y = Math.round((H - fh) / 2 + (oy * Math.abs(H - fh)) / 2);
    if (zoomExpr) {
      parts.push(`[vfgsrc]scale=${fw}:${fh}:flags=lanczos,scale=w='trunc(iw*${zoomExpr}/2)*2':h='trunc(ih*${zoomExpr}/2)*2':eval=frame[vfg]`);
      parts.push(`[vbg][vfg]overlay=x='${x}-(w-${fw})/2':y='${y}-(h-${fh})/2':eval=frame:shortest=1[vbase]`);
    } else {
      parts.push(`[vfgsrc]scale=${fw}:${fh}:flags=lanczos[vfg]`);
      parts.push(`[vbg][vfg]overlay=${x}:${y}:shortest=1[vbase]`);
    }
  }

  let current = base;
  if (autoEdit) {
    parts.push(`[${current}]eq=contrast=1.05:saturation=1.12:brightness=0.01[vcolor]`);
    current = "vcolor";
  }
  if (assFile) {
    const fontsOpt = fontsDir ? `:fontsdir=${fontsDir}` : "";
    parts.push(`[${current}]ass=filename=${assFile}${fontsOpt}[vsub]`);
    current = "vsub";
  }
  parts.push(`[${current}]format=yuv420p[vout]`);

  if (hasAudio) {
    const norm = autoEdit ? "loudnorm=I=-14:TP=-1.5:LRA=11," : "";
    parts.push(`[0:a:0]${norm}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
  } else {
    parts.push(`anullsrc=r=48000:cl=stereo[aout]`);
  }
  return { graph: parts.join(";"), videoLabel: "[vout]", audioLabel: "[aout]" };
}

function encoderArgs(encoder, quality, fps) {
  const gop = String(Math.max(1, Math.round(fps * 2)));
  if (encoder === "nvenc") {
    const q = { high: ["p5", "19"], balanced: ["p4", "21"], fast: ["p2", "24"] }[quality] || ["p5", "19"];
    return ["-c:v", "h264_nvenc", "-preset", q[0], "-tune", "hq", "-rc", "vbr", "-cq", q[1], "-b:v", "0",
      "-maxrate", "30M", "-bufsize", "60M", "-profile:v", "high", "-g", gop];
  }
  const q = { high: ["medium", "18"], balanced: ["faster", "20"], fast: ["veryfast", "23"] }[quality] || ["medium", "18"];
  return ["-c:v", "libx264", "-preset", q[0], "-crf", q[1], "-profile:v", "high", "-g", gop];
}

/**
 * Render one clip. `seek` is relative to `source` (segment file or full recording).
 */
async function renderClip(config, opts) {
  const {
    source, seek, length, media, format = "9:16", framing = "fit_blur", custom, cropTrack,
    autoEdit = false, zoomAt = null, quality = "high", encoder = "cpu", assFile = null,
    workDir, fontsDir = null, target, signal, onProgress, fps,
  } = opts;
  const [W, H] = outputSize(format, quality, media);
  const { graph } = buildFilterGraph({
    W, H, srcW: media.width, srcH: media.height, fps, framing, custom, cropTrack, autoEdit, zoomAt, length,
    assFile, fontsDir, hasAudio: media.hasAudio,
  });

  const tmp = `${target}.part.mp4`;
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostats", "-y",
    "-progress", "pipe:1",
    "-ss", Math.max(0, seek).toFixed(3),
    "-t", length.toFixed(3),
    "-i", source,
    "-filter_complex", graph,
    "-map", "[vout]", "-map", "[aout]",
    ...encoderArgs(encoder, quality, fps),
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-c:a", "aac", "-b:a", "192k",
    "-t", length.toFixed(3),
    "-movflags", "+faststart",
    "-max_muxing_queue_size", "2048",
    tmp,
  ];

  await execute(config.ffmpeg, args, {
    cwd: workDir,
    signal,
    timeout: Math.max(900000, length * 90000),
    onStdoutLine: (line) => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / length));
    },
  });

  if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) throw new Error("O vídeo renderizado ficou vazio.");
  const out = await probe(config, tmp, { signal });
  if (!out.hasVideo || !out.hasAudio) throw new Error("O clipe renderizado está sem vídeo ou sem áudio.");
  if (Math.abs(out.duration - length) > Math.max(1, length * 0.05)) {
    throw new Error(`Duração inesperada no clipe renderizado (${out.duration.toFixed(1)}s, esperado ${length.toFixed(1)}s).`);
  }
  fs.renameSync(tmp, target);
  return { width: W, height: H, duration: out.duration, size: fs.statSync(target).size, encoder };
}

module.exports = { renderClip, buildFilterGraph, outputSize, encoderArgs, piecewiseExpr, FORMATS };
