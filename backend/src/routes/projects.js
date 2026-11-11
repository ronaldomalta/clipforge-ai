"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { parseProjectOptions } = require("../validation");
const { normalizeYoutubeUrl, youtubeInfo } = require("../youtube");
const { resolveRecording, VIDEO_EXT } = require("../library");
const { probe } = require("../media");
const { badRequest, notFound, conflict, AppError } = require("../errors");
const { mapClip } = require("../repo");
const { isSafeId } = require("../repo");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Shape used by the legacy /api/jobs endpoints (kept for backward compatibility). */
function legacyJob(project) {
  return {
    id: project.id,
    status: project.status,
    progress: project.progress,
    step: project.step,
    error: project.error,
    createdAt: project.createdAt,
    sourceName: project.name,
    settings: { ...project.settings, vertical: project.settings?.format === "9:16" },
    analysis: project.analysis,
    reviewedAt: project.reviewedAt,
    clips: (project.clips || []).map((c) => ({
      id: c.id, filename: c.filename, url: c.url, start: Math.round(c.start), duration: Math.round(c.duration),
      score: c.score, title: c.title, captionsApplied: c.captionsApplied,
    })),
  };
}

module.exports = function projectRoutes(s) {
  const r = express.Router();
  const { config, repo, queue, clipService } = s;
  const tmpUploads = path.join(config.dirs.uploads, "_incoming");
  fs.mkdirSync(tmpUploads, { recursive: true });

  const upload = multer({
    dest: tmpUploads,
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 30 },
    fileFilter(_req, file, cb) {
      const ext = path.extname(file.originalname || "").toLowerCase();
      if (!VIDEO_EXT.has(ext)) return cb(new AppError(400, "BAD_FORMAT", "Formato não suportado. Use MP4, MKV, MOV, WEBM ou AVI."));
      cb(null, true);
    },
  });

  const checkDiskSpace = (req, _res, next) => {
    const length = Number(req.headers["content-length"] || 0);
    try {
      const st = fs.statfsSync(config.dirs.storage);
      const free = st.bavail * st.bsize;
      if (length && free < length * 1.1 + 2 * 1024 ** 3) {
        return next(new AppError(507, "NO_SPACE", "Espaço em disco insuficiente para importar este vídeo."));
      }
    } catch {
      /* statfs unavailable: skip */
    }
    next();
  };

  function createProject({ id, name, sourceType, sourceUrl = null, sourcePath = null, sourceOwned, media = null, settings }) {
    repo.insertProject({
      id, name, sourceType, sourceUrl, sourcePath, sourceOwned, sourceAvailable: !!sourcePath || sourceType === "youtube", media, settings,
      status: "queued", progress: 0, step: "Na fila",
    });
    queue.enqueue({ type: "process_project", projectId: id, step: "Na fila" });
    return repo.getProject(id);
  }

  const handleUpload = wrap(async (req, res) => {
    if (!req.file) throw badRequest("Selecione um arquivo de vídeo.");
    const incoming = req.file.path;
    try {
      const settings = parseProjectOptions(req.body, s.settingsStore.getAll());
      const media = await probe(config, incoming).catch(() => null);
      if (!media?.hasVideo) throw badRequest("O arquivo enviado não é um vídeo válido.");
      const id = crypto.randomUUID();
      const dir = path.join(config.dirs.uploads, id);
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname).toLowerCase();
      const target = path.join(dir, `source${ext}`);
      fs.renameSync(incoming, target);
      const name = path.basename(req.file.originalname).replace(/[\u0000-\u001f]/g, "").slice(0, 160) || "Vídeo";
      const project = createProject({ id, name, sourceType: "upload", sourcePath: target, sourceOwned: true, media, settings });
      res.status(202).json(req.legacy ? legacyJob(project) : project);
    } catch (error) {
      fs.rmSync(incoming, { force: true });
      throw error;
    }
  });

  r.post("/api/projects/upload", checkDiskSpace, upload.single("video"), handleUpload);
  r.post("/api/jobs/upload", checkDiskSpace, (req, _res, next) => ((req.legacy = true), next()), upload.single("video"), handleUpload);

  r.post("/api/projects", wrap(async (req, res) => {
    const source = req.body?.source || {};
    const settings = parseProjectOptions(req.body?.options || req.body, s.settingsStore.getAll());
    const id = crypto.randomUUID();
    if (source.type === "youtube") {
      const url = normalizeYoutubeUrl(source.url);
      if (!url) throw badRequest("Link do YouTube inválido.");
      const project = createProject({ id, name: String(source.title || "YouTube").slice(0, 160), sourceType: "youtube", sourceUrl: url, sourceOwned: true, settings });
      return res.status(202).json(project);
    }
    if (source.type === "library") {
      const dirs = s.settingsStore.getAll().recordingsDirs || [];
      const file = resolveRecording(dirs, source.token);
      const media = await probe(config, file).catch(() => null);
      if (!media?.hasVideo) throw badRequest("A gravação não é um vídeo válido.");
      const project = createProject({ id, name: path.basename(file), sourceType: "library", sourcePath: file, sourceOwned: false, media, settings });
      return res.status(202).json(project);
    }
    throw badRequest("Fonte inválida: use upload, youtube ou library.");
  }));

  r.post("/api/jobs/youtube", (req, res) => {
    const url = normalizeYoutubeUrl(req.body?.url);
    if (!url) throw badRequest("Link do YouTube inválido.");
    const settings = parseProjectOptions(req.body, s.settingsStore.getAll());
    const project = createProject({ id: crypto.randomUUID(), name: "YouTube", sourceType: "youtube", sourceUrl: url, sourceOwned: true, settings });
    res.status(202).json(legacyJob(project));
  });

  r.post("/api/videos/info", wrap(async (req, res) => {
    const url = normalizeYoutubeUrl(req.body?.url);
    if (!url) throw badRequest("Link do YouTube inválido.");
    try {
      const info = await youtubeInfo(config, url);
      if (info.isLive) throw badRequest("Esta transmissão ainda está ao vivo. Aguarde terminar para importar.");
      res.json({ status: "success", ...info });
    } catch (error) {
      if (error.expose) throw error;
      throw new AppError(422, "YOUTUBE", "Não foi possível analisar o vídeo do YouTube. Verifique o link e se o yt-dlp está instalado/atualizado.");
    }
  }));

  r.get("/api/projects", (_req, res) => res.json(repo.listProjects()));
  r.get("/api/projects/:id", (req, res) => {
    const project = repo.getProject(req.params.id);
    if (!project) throw notFound("Projeto não encontrado.");
    project.task = repo.activeTaskForProject(project.id);
    res.json(project);
  });

  r.post("/api/projects/:id/cancel", (req, res) => {
    const project = repo.getProjectRow(req.params.id);
    if (!project) throw notFound("Projeto não encontrado.");
    const task = repo.activeTaskForProject(project.id);
    if (!task) throw conflict("Este projeto não está em processamento.");
    queue.cancel(task.id);
    res.json({ ok: true });
  });

  r.post("/api/projects/:id/retry", (req, res) => {
    const project = repo.getProjectRow(req.params.id);
    if (!project) throw notFound("Projeto não encontrado.");
    if (["queued", "running"].includes(project.status)) throw conflict("O projeto já está em processamento.");
    if (project.status === "completed") throw conflict("O projeto já foi concluído.");
    if (project.source_type !== "youtube" && !(project.source_path && fs.existsSync(project.source_path))) {
      throw conflict("O arquivo de origem não está mais disponível; importe o vídeo novamente.");
    }
    repo.updateProject(project.id, { status: "queued", step: "Na fila (retomando)", error: null });
    queue.enqueue({ type: "process_project", projectId: project.id, step: "Na fila (retomando)" });
    res.status(202).json(repo.getProject(project.id));
  });

  r.post("/api/projects/:id/review/finalize", (req, res) => {
    res.json(clipService.finalizeReview(req.params.id, { confirm: req.body?.confirm, discardPending: req.body?.discardPending === true }));
  });

  r.post("/api/projects/:id/export", (req, res) => {
    const project = repo.getProject(req.params.id);
    if (!project) throw notFound("Projeto não encontrado.");
    const ids = project.clips.filter((c) => c.status === "approved" && c.fileStatus === "ok").map((c) => c.id);
    if (!ids.length) throw conflict("Nenhum clipe aprovado para exportar.");
    res.json(clipService.exportClips(ids, { includeSrt: req.body?.includeSrt !== false }));
  });

  r.delete("/api/projects/:id", (req, res) => {
    res.json(clipService.deleteProject(req.params.id, { confirm: req.body?.confirm === true || req.query.confirm === "1" }));
  });

  // ---- legacy compatibility ----
  r.get("/api/jobs", (_req, res) => res.json(repo.listProjects().map((p) => legacyJob(repo.getProject(p.id)))));
  r.get("/api/jobs/:id", (req, res) => {
    if (!isSafeId(req.params.id)) throw notFound("Job not found");
    const project = repo.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Job not found" });
    res.json(legacyJob(project));
  });
  r.post("/api/jobs/:id/finalize-selection", (req, res) => {
    const result = clipService.finalizeLegacy(req.params.id, req.body?.keepIds);
    res.json({ success: true, removed: result.deleted, kept: result.kept, job: legacyJob(result.project) });
  });

  r.get("/api/projects/:id/transcript", (req, res) => {
    if (!repo.getProjectRow(req.params.id)) throw notFound("Projeto não encontrado.");
    res.json(repo.getTranscript(req.params.id) || { segments: [] });
  });

  void mapClip;
  return r;
};
