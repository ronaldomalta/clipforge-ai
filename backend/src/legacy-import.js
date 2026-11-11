"use strict";

/**
 * One-time, non-destructive migration of the old storage/jobs/*.json records into SQLite.
 * JSON files are left untouched; imported files are tracked in `legacy_imports`.
 */
const fs = require("fs");
const path = require("path");
const { now } = require("./db");
const { isSafeId } = require("./repo");
const { log } = require("./logger");

function importLegacyJobs({ db, repo, config }) {
  const dir = config.dirs.jobs;
  if (!fs.existsSync(dir)) return { imported: 0, skipped: 0 };
  const done = new Set(db.prepare("SELECT filename FROM legacy_imports").all().map((r) => r.filename));
  let imported = 0;
  let skipped = 0;

  for (const filename of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    if (done.has(filename)) continue;
    let job;
    try {
      job = JSON.parse(fs.readFileSync(path.join(dir, filename), "utf8"));
    } catch (error) {
      db.prepare("INSERT INTO legacy_imports (filename, project_id, imported_at, note) VALUES (?, NULL, ?, ?)").run(
        filename, now(), `JSON inválido: ${error.message}`
      );
      skipped += 1;
      continue;
    }
    if (!isSafeId(job.id) || repo.getProjectRow(job.id)) {
      db.prepare("INSERT INTO legacy_imports (filename, project_id, imported_at, note) VALUES (?, ?, ?, ?)").run(
        filename, job.id ?? null, now(), "ignorado (id inválido ou já existente)"
      );
      skipped += 1;
      continue;
    }

    const s = job.settings || {};
    const settings = {
      count: Number(s.count) || 3,
      duration: Number(s.duration) || 30,
      format: s.vertical === false ? "16:9" : "9:16",
      framing: "fit_blur",
      quality: "high",
      smart: !!s.smart,
      captions: !!s.captions,
      autoEdit: !!s.autoEdit,
    };
    let status = ["completed", "failed"].includes(job.status) ? job.status : "interrupted";
    const sourceType = job.sourceType === "youtube" ? "youtube" : "upload";

    repo.transaction(() => {
      repo.insertProject({
        id: job.id,
        name: job.sourceName || (sourceType === "youtube" ? "YouTube" : "Vídeo importado"),
        sourceType,
        sourceUrl: sourceType === "youtube" ? job.url : null,
        sourcePath: null,
        sourceOwned: true,
        sourceAvailable: false,
        settings,
        status,
        progress: status === "completed" ? 100 : Number(job.progress) || 0,
        step: status === "completed" ? "Concluído (importado da versão anterior)" : job.step || "Importado",
        legacy: true,
        createdAt: job.createdAt || now(),
      });
      repo.updateProject(job.id, {
        error: job.error || null,
        analysis: job.analysis ? { ...job.analysis, legacy: true } : null,
        reviewedAt: job.reviewedAt || null,
        finishedAt: job.updatedAt || null,
      });
      (job.clips || []).forEach((clip, i) => {
        const fileName = typeof clip.filename === "string" ? path.basename(clip.filename) : null;
        const exists = fileName && fs.existsSync(path.join(config.dirs.clips, fileName));
        const id = isSafeId(clip.id) ? clip.id : `${job.id}_${String(i + 1).padStart(2, "0")}`;
        const start = Number(clip.start) || 0;
        const duration = Number(clip.duration) || settings.duration;
        repo.insertClip({
          id,
          projectId: job.id,
          index: i + 1,
          filename: exists ? fileName : null,
          start,
          end: start + duration,
          score: null,
          breakdown: clip.score != null ? { legacyScore: clip.score } : null,
          reasons: ["Gerado pela versão anterior do ClipForge (pontuação antiga não comparável com a escala 0–100)."],
          title: clip.title || `Momento ${i + 1}`,
          render: { format: settings.format, framing: "fit_blur", captionsApplied: !!clip.captionsApplied, legacy: true },
          status: job.reviewedAt ? "approved" : "pending",
          fileStatus: exists ? "ok" : "missing",
          sizeBytes: exists ? fs.statSync(path.join(config.dirs.clips, fileName)).size : null,
        });
      });
      db.prepare("INSERT INTO legacy_imports (filename, project_id, imported_at, note) VALUES (?, ?, ?, ?)").run(
        filename, job.id, now(), "importado"
      );
    });
    imported += 1;
  }
  if (imported || skipped) log.info("Legacy JSON migration", { imported, skipped });
  return { imported, skipped };
}

module.exports = { importLegacyJobs };
