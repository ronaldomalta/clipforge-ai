"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

process.env.CLIPFORGE_QUIET = process.env.CLIPFORGE_QUIET || "1";
process.env.CLIPFORGE_SKIP_DOTENV = "1"; // hermetic tests: ignore local .env files
const { createApp } = require("../src/app");
const { buildConfig } = require("../src/config");

function tempStorage(prefix = "cf-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Start a real HTTP server on a random port with an isolated storage directory. */
async function startServer({ storage = tempStorage(), startWorker = true, extra = {} } = {}) {
  const config = buildConfig({ storage, port: 0, startWorker, logToFile: false, extra });
  const instance = createApp({ config });
  const server = await new Promise((resolve) => {
    const s = instance.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;
  config.allowedOrigins.push(`http://localhost:${port}`);
  instance.start();
  const base = `http://127.0.0.1:${port}`;

  async function api(method, url, body, { headers = {}, raw = false } = {}) {
    const init = { method, headers: { "X-ClipForge-Client": "1", ...headers } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    let res;
    try {
      res = await fetch(base + url, init);
    } catch (error) {
      throw new Error(`fetch ${method} ${url} failed: ${error.cause?.code || error.cause?.message || error.message}`);
    }
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }

  async function waitProject(id, { timeout = 240000, until = ["completed", "failed", "canceled", "interrupted"] } = {}) {
    const start = Date.now();
    for (;;) {
      const { data } = await api("GET", `/api/projects/${id}`);
      if (until.includes(data.status)) return data;
      if (Date.now() - start > timeout) throw new Error(`timeout waiting project ${id}: ${data.status} ${data.step}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async function waitTask(id, timeout = 240000) {
    const start = Date.now();
    for (;;) {
      const { data } = await api("GET", `/api/tasks/${id}`);
      if (["completed", "failed", "canceled", "interrupted"].includes(data.status)) return data;
      if (Date.now() - start > timeout) throw new Error("timeout waiting task");
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async function stop() {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await instance.close();
  }

  return { ...instance, base, port, api, waitProject, waitTask, stop, storage };
}

/** Generate a real test video with FFmpeg (lavfi). */
function makeVideo(file, { duration = 20, width = 1280, height = 720, fps = 30, audio = true, tone = 440 } = {}) {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=${fps}:d=${duration}`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=48000:duration=${duration}`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", String(fps * 2));
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push(file);
  execFileSync("ffmpeg", args);
  return file;
}

function probeFile(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate", "-of", "json", file]);
  const data = JSON.parse(out.toString());
  const v = data.streams.find((s) => s.codec_type === "video");
  const a = data.streams.find((s) => s.codec_type === "audio");
  const [n, d] = (v?.avg_frame_rate || "0/1").split("/").map(Number);
  return { duration: Number(data.format.duration), video: v, audio: a, fps: d ? n / d : 0 };
}

async function uploadForm(file, options = {}) {
  const form = new FormData();
  const buf = fs.readFileSync(file);
  form.append("video", new Blob([buf], { type: "video/mp4" }), path.basename(file));
  for (const [k, v] of Object.entries(options)) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  return form;
}

module.exports = { startServer, makeVideo, probeFile, uploadForm, tempStorage };
