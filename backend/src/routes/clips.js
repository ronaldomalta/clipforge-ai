"use strict";

const express = require("express");
const { badRequest, notFound } = require("../errors");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = function clipRoutes(s) {
  const r = express.Router();
  const { repo, clipService, queue } = s;

  r.get("/api/clips", (req, res) => {
    const status = req.query.status;
    if (status && !["pending", "approved", "discarded"].includes(status)) throw badRequest("Filtro de status inválido.");
    const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
    res.json(repo.listClips({ status, projectId }));
  });

  r.get("/api/clips/:id", (req, res) => {
    const clip = repo.getClip(req.params.id);
    if (!clip || clip.fileStatus === "deleted") throw notFound("Clipe não encontrado.");
    res.json(clip);
  });

  r.post("/api/clips/:id/approve", (req, res) => res.json(clipService.setStatus([req.params.id], "approved")[0]));
  r.post("/api/clips/:id/discard", (req, res) => res.json(clipService.setStatus([req.params.id], "discarded")[0]));
  r.post("/api/clips/:id/reset", (req, res) => res.json(clipService.setStatus([req.params.id], "pending")[0]));

  r.post("/api/clips/batch", (req, res) => {
    const { ids, action, confirm } = req.body || {};
    if (action === "approve") return res.json({ clips: clipService.setStatus(ids, "approved") });
    if (action === "discard") return res.json({ clips: clipService.setStatus(ids, "discarded") });
    if (action === "pending") return res.json({ clips: clipService.setStatus(ids, "pending") });
    if (action === "delete") return res.json(clipService.deleteClips(ids, { confirm }));
    if (action === "export") return res.json(clipService.exportClips(ids));
    throw badRequest("Ação inválida (approve, discard, pending, delete, export).");
  });

  r.delete("/api/clips/:id", (req, res) => {
    res.json(clipService.deleteClips([req.params.id], { confirm: req.body?.confirm === true || req.query.confirm === "1" }));
  });

  // ---- editor ----
  r.get("/api/clips/:id/editor", (req, res) => res.json(clipService.editorData(req.params.id)));
  r.put("/api/clips/:id/captions", (req, res) => res.json({ cues: clipService.updateCaptions(req.params.id, req.body?.cues) }));
  r.post("/api/clips/:id/render", (req, res) => res.status(202).json(clipService.requestRender(req.params.id, req.body)));
  r.get("/api/clips/:id/preview", wrap(async (req, res) => {
    const file = await clipService.preview(req.params.id);
    res.sendFile(file, { headers: { "Cache-Control": "no-cache" } });
  }));
  r.get("/api/clips/:id/waveform", wrap(async (req, res) => res.json(await clipService.waveform(req.params.id))));
  r.post("/api/clips/:id/export", (req, res) => res.json(clipService.exportClips([req.params.id], { includeSrt: req.body?.includeSrt !== false })));

  r.get("/api/tasks/:id", (req, res) => {
    const task = repo.getTask(req.params.id);
    if (!task) throw notFound("Tarefa não encontrada.");
    res.json(task);
  });
  r.post("/api/tasks/:id/cancel", (req, res) => {
    if (!queue.cancel(req.params.id)) throw notFound("Tarefa não encontrada ou já finalizada.");
    res.json({ ok: true });
  });

  return r;
};
