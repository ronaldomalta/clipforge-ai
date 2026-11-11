"use strict";

const express = require("express");
const { storageUsage, cleanupTemp } = require("../storage");
const { backupDatabase } = require("../db");
const { listRecordings } = require("../library");
const { execute } = require("../proc");
const { badRequest } = require("../errors");
const { WHISPER_MODELS } = require("../settings");
const { log } = require("../logger");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = function systemRoutes(s) {
  const r = express.Router();
  const modelDownload = { model: null, status: "idle", error: null, startedAt: null };

  r.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      version: require("../../package.json").version,
      uptimeSec: Math.round(process.uptime()),
      queue: { running: s.queue.running.size, queued: s.repo.tasksByStatus("queued").length },
    });
  });

  r.get("/api/system/diagnostics", wrap(async (req, res) => {
    res.json(await s.diagnostics.run({ force: req.query.refresh === "1" }));
  }));

  r.get("/api/system/info", wrap(async (_req, res) => {
    const d = await s.diagnostics.run();
    res.json({ system: d.system, gpu: d.gpu, storage: storageUsage(s.config), migration: s.migration });
  }));

  r.get("/api/settings", (_req, res) => res.json(s.settingsStore.getAll()));
  r.put("/api/settings", (req, res) => res.json(s.settingsStore.update(req.body)));

  r.get("/api/stats", (_req, res) => {
    const db = s.db;
    const projects = db.prepare("SELECT status, COUNT(*) n FROM projects GROUP BY status").all();
    const byStatus = Object.fromEntries(projects.map((p) => [p.status, p.n]));
    const clips = db.prepare("SELECT status, file_status, COUNT(*) n FROM clips GROUP BY status, file_status").all();
    let generated = 0, approved = 0, discarded = 0, pending = 0, live = 0;
    for (const c of clips) {
      generated += c.n;
      if (c.status === "approved" && c.file_status !== "deleted") approved += c.n;
      if (c.status === "discarded") discarded += c.n;
      if (c.status === "pending" && c.file_status !== "deleted") pending += c.n;
      if (c.file_status !== "deleted") live += c.n;
    }
    const processedSeconds = db
      .prepare("SELECT COALESCE(SUM(json_extract(media_json, '$.duration')), 0) AS s FROM projects WHERE status = 'completed'")
      .get().s;
    const recent = db
      .prepare("SELECT id, name, status, progress, step, created_at FROM projects ORDER BY created_at DESC LIMIT 6")
      .all()
      .map((p) => ({ id: p.id, name: p.name, status: p.status, progress: Math.round(p.progress), step: p.step, createdAt: p.created_at }));
    const usage = storageUsage(s.config);
    res.json({
      projects: {
        total: projects.reduce((n, p) => n + p.n, 0),
        completed: byStatus.completed || 0,
        processing: (byStatus.running || 0) + (byStatus.queued || 0),
        failed: (byStatus.failed || 0) + (byStatus.interrupted || 0) + (byStatus.canceled || 0),
      },
      clips: { generated, live, approved, discarded, pending },
      processedSeconds,
      storage: { totalBytes: usage.totalBytes, freeBytes: usage.freeBytes, clipsBytes: usage.parts.clips.bytes, segmentsBytes: usage.parts.segments.bytes },
      recent,
    });
  });

  r.get("/api/storage", (_req, res) => res.json(storageUsage(s.config)));

  r.post("/api/system/cleanup", (_req, res) => {
    const active = new Set(s.repo.tasksByStatus("running").map((t) => t.projectId));
    res.json(cleanupTemp(s.config, { hours: 0.01, activeProjectIds: active }));
  });

  r.post("/api/system/backup", (_req, res) => {
    const file = backupDatabase(s.db, s.config.dirs.backups, { force: true });
    res.json({ ok: true, file: file ? require("path").basename(file) : null });
  });

  r.get("/api/library/recordings", (_req, res) => {
    const dirs = s.settingsStore.getAll().recordingsDirs || [];
    res.json({ dirs: dirs.map((d) => require("path").basename(d)), items: listRecordings(dirs) });
  });

  // Explicit, user-initiated model download (never silent).
  r.get("/api/system/models/download", (_req, res) => res.json(modelDownload));
  r.post("/api/system/models/download", (req, res) => {
    const model = req.body?.model;
    if (!WHISPER_MODELS.includes(model)) throw badRequest("Modelo inválido.");
    if (modelDownload.status === "running") return res.status(409).json({ error: "Já existe um download em andamento.", ...modelDownload });
    Object.assign(modelDownload, { model, status: "running", error: null, startedAt: new Date().toISOString() });
    execute(s.config.python, [s.config.doctorScript, "--download", model], { timeout: 3 * 3600 * 1000 })
      .then(() => {
        modelDownload.status = "done";
        s.diagnostics.run({ force: true }).catch(() => {});
      })
      .catch((error) => {
        modelDownload.status = "failed";
        modelDownload.error = error.message.slice(-400);
        log.warn("Model download failed", { model, error: error.message });
      });
    res.status(202).json(modelDownload);
  });

  return r;
};
