"use strict";

/** YouTube import through yt-dlp (`python -m yt_dlp`). Only https YouTube URLs are accepted. */
const fs = require("fs");
const path = require("path");
const { execute } = require("./proc");
const { probe } = require("./media");
const { log } = require("./logger");

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

function normalizeYoutubeUrl(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  let id = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (url.pathname === "/watch") id = url.searchParams.get("v");
  else {
    const m = /^\/(shorts|live|embed)\/([^/?#]+)/.exec(url.pathname);
    if (m) id = m[2];
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return `https://www.youtube.com/watch?v=${id}`;
}

// Flags required by recent yt-dlp releases for YouTube; retried without them on older versions.
const MODERN_FLAGS = ["--js-runtimes", "node", "--remote-components", "ejs:github"];

async function ytdlp(config, args, opts) {
  try {
    return await execute(config.python, ["-m", "yt_dlp", ...MODERN_FLAGS, ...args], opts);
  } catch (error) {
    if (error.code === "CANCELED") throw error;
    if (/no such option|unrecognized arguments/i.test(error.message)) {
      return execute(config.python, ["-m", "yt_dlp", ...args], opts);
    }
    throw error;
  }
}

async function youtubeInfo(config, url) {
  const result = await ytdlp(
    config,
    ["--no-playlist", "--no-config", "--dump-single-json", "--skip-download", "--", url],
    { timeout: 120000 }
  );
  const video = JSON.parse(result.stdout);
  return {
    title: video.title,
    duration: video.duration,
    uploader: video.uploader,
    thumbnail: video.thumbnail,
    isLive: video.is_live === true,
  };
}

async function downloadYoutube(config, url, dir, { signal, onProgress } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const template = path.join(dir, "source.%(ext)s");
  const ffmpegLocation = path.isAbsolute(config.ffmpeg) ? ["--ffmpeg-location", path.dirname(config.ffmpeg)] : [];
  let lastError = null;
  for (const format of ["bv*[height<=1080]+ba/bv*+ba/b", "b"]) {
    for (const name of fs.readdirSync(dir)) if (name.startsWith("source.")) fs.rmSync(path.join(dir, name), { force: true });
    try {
      await ytdlp(
        config,
        [...ffmpegLocation, "--no-playlist", "--no-config", "--newline", "-f", format, "--merge-output-format", "mkv",
          "-o", template, "--", url],
        {
          signal,
          timeout: 4 * 3600 * 1000,
          onStdoutLine: (line) => {
            const m = /\[download\]\s+([\d.]+)%/.exec(line);
            if (m) onProgress?.(Number(m[1]) / 100);
          },
        }
      );
      const files = fs.readdirSync(dir).filter((n) => /^source\.(mp4|mkv|webm|mov)$/i.test(n)).map((n) => path.join(dir, n));
      for (const candidate of files) {
        const media = await probe(config, candidate).catch(() => null);
        if (media?.hasVideo) return candidate;
      }
      lastError = new Error(`O formato ${format} não gerou um vídeo válido.`);
    } catch (error) {
      if (error.code === "CANCELED") throw error;
      lastError = error;
      log.warn("yt-dlp attempt failed", { format, error: error.message.slice(0, 300) });
    }
  }
  throw new Error(`Não foi possível baixar o vídeo do YouTube: ${lastError?.message?.slice(0, 400) || "erro desconhecido"}`);
}

module.exports = { normalizeYoutubeUrl, youtubeInfo, downloadYoutube };
