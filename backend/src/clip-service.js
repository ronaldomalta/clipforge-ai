"use strict";

/** Review, deletion, editing (new versions) and export of clips. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { badRequest, notFound, conflict } = require("./errors");
const { safeRemove, safeRemoveDir, uniquePath, slugify } = require("./storage");
const { applyCueEdit, buildCues, cleanText } = require("./captions");
const { validateCaptionOptions } = require("./settings");
const { makePreview, waveform } = require("./media");
const { clipIdFor, chooseEncoder } = require("./pipeline");
const { log } = require("./logger");

const BUSY_PROJECT = new Set(["queued", "running"]);
const FORMATS = ["9:16", "16:9", "1:1"];
const FRAMINGS = ["fit_blur", "smart_crop", "center_crop", "custom"];
const QUALITIES = ["high", "balanced", "fast"];

class ClipService {
  constructor({ config, repo, settingsStore, queue, pipeline, diagnostics }) {
    Object.assign(this, { config, repo, settingsStore, queue, pipeline, diagnostics });
    this.previewJobs = new Map();
  }

  requireClip(id) {
    const row = this.repo.getClipRow(id);
    if (!row || row.file_status === "deleted") throw notFound("Clipe não encontrado.");
    return row;
  }

  assertProjectIdle(projectId) {
    const project = this.repo.getProjectRow(projectId);
    if (project && BUSY_PROJECT.has(project.status)) {
      throw conflict("Aguarde o processamento do projeto terminar antes de alterar ou excluir clipes.");
    }
    return project;
  }

  setStatus(ids, status) {
    if (!["approved", "discarded", "pending"].includes(status)) throw badRequest("Status inválido.");
    const rows = this.validateIds(ids);
    for (const row of rows) this.assertProjectIdle(row.project_id);
    this.repo.transaction(() => rows.forEach((row) => this.repo.updateClip(row.id, { status })));
    return rows.map((r) => this.repo.getClip(r.id));
  }

  validateIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw badRequest("Informe a lista de clipes.");
    if (new Set(ids).size !== ids.length) throw badRequest("A seleção contém clipes repetidos.");
    const rows = ids.map((id) => this.repo.getClipRow(id));
    if (rows.some((r) => !r || r.file_status === "deleted")) throw badRequest("A seleção contém clipes desconhecidos.");
    return rows;
  }

  /** Delete the files of one clip (all managed, by stored file name only). DB row becomes a tombstone. */
  deleteClipFiles(row) {
    const d = this.config.dirs;
    const removed = [];
    if (safeRemove(d.clips, row.filename)) removed.push(row.filename);
    safeRemove(d.thumbs, row.thumb_filename);
    safeRemove(d.captions, row.srt_filename);
    // Segment is shared between versions of the same clip: only delete when this is the last reference.
    if (row.segment_filename && this.repo.countSegmentRefs(row.segment_filename) <= 1) {
      safeRemove(d.segments, row.segment_filename);
      safeRemove(d.proxies, row.segment_filename.replace(/\.mkv$/, ".preview.mp4"));
      safeRemove(d.proxies, row.segment_filename.replace(/\.mkv$/, ".wave.json"));
    }
    return removed;
  }

  deleteClips(ids, { confirm } = {}) {
    if (confirm !== true) throw badRequest("Confirme a exclusão (confirm: true).");
    const rows = this.validateIds(ids);
    for (const row of rows) this.assertProjectIdle(row.project_id);
    if (rows.some((r) => this.repo.activeTaskForClip(r.id))) throw conflict("Um dos clipes está sendo renderizado.");
    let deleted = 0;
    for (const row of rows) {
      try {
        this.deleteClipFiles(row);
        this.repo.updateClip(row.id, { fileStatus: "deleted", status: "discarded", filename: null, thumbFilename: null, srtFilename: null, segmentFilename: null });
        deleted += 1;
      } catch (error) {
        log.error("Clip delete failed", { clipId: row.id, error });
        throw new Error(`Falha ao excluir o clipe ${row.idx}: ${error.message}`);
      }
    }
    return { deleted };
  }

  /** Finalize review: permanently delete discarded clips of a project; approved/pending stay. */
  finalizeReview(projectId, { confirm, discardPending = false } = {}) {
    if (confirm !== true) throw badRequest("Confirme a finalização da revisão (confirm: true).");
    const project = this.repo.getProjectRow(projectId);
    if (!project) throw notFound("Projeto não encontrado.");
    if (project.status !== "completed") throw conflict("Aguarde o projeto terminar antes de finalizar a revisão.");
    const rows = this.repo.clipRowsForProject(projectId).filter((r) => r.file_status !== "deleted");
    if (rows.some((r) => this.repo.activeTaskForClip(r.id))) throw conflict("Há um clipe sendo renderizado neste projeto.");
    const toDelete = rows.filter((r) => r.status === "discarded" || (discardPending && r.status === "pending"));
    let deleted = 0;
    for (const row of toDelete) {
      this.deleteClipFiles(row);
      this.repo.updateClip(row.id, { fileStatus: "deleted", status: "discarded", filename: null, thumbFilename: null, srtFilename: null, segmentFilename: null });
      deleted += 1;
    }
    this.repo.updateProject(projectId, { reviewedAt: new Date().toISOString() });
    const kept = rows.length - deleted;
    return { deleted, kept, project: this.repo.getProject(projectId) };
  }

  /** Legacy endpoint: keepIds are approved, all others of the project discarded and deleted. */
  finalizeLegacy(projectId, keepIds) {
    const project = this.repo.getProjectRow(projectId);
    if (!project) throw notFound("Projeto não encontrado.");
    if (project.status !== "completed") throw conflict("Aguarde o projeto terminar antes de revisar.");
    if (!Array.isArray(keepIds) || !keepIds.every((id) => typeof id === "string")) throw badRequest("Seleção inválida.");
    const rows = this.repo.clipRowsForProject(projectId).filter((r) => r.file_status !== "deleted");
    const known = new Set(rows.map((r) => r.id));
    if (new Set(keepIds).size !== keepIds.length || keepIds.some((id) => !known.has(id))) {
      throw badRequest("A seleção contém clipes desconhecidos ou repetidos.");
    }
    const keep = new Set(keepIds);
    this.repo.transaction(() => rows.forEach((r) => this.repo.updateClip(r.id, { status: keep.has(r.id) ? "approved" : "discarded" })));
    return this.finalizeReview(projectId, { confirm: true });
  }

  deleteProject(projectId, { confirm } = {}) {
    if (confirm !== true) throw badRequest("Confirme a exclusão do projeto (confirm: true).");
    const project = this.repo.getProjectRow(projectId);
    if (!project) throw notFound("Projeto não encontrado.");
    if (BUSY_PROJECT.has(project.status)) throw conflict("Cancele o processamento antes de excluir o projeto.");
    const rows = this.repo.clipRowsForProject(projectId);
    for (const row of rows) if (row.file_status !== "deleted") this.deleteClipFiles(row);
    // Managed copies only. Library imports point at the user's original file → never deleted.
    if (project.source_owned && project.source_type !== "library") {
      safeRemoveDir(this.config.dirs.uploads, path.join(this.config.dirs.uploads, projectId));
    }
    safeRemoveDir(this.config.dirs.work, path.join(this.config.dirs.work, projectId));
    this.repo.deleteProjectRow(projectId);
    return { deleted: true, clips: rows.length };
  }

  // ---------------- editor ----------------
  editorData(id) {
    const row = this.requireClip(id);
    const transcript = this.repo.getTranscript(row.project_id);
    let cues = row.captions_json ? JSON.parse(row.captions_json) : null;
    if (!cues && transcript && row.segment_filename) {
      const fmt = JSON.parse(row.render_json || "{}").format || "9:16";
      cues = buildCues(transcript.segments, row.segment_offset, row.segment_offset + row.segment_duration, { vertical: fmt === "9:16" });
    }
    return {
      clip: this.repo.getClip(id),
      segment: row.segment_filename
        ? { offset: row.segment_offset, duration: row.segment_duration, previewUrl: `/api/clips/${encodeURIComponent(id)}/preview` }
        : null,
      cues: cues || [],
      hasTranscript: !!transcript?.segments?.length,
      task: this.repo.activeTaskForClip(id),
    };
  }

  updateCaptions(id, cues) {
    const row = this.requireClip(id);
    if (!Array.isArray(cues) || cues.length > 2000) throw badRequest("Legendas inválidas.");
    const current = row.captions_json ? JSON.parse(row.captions_json) : [];
    const clean = cues.map((cue, i) => {
      const start = Number(cue.start);
      const end = Number(cue.end);
      const text = cleanText(cue.text).slice(0, 300);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw badRequest(`Legenda ${i + 1}: tempos inválidos.`);
      const original = current.find((c) => Math.abs(c.start - start) < 0.01 && Math.abs(c.end - end) < 0.01) || { start, end, words: null };
      return applyCueEdit({ ...original, start, end }, text);
    }).filter((c) => c.text);
    this.repo.updateClip(id, { captions: clean });
    return clean;
  }

  validateRenderRequest(row, body) {
    const render = JSON.parse(row.render_json || "{}");
    const start = Number(body.start ?? row.start);
    const end = Number(body.end ?? row.end);
    if (!row.segment_filename) throw conflict("Este clipe não tem trecho de origem salvo (clipes da versão anterior não podem ser reeditados).");
    const segStart = row.segment_offset;
    const segEnd = row.segment_offset + row.segment_duration;
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw badRequest("Início e fim inválidos.");
    if (end - start < 3 || end - start > 180) throw badRequest("A duração deve ficar entre 3 e 180 segundos.");
    if (start < segStart - 0.05 || end > segEnd + 0.05) throw badRequest("O intervalo precisa ficar dentro do trecho disponível para edição.");
    const format = body.format ?? render.format ?? "9:16";
    const framing = body.framing ?? render.framing ?? "fit_blur";
    const quality = body.quality ?? render.quality ?? "high";
    if (!FORMATS.includes(format)) throw badRequest("Formato inválido.");
    if (!FRAMINGS.includes(framing)) throw badRequest("Enquadramento inválido.");
    if (!QUALITIES.includes(quality)) throw badRequest("Qualidade inválida.");
    let custom = null;
    if (framing === "custom") {
      const c = body.custom || {};
      custom = { zoom: clamp(Number(c.zoom ?? 1), 0.4, 3), x: clamp(Number(c.x ?? 0), -1, 1), y: clamp(Number(c.y ?? 0), -1, 1) };
    }
    const captionsEnabled = body.captionsEnabled ?? render.captionsEnabled ?? false;
    const captionOptions = body.captionOptions
      ? { ...(render.captionOptions || this.settingsStore.getAll().captions), ...validateCaptionOptions(body.captionOptions) }
      : render.captionOptions || this.settingsStore.getAll().captions;
    const mode = body.mode === "replace" ? "replace" : "version";
    if (mode === "replace" && body.confirmReplace !== true) throw badRequest("Confirme a substituição do arquivo original (confirmReplace: true).");
    return {
      mode,
      render: {
        ...render, start, end, format, framing, custom, quality,
        autoEdit: body.autoEdit ?? render.autoEdit ?? false,
        captionsEnabled: !!captionsEnabled, captionOptions,
      },
    };
  }

  requestRender(id, body) {
    const row = this.requireClip(id);
    this.assertProjectIdle(row.project_id);
    if (this.repo.activeTaskForClip(id)) throw conflict("Este clipe já está sendo renderizado.");
    const { mode, render } = this.validateRenderRequest(row, body || {});
    const task = this.queue.enqueue({ type: "render_clip", projectId: row.project_id, clipId: id, payload: { mode, render }, step: "Na fila para renderizar" });
    return task;
  }

  async runRenderTask(task, { signal, progress }) {
    const row = this.requireClip(task.clipId);
    const project = this.repo.getProjectRow(row.project_id);
    const { mode, render } = task.payload;
    const transcript = this.repo.getTranscript(row.project_id);
    const cues = row.captions_json ? JSON.parse(row.captions_json) : null;
    const version = mode === "replace" ? row.version : this.repo.nextVersion(row.project_id, row.idx);
    const newId = mode === "replace" ? row.id : clipIdFor(row.project_id, row.idx, version);
    const filename = mode === "replace" ? `${row.id}.r${Date.now().toString(36)}.mp4` : `${newId}.mp4`;
    progress(2, "Renderizando versão editada...");
    fs.mkdirSync(this.pipeline.workDir(project.id), { recursive: true });
    const encoder = chooseEncoder(this.settingsStore.getAll(), this.diagnostics?.cached());
    try {
      const out = await this.pipeline.renderClipFiles({
        project, clipRow: row, render, captions: cues, transcriptSegments: transcript?.segments || null, signal, encoder, filename,
        onProgress: (f) => progress(2 + Math.round(f * 95), `Renderizando versão editada... ${Math.round(f * 100)}%`),
      });
      const renderInfo = { ...render, captionsApplied: out.captionsApplied, width: out.width, height: out.height, fps: out.fps, encoder: out.encoder, edited: true };
      if (mode === "replace") {
        const old = { filename: row.filename, thumb: row.thumb_filename, srt: row.srt_filename };
        this.repo.updateClip(row.id, {
          filename, thumbFilename: out.thumbFilename, srtFilename: out.srtFilename, start: render.start, end: render.end,
          render: renderInfo, sizeBytes: out.size, fileStatus: "ok", error: null, captions: out.cues ?? cues,
        });
        if (old.filename && old.filename !== filename) safeRemove(this.config.dirs.clips, old.filename);
        if (old.thumb && old.thumb !== out.thumbFilename) safeRemove(this.config.dirs.thumbs, old.thumb);
        if (old.srt && old.srt !== out.srtFilename) safeRemove(this.config.dirs.captions, old.srt);
      } else {
        this.repo.insertClip({
          id: newId, projectId: row.project_id, index: row.idx, version, parentId: row.id, filename,
          thumbFilename: out.thumbFilename, srtFilename: out.srtFilename, segmentFilename: row.segment_filename,
          segmentOffset: row.segment_offset, segmentDuration: row.segment_duration, start: render.start, end: render.end,
          peak: row.peak, score: row.score, breakdown: JSON.parse(row.breakdown_json || "null"),
          reasons: JSON.parse(row.reasons_json || "[]"), penalties: JSON.parse(row.penalties_json || "[]"),
          title: `${(row.title || "Clipe").replace(/ · v\d+$/, "")} · v${version}`, transcript: row.transcript,
          captions: out.cues ?? cues, render: renderInfo, status: "pending", fileStatus: "ok", sizeBytes: out.size,
        });
      }
      task.payload.resultClipId = newId;
      this.repo.updateTask(task.id, { payload: task.payload });
    } finally {
      try {
        fs.rmdirSync(this.pipeline.workDir(project.id)); // only if empty (a project run may be using it)
      } catch {
        /* not empty or already gone */
      }
    }
  }

  async preview(id) {
    const row = this.requireClip(id);
    if (!row.segment_filename) throw conflict("Este clipe não tem trecho de origem salvo.");
    const name = row.segment_filename.replace(/\.mkv$/, ".preview.mp4");
    const target = path.join(this.config.dirs.proxies, name);
    if (fs.existsSync(target)) return target;
    if (!this.previewJobs.has(name)) {
      const job = makePreview(this.config, { source: path.join(this.config.dirs.segments, row.segment_filename), target }).finally(() =>
        this.previewJobs.delete(name)
      );
      this.previewJobs.set(name, job);
    }
    await this.previewJobs.get(name);
    return target;
  }

  async waveform(id) {
    const row = this.requireClip(id);
    if (!row.segment_filename) return { peaks: [], duration: 0 };
    const cacheFile = path.join(this.config.dirs.proxies, row.segment_filename.replace(/\.mkv$/, ".wave.json"));
    if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const data = await waveform(this.config, path.join(this.config.dirs.segments, row.segment_filename), { points: 800 });
    fs.writeFileSync(cacheFile, JSON.stringify(data));
    return data;
  }

  // ---------------- export ----------------
  exportClips(ids, { includeSrt = true } = {}) {
    const rows = this.validateIds(ids);
    const settings = this.settingsStore.getAll();
    const outDir = settings.outputDir || this.config.defaultExportDir;
    fs.mkdirSync(outDir, { recursive: true });
    const results = [];
    for (const row of rows) {
      if (row.file_status !== "ok" || !row.filename) throw conflict(`O clipe ${row.idx} não tem arquivo para exportar.`);
      const project = this.repo.getProjectRow(row.project_id);
      const folder = path.join(outDir, slugify(project?.name || "ClipForge", 50));
      fs.mkdirSync(folder, { recursive: true });
      const base = `${String(row.idx).padStart(2, "0")} - ${slugify(row.title)}`;
      const dest = uniquePath(folder, base, ".mp4");
      fs.copyFileSync(path.join(this.config.dirs.clips, row.filename), dest, fs.constants.COPYFILE_EXCL);
      this.repo.insertExport({ id: crypto.randomUUID(), clipId: row.id, projectId: row.project_id, kind: "mp4", destPath: dest });
      const item = { clipId: row.id, file: dest };
      if (includeSrt && row.srt_filename) {
        const srtDest = dest.replace(/\.mp4$/, ".srt");
        fs.copyFileSync(path.join(this.config.dirs.captions, row.srt_filename), srtDest);
        this.repo.insertExport({ id: crypto.randomUUID(), clipId: row.id, projectId: row.project_id, kind: "srt", destPath: srtDest });
        item.srt = srtDest;
      }
      results.push(item);
    }
    return { folder: outDir, files: results };
  }
}

const clamp = (v, a, b) => (Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : a);

module.exports = { ClipService };
