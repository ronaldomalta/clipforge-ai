"use strict";

/** Dependency and hardware diagnostics (cached, refreshed on demand). */
const fs = require("fs");
const os = require("os");
const { execute } = require("./proc");

const MODEL_SIZES_MB = { tiny: 75, base: 145, small: 484, medium: 1530, "large-v3": 3090, turbo: 1620 };

function nodeStatus() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = major > 22 || (major === 22 && minor >= 13);
  return { ok, version: process.versions.node, hint: ok ? null : "Instale o Node.js 22 LTS (22.13+) ou 24 LTS." };
}

async function tryRun(cmd, args, timeout = 20000) {
  try {
    const r = await execute(cmd, args, { timeout });
    return { ok: true, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    return { ok: false, error: error.message.slice(0, 300) };
  }
}

class Diagnostics {
  constructor(config) {
    this.config = config;
    this.result = null;
    this.running = null;
  }

  cached() {
    return this.result;
  }

  async run({ force = false } = {}) {
    if (this.result && !force && Date.now() - this.result.checkedAtMs < 5 * 60 * 1000) return this.result;
    if (this.running) return this.running;
    this.running = this.collect().finally(() => {
      this.running = null;
    });
    this.result = await this.running;
    return this.result;
  }

  async collect() {
    const c = this.config;
    const [ffmpegV, ffprobeV, encoders, filters, python, gpu] = await Promise.all([
      tryRun(c.ffmpeg, ["-hide_banner", "-version"]),
      tryRun(c.ffprobe, ["-hide_banner", "-version"]),
      tryRun(c.ffmpeg, ["-hide_banner", "-encoders"]),
      tryRun(c.ffmpeg, ["-hide_banner", "-filters"]),
      tryRun(c.python, [c.doctorScript], 60000),
      tryRun("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], 10000),
    ]);

    const encText = encoders.stdout || "";
    const filtText = filters.stdout || "";
    let nvenc = { ok: false, available: /h264_nvenc/.test(encText) };
    if (nvenc.available) {
      const test = await tryRun(c.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:d=0.5", "-c:v", "h264_nvenc", "-f", "null", "-"], 30000);
      nvenc = { ok: test.ok, available: true, error: test.ok ? null : "NVENC listado, mas o teste de codificação falhou (driver/GPU indisponível)." };
    }

    let py = { ok: false, error: python.error || "Python não encontrado" };
    if (python.ok) {
      try {
        py = { ok: true, ...JSON.parse(python.stdout.trim().split(/\r?\n/).pop()) };
      } catch {
        py = { ok: false, error: "Saída inesperada do diagnóstico Python." };
      }
    }

    const fonts = fs.existsSync(c.fontsDir) ? fs.readdirSync(c.fontsDir).filter((f) => /\.(ttf|otf)$/i.test(f)) : [];
    let disk = null;
    try {
      const st = fs.statfsSync(c.dirs.storage);
      disk = { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
    } catch {
      /* ignore */
    }

    const checks = [
      { id: "node", label: "Node.js", ...nodeStatus() },
      {
        id: "ffmpeg", label: "FFmpeg", ok: ffmpegV.ok,
        version: ffmpegV.ok ? (ffmpegV.stdout.split("\n")[0] || "").replace(/^ffmpeg version /, "").split(" ")[0] : null,
        hint: ffmpegV.ok ? null : "Instale o FFmpeg (winget install Gyan.FFmpeg) ou defina FFMPEG_PATH no backend/.env.",
      },
      {
        id: "ffprobe", label: "FFprobe", ok: ffprobeV.ok,
        version: ffprobeV.ok ? (ffprobeV.stdout.split("\n")[0] || "").replace(/^ffprobe version /, "").split(" ")[0] : null,
        hint: ffprobeV.ok ? null : "Defina FFPROBE_PATH apontando para ffprobe.exe.",
      },
      { id: "libx264", label: "Codificador H.264 (libx264)", ok: /libx264/.test(encText), hint: /libx264/.test(encText) ? null : "Use uma build do FFmpeg com libx264 (ex.: gyan.dev full)." },
      { id: "libass", label: "Legendas embutidas (libass)", ok: /\bass\b/.test(filtText), hint: /\bass\b/.test(filtText) ? null : "Sua build do FFmpeg não tem libass: legendas embutidas não funcionarão." },
      { id: "nvenc", label: "Aceleração NVENC (GPU)", ok: nvenc.ok, optional: true, hint: nvenc.ok ? null : nvenc.error || "Opcional. Sem NVENC a renderização usa a CPU (libx264)." },
      { id: "python", label: "Python", ok: py.ok && !!py.python, version: py.python || null, hint: py.ok ? null : "Instale o Python 3.10–3.12 e rode install-windows.bat." },
      { id: "numpy", label: "NumPy (análise de áudio/vídeo)", ok: !!py.numpy, version: py.numpy || null, hint: py.numpy ? null : "Rode install-windows.bat (pip install -r ai-service/requirements.txt)." },
      { id: "faster_whisper", label: "faster-whisper (transcrição)", ok: !!py.faster_whisper, version: py.faster_whisper || null, optional: true, hint: py.faster_whisper ? null : "Necessário para legendas e análise de fala." },
      { id: "yt_dlp", label: "yt-dlp (YouTube)", ok: !!py.yt_dlp, version: py.yt_dlp || null, optional: true, hint: py.yt_dlp ? null : "python -m pip install -U yt-dlp" },
      {
        id: "cuda", label: "GPU para Whisper (CUDA)", ok: (py.cuda_devices || 0) > 0, optional: true,
        hint: (py.cuda_devices || 0) > 0 ? null : "Opcional. Sem CUDA a transcrição roda na CPU (mais lenta).",
      },
      { id: "fonts", label: "Fontes das legendas", ok: fonts.length > 0, hint: fonts.length ? null : "Pasta assets/fonts vazia." },
    ];

    return {
      checkedAt: new Date().toISOString(),
      checkedAtMs: Date.now(),
      ready: checks.filter((x) => !x.optional).every((x) => x.ok),
      checks,
      nvenc,
      python: py,
      gpu: gpu.ok ? gpu.stdout.trim().split("\n").map((line) => {
        const [name, memory, driver] = line.split(",").map((s) => s.trim());
        return { name, memory, driver };
      }) : [],
      models: Object.entries(MODEL_SIZES_MB).map(([name, sizeMB]) => ({ name, sizeMB, cached: (py.models_cached || []).includes(name) })),
      system: {
        platform: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        cpus: os.cpus()?.[0]?.model || "?",
        cores: os.cpus()?.length || 0,
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem(),
        disk,
        paths: { ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, python: c.python },
      },
    };
  }
}

module.exports = { Diagnostics, MODEL_SIZES_MB, nodeStatus };
