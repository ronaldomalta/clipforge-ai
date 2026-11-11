"use strict";

/** Data access + mapping between DB rows and API objects. */
const { now, parseJson, transaction } = require("./db");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const isSafeId = (id) => typeof id === "string" && SAFE_ID.test(id) && !id.includes("..");

const mediaUrl = (kind, filename) => (filename ? `/media/${kind}/${encodeURIComponent(filename)}` : null);

function mapClip(row, projectName) {
  if (!row) return null;
  const render = parseJson(row.render_json, {}) || {};
  const live = row.file_status !== "deleted";
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: projectName ?? row.project_name ?? null,
    index: row.idx,
    version: row.version,
    parentId: row.parent_id,
    title: row.title,
    start: row.start,
    end: row.end,
    duration: Math.round((row.end - row.start) * 100) / 100,
    peak: row.peak,
    score: row.score,
    breakdown: parseJson(row.breakdown_json, null),
    reasons: parseJson(row.reasons_json, []),
    penalties: parseJson(row.penalties_json, []),
    transcript: row.transcript,
    status: row.status,
    fileStatus: row.file_status,
    error: row.error,
    filename: row.filename,
    url: live && row.file_status === "ok" ? mediaUrl("clips", row.filename) : null,
    downloadUrl: live && row.file_status === "ok" ? `${mediaUrl("clips", row.filename)}?download=1` : null,
    thumbUrl: live ? mediaUrl("thumbs", row.thumb_filename) : null,
    srtUrl: live && row.srt_filename ? `${mediaUrl("captions", row.srt_filename)}?download=1` : null,
    captionsApplied: !!render.captionsApplied,
    hasCaptions: !!parseJson(row.captions_json, null)?.length,
    editable: !!row.segment_filename && live,
    render,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProject(row, clips = null, counts = null) {
  if (!row) return null;
  const settings = parseJson(row.settings_json, {});
  return {
    id: row.id,
    name: row.name,
    sourceName: row.name,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    sourceAvailable: !!row.source_available,
    status: row.status,
    progress: Math.round(row.progress),
    step: row.step,
    error: row.error,
    settings,
    media: parseJson(row.media_json, null),
    analysis: parseJson(row.analysis_json, null),
    legacy: !!row.legacy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    reviewedAt: row.reviewed_at,
    counts: counts || undefined,
    clips: clips || undefined,
  };
}

class Repo {
  constructor(db) {
    this.db = db;
  }

  // ---------- projects ----------
  insertProject(p) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, source_type, source_url, source_path, source_owned, source_available, media_json,
          settings_json, status, progress, step, legacy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        p.id, p.name, p.sourceType, p.sourceUrl ?? null, p.sourcePath ?? null, p.sourceOwned ? 1 : 0,
        p.sourceAvailable ? 1 : 0, p.media ? JSON.stringify(p.media) : null, JSON.stringify(p.settings),
        p.status || "queued", p.progress || 0, p.step || "Na fila", p.legacy ? 1 : 0, p.createdAt || ts, ts
      );
    return this.getProjectRow(p.id);
  }

  getProjectRow(id) {
    if (!isSafeId(id)) return null;
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) || null;
  }

  updateProject(id, patch) {
    const map = {
      name: "name", status: "status", progress: "progress", step: "step", error: "error",
      sourcePath: "source_path", sourceAvailable: "source_available", sourceOwned: "source_owned",
      media: "media_json", analysis: "analysis_json", settings: "settings_json",
      startedAt: "started_at", finishedAt: "finished_at", reviewedAt: "reviewed_at",
    };
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const col = map[key];
      if (!col) throw new Error(`Unknown project field ${key}`);
      sets.push(`${col} = ?`);
      if (col.endsWith("_json")) values.push(value == null ? null : JSON.stringify(value));
      else if (typeof value === "boolean") values.push(value ? 1 : 0);
      else values.push(value ?? null);
    }
    sets.push("updated_at = ?");
    values.push(now(), id);
    this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  listProjects() {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();
    const counts = this.clipCountsByProject();
    return rows.map((r) => mapProject(r, null, counts.get(r.id) || emptyCounts()));
  }

  getProject(id, { withClips = true } = {}) {
    const row = this.getProjectRow(id);
    if (!row) return null;
    const clips = withClips ? this.listClips({ projectId: id }) : null;
    const counts = this.clipCountsByProject().get(id) || emptyCounts();
    return mapProject(row, clips, counts);
  }

  deleteProjectRow(id) {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  clipCountsByProject() {
    const map = new Map();
    const rows = this.db
      .prepare(
        `SELECT project_id, status, file_status, COUNT(*) AS n FROM clips GROUP BY project_id, status, file_status`
      )
      .all();
    for (const r of rows) {
      const c = map.get(r.project_id) || emptyCounts();
      if (r.file_status === "deleted") c.deleted += r.n;
      else {
        c.total += r.n;
        c[r.status] += r.n;
      }
      map.set(r.project_id, c);
    }
    return map;
  }

  // ---------- clips ----------
  insertClip(c) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO clips (id, project_id, idx, version, parent_id, filename, thumb_filename, srt_filename, segment_filename,
          segment_offset, segment_duration, start, end, peak, score, breakdown_json, reasons_json, penalties_json, title,
          transcript, captions_json, render_json, status, file_status, error, size_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        c.id, c.projectId, c.index, c.version || 1, c.parentId ?? null, c.filename ?? null, c.thumbFilename ?? null,
        c.srtFilename ?? null, c.segmentFilename ?? null, c.segmentOffset ?? null, c.segmentDuration ?? null,
        c.start, c.end, c.peak ?? null, c.score ?? null, json(c.breakdown), json(c.reasons), json(c.penalties),
        c.title ?? null, c.transcript ?? null, json(c.captions), json(c.render), c.status || "pending",
        c.fileStatus || "ok", c.error ?? null, c.sizeBytes ?? null, c.createdAt || ts, ts
      );
    return this.getClipRow(c.id);
  }

  getClipRow(id) {
    if (!isSafeId(id)) return null;
    return this.db.prepare("SELECT * FROM clips WHERE id = ?").get(id) || null;
  }

  getClip(id) {
    const row = this.getClipRow(id);
    if (!row) return null;
    const project = this.getProjectRow(row.project_id);
    return mapClip(row, project?.name);
  }

  updateClip(id, patch) {
    const map = {
      filename: "filename", thumbFilename: "thumb_filename", srtFilename: "srt_filename",
      segmentFilename: "segment_filename", segmentOffset: "segment_offset", segmentDuration: "segment_duration",
      start: "start", end: "end", peak: "peak", score: "score", title: "title", transcript: "transcript",
      captions: "captions_json", render: "render_json", status: "status", fileStatus: "file_status",
      error: "error", sizeBytes: "size_bytes", reasons: "reasons_json", breakdown: "breakdown_json",
    };
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const col = map[key];
      if (!col) throw new Error(`Unknown clip field ${key}`);
      sets.push(`${col} = ?`);
      values.push(col.endsWith("_json") ? json(value) : value ?? null);
    }
    sets.push("updated_at = ?");
    values.push(now(), id);
    this.db.prepare(`UPDATE clips SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  listClips({ projectId, status, includeDeleted = false } = {}) {
    const where = [];
    const values = [];
    if (projectId) {
      where.push("c.project_id = ?");
      values.push(projectId);
    }
    if (status) {
      where.push("c.status = ?");
      values.push(status);
    }
    if (!includeDeleted) where.push("c.file_status != 'deleted'");
    const sql = `SELECT c.*, p.name AS project_name FROM clips c JOIN projects p ON p.id = c.project_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.created_at DESC, c.idx ASC, c.version ASC`;
    return this.db.prepare(sql).all(...values).map((r) => mapClip(r));
  }

  clipRowsForProject(projectId) {
    return this.db.prepare("SELECT * FROM clips WHERE project_id = ? ORDER BY idx, version").all(projectId);
  }

  countSegmentRefs(segmentFilename) {
    return this.db
      .prepare("SELECT COUNT(*) AS n FROM clips WHERE segment_filename = ? AND file_status != 'deleted'")
      .get(segmentFilename).n;
  }

  nextVersion(projectId, idx) {
    return (
      (this.db.prepare("SELECT MAX(version) AS v FROM clips WHERE project_id = ? AND idx = ?").get(projectId, idx).v || 0) + 1
    );
  }

  // ---------- transcripts ----------
  saveTranscript(projectId, { language, model, engine, segments }) {
    this.db
      .prepare(
        `INSERT INTO transcripts (project_id, language, model, engine, segments_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET language=excluded.language, model=excluded.model, engine=excluded.engine,
         segments_json=excluded.segments_json, created_at=excluded.created_at`
      )
      .run(projectId, language ?? null, model ?? null, engine ?? null, JSON.stringify(segments || []), now());
  }

  getTranscript(projectId) {
    const row = this.db.prepare("SELECT * FROM transcripts WHERE project_id = ?").get(projectId);
    if (!row) return null;
    return { language: row.language, model: row.model, engine: row.engine, segments: parseJson(row.segments_json, []) };
  }

  // ---------- tasks ----------
  insertTask(t) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, type, project_id, clip_id, payload_json, status, progress, step, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`
      )
      .run(t.id, t.type, t.projectId ?? null, t.clipId ?? null, json(t.payload), t.step || "Na fila", ts, ts);
    return this.getTask(t.id);
  }

  getTask(id) {
    if (!isSafeId(id)) return null;
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? mapTask(row) : null;
  }

  updateTask(id, patch) {
    const map = { status: "status", progress: "progress", step: "step", error: "error", attempts: "attempts", payload: "payload_json" };
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${map[key]} = ?`);
      values.push(key === "payload" ? json(value) : value ?? null);
    }
    sets.push("updated_at = ?");
    values.push(now(), id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  tasksByStatus(status) {
    return this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at").all(status).map(mapTask);
  }

  activeTaskForProject(projectId) {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1")
      .get(projectId);
    return row ? mapTask(row) : null;
  }

  activeTaskForClip(clipId) {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE clip_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1")
      .get(clipId);
    return row ? mapTask(row) : null;
  }

  // ---------- exports ----------
  insertExport(e) {
    this.db
      .prepare("INSERT INTO exports (id, clip_id, project_id, kind, dest_path, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.id, e.clipId ?? null, e.projectId ?? null, e.kind, e.destPath, now());
  }

  listExports(limit = 50) {
    return this.db.prepare("SELECT * FROM exports ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  transaction(fn) {
    return transaction(this.db, fn);
  }
}

function mapTask(row) {
  return {
    id: row.id,
    type: row.type,
    projectId: row.project_id,
    clipId: row.clip_id,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    progress: Math.round(row.progress),
    step: row.step,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const emptyCounts = () => ({ total: 0, pending: 0, approved: 0, discarded: 0, deleted: 0 });

module.exports = { Repo, mapClip, mapProject, isSafeId, mediaUrl };
