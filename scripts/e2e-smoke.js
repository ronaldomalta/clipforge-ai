#!/usr/bin/env node
"use strict";
/**
 * Real end-to-end run against a running ClipForge server (default http://127.0.0.1:3001):
 * upload → AI analysis → clips → approve/discard → finalize (delete discarded) → export,
 * plus an editor render with burned captions in every caption style.
 *
 *   node scripts/e2e-smoke.js path/to/video.mp4 [--base http://127.0.0.1:3001]
 * Prints a JSON report; exits 1 on failure.
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const video = args.find((a) => !a.startsWith("--"));
const base = (args.includes("--base") ? args[args.indexOf("--base") + 1] : null) || "http://127.0.0.1:3001";
if (!video || !fs.existsSync(video)) {
  console.error("Uso: node scripts/e2e-smoke.js caminho/do/video.mp4 [--base URL]");
  process.exit(2);
}

async function api(method, url, body) {
  const init = { method, headers: { "X-ClipForge-Client": "1" } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(base + url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${data?.error}`);
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const report = { video: path.basename(video), steps: [] };
  const t0 = Date.now();
  const form = new FormData();
  form.append("video", new Blob([fs.readFileSync(video)]), path.basename(video));
  for (const [k, v] of Object.entries({ count: 5, duration: 15, smart: true, captions: true, autoEdit: true, format: "9:16", quality: "fast" })) form.append(k, String(v));
  let project = await api("POST", "/api/projects/upload", form);
  report.steps.push("upload ok");
  let lastStep = "";
  while (!["completed", "failed", "canceled"].includes(project.status)) {
    await sleep(1000);
    project = await api("GET", `/api/projects/${project.id}`);
    if (project.step !== lastStep) {
      lastStep = project.step;
      console.error(`[${project.progress}%] ${project.step}`);
    }
  }
  if (project.status !== "completed") throw new Error(`Projeto terminou como ${project.status}: ${project.error}`);
  report.processingSeconds = Math.round((Date.now() - t0) / 1000);
  report.analysis = { engine: project.analysis.engine, capabilities: project.analysis.capabilities, warnings: project.analysis.warnings, message: project.analysis.message };
  report.clips = project.clips.map((c) => ({ id: c.id, start: c.start, end: c.end, score: c.score, title: c.title, reasons: c.reasons, penalties: c.penalties }));

  const [first, ...rest] = project.clips;
  if (first) {
    await api("POST", "/api/clips/batch", { ids: [first.id], action: "approve" });
    if (rest.length) await api("POST", "/api/clips/batch", { ids: rest.map((c) => c.id), action: "discard" });
    // Editor: captions typed by the user, burned in each style.
    await api("PUT", `/api/clips/${first.id}/captions`, {
      cues: [
        { start: first.start + 0.5, end: first.start + 3.5, text: "Meu Deus, não acredito!" },
        { start: first.start + 3.6, end: first.start + 7, text: "Explodiu tudo aqui" },
      ],
    });
    report.versions = [];
    for (const style of ["classic", "viral", "neon", "minimal"]) {
      const task = await api("POST", `/api/clips/${first.id}/render`, { captionsEnabled: true, captionOptions: { style }, framing: style === "viral" ? "smart_crop" : "fit_blur" });
      let t = task;
      while (!["completed", "failed", "canceled"].includes(t.status)) {
        await sleep(700);
        t = await api("GET", `/api/tasks/${task.id}`);
      }
      if (t.status !== "completed") throw new Error(`Render ${style} falhou: ${t.error}`);
      const v = await api("GET", `/api/clips/${t.payload.resultClipId}`);
      report.versions.push({ style, id: v.id, filename: v.filename, captionsApplied: v.captionsApplied });
    }
    const done = await api("POST", `/api/projects/${project.id}/review/finalize`, { confirm: true });
    report.finalize = { deleted: done.deleted, kept: done.kept };
  }
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error("E2E FALHOU:", error.message);
  process.exit(1);
});
