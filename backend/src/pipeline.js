"use strict";

/**
 * Project processing pipeline:
 *   prepare → (download) → probe → AI analysis → select moments → segments → render → finalize.
 * Every stage is checkpointed so an interrupted/failed project can be resumed.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { probe, outputFps, extractSegment, makeThumbnail } = require("./media");
const { renderClip, outputSize } = require("./render");
const { buildCues, buildAss, buildSrt } = require("./captions");
const { runAnalysis } = require("./ai");
const { downloadYoutube } = require("./youtube");
const { safeRemove, safeRemoveDir } = require("./storage");
const { CancelError } = require("./errors");
const { log } = require("./logger");
const { now } = require("./db");

const fmtClock = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

function clipIdFor(projectId, index, version = 1) {
  const base = `${projectId}_${String(index).padStart(2, "0")}`;
  return version > 1 ? `${base}_v${version}` : base;
}

/** Copy bundled caption fonts into the FFmpeg working directory (relative fontsdir avoids Windows path escaping). */
function prepareFonts(config, workDir) {
  const target = path.join(workDir, "fonts");
  fs.mkdirSync(target, { recursive: true });
  if (fs.existsSync(config.fontsDir)) {
    for (const name of fs.readdirSync(config.fontsDir)) {
      if (/\.(ttf|otf)$/i.test(name)) fs.copyFileSync(path.join(config.fontsDir, name), path.join(target, name));
    }
  }
  return "fonts";
}

/** Evenly spaced windows: used when smart selection is OFF or the AI failed (clearly labelled, no score). */
function uniformMoments(total, count, duration, reason) {
  const length = Math.min(duration, total);
  // Never overlap: at most floor(total / length) windows, evenly spaced with equal gaps.
  const n = Math.max(1, Math.min(count, Math.floor(total / length)));
  const gap = (total - n * length) / (n + 1);
  const moments = [];
  for (let i = 0; i < n; i++) {
    const start = gap * (i + 1) + length * i;
    moments.push({ start, end: start + length, peak: null, score: null, breakdown: null, reasons: [reason], penalties: [], title: `Trecho ${i + 1}`, transcript: "" });
  }
  return moments;
}

function chooseEncoder(settings, diagnostics) {
  if (settings.encoder === "cpu") return "cpu";
  const nvencOk = diagnostics?.nvenc?.ok === true;
  if (settings.encoder === "nvenc") return nvencOk ? "nvenc" : "cpu";
  return nvencOk ? "nvenc" : "cpu";
}

/** Render with one retry (and CPU fallback when NVENC fails). */
async function renderWithRetry(config, opts) {
  try {
    return await renderClip(config, opts);
  } catch (error) {
    if (error instanceof CancelError || error.code === "CANCELED") throw error;
    log.warn("Render failed, retrying", { encoder: opts.encoder, error: error.message.slice(0, 400) });
    return renderClip(config, { ...opts, encoder: "cpu" });
  }
}

class Pipeline {
  constructor({ config, repo, settingsStore, diagnostics }) {
    this.config = config;
    this.repo = repo;
    this.settingsStore = settingsStore;
    this.diagnostics = diagnostics;
  }

  workDir(projectId) {
    return path.join(this.config.dirs.work, projectId);
  }

  /** Render (or re-render) a single clip file + thumbnail + SRT from its segment. */
  async renderClipFiles({ project, clipRow, render, captions, transcriptSegments, signal, onProgress, filename, encoder }) {
    const { config } = this;
    const segmentPath = path.join(config.dirs.segments, clipRow.segment_filename);
    if (!fs.existsSync(segmentPath)) throw new Error("O trecho de origem deste clipe não está mais disponível.");
    const segMedia = await probe(config, segmentPath, { signal });
    const start = render.start;
    const end = render.end;
    const length = end - start;
    const seek = start - clipRow.segment_offset;
    if (seek < -0.05 || seek + length > segMedia.duration + 0.25) throw new Error("O intervalo pedido está fora do trecho salvo.");

    const renderDir = path.join(this.workDir(project.id), `render-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(renderDir, { recursive: true });
    try {
      const [W, H] = outputSize(render.format, render.quality, segMedia);
      let assFile = null;
      let fontsDir = null;
      let cues = captions;
      if (render.captionsEnabled && !cues && transcriptSegments) {
        cues = buildCues(transcriptSegments, clipRow.segment_offset, clipRow.segment_offset + (clipRow.segment_duration || segMedia.duration), { vertical: H > W });
      }
      const visibleCues = (cues || []).filter((c) => c.end > start && c.start < end);
      if (render.captionsEnabled && visibleCues.length) {
        fs.writeFileSync(path.join(renderDir, "captions.ass"), buildAss(visibleCues, start, end, render.captionOptions, W, H), "utf8");
        assFile = "captions.ass";
        fontsDir = prepareFonts(config, renderDir);
      }
      const fps = outputFps(segMedia);
      const target = path.join(config.dirs.clips, filename);
      const zoomAt = render.autoEdit && Number.isFinite(render.peak) ? render.peak - start : null;
      const cropTrack = Array.isArray(render.cropTrack)
        ? render.cropTrack.filter(([t]) => t >= start - 1 && t <= end + 1).map(([t, x]) => [t - start, x])
        : null;
      const result = await renderWithRetry(config, {
        source: segmentPath, seek: Math.max(0, seek), length, media: segMedia, format: render.format, framing: render.framing,
        custom: render.custom, cropTrack, autoEdit: render.autoEdit, zoomAt, quality: render.quality, encoder,
        assFile, fontsDir, workDir: renderDir, target, signal, onProgress, fps,
      });

      const base = filename.replace(/\.mp4$/, "");
      let srtFilename = null;
      if (visibleCues.length) {
        srtFilename = `${base}.srt`;
        fs.writeFileSync(path.join(config.dirs.captions, srtFilename), buildSrt(visibleCues, start, end), "utf8");
      }
      const thumbFilename = `${base}.jpg`;
      const thumbAt = zoomAt != null ? Math.min(length - 0.2, Math.max(0, zoomAt)) : Math.min(length * 0.35, length - 0.2);
      await makeThumbnail(config, { video: target, at: thumbAt, target: path.join(config.dirs.thumbs, thumbFilename), signal }).catch(() => false);
      return {
        size: result.size,
        srtFilename,
        thumbFilename: fs.existsSync(path.join(config.dirs.thumbs, thumbFilename)) ? thumbFilename : null,
        captionsApplied: !!assFile,
        cues: cues || null,
        width: result.width,
        height: result.height,
        fps,
        encoder: result.encoder,
      };
    } finally {
      safeRemoveDir(config.dirs.work, renderDir);
    }
  }

  async processProject(task, { signal, progress }) {
    const { config, repo } = this;
    const projectId = task.projectId;
    let project = repo.getProjectRow(projectId);
    if (!project) throw new Error("Projeto não encontrado.");
    const settings = JSON.parse(project.settings_json);
    const appSettings = this.settingsStore.getAll();
    const workDir = this.workDir(projectId);
    fs.mkdirSync(workDir, { recursive: true });
    const warnings = [];

    const set = (pct, step, extra = {}) => {
      progress(pct, step);
      repo.updateProject(projectId, { progress: pct, step, ...extra });
    };
    const checkCancel = () => {
      if (signal.aborted) throw new CancelError();
    };

    repo.updateProject(projectId, { status: "running", error: null, startedAt: project.started_at || now(), finishedAt: null });
    set(1, "Preparando arquivo...");

    // ---------- 1. Source ----------
    let source = project.source_path;
    if (project.source_type === "youtube" && (!source || !fs.existsSync(source))) {
      if (!project.source_url) throw new Error("Link do YouTube ausente.");
      set(2, "Baixando vídeo do YouTube...");
      source = await downloadYoutube(config, project.source_url, path.join(config.dirs.uploads, projectId), {
        signal,
        onProgress: (f) => set(2 + Math.round(f * 16), `Baixando vídeo do YouTube... ${Math.round(f * 100)}%`),
      });
      repo.updateProject(projectId, { sourcePath: source, sourceAvailable: true, sourceOwned: true });
    }
    if (!source || !fs.existsSync(source)) {
      repo.updateProject(projectId, { sourceAvailable: false });
      throw new Error("O arquivo de origem não está mais disponível. Importe o vídeo novamente.");
    }
    checkCancel();
    const media = await probe(config, source, { signal });
    if (!media.hasVideo) throw new Error("O arquivo não contém uma faixa de vídeo.");
    repo.updateProject(projectId, { media });
    if (!media.hasAudio) warnings.push("O vídeo não tem áudio: análise de fala e de áudio desativadas; clipes saem com trilha silenciosa.");

    const durationSetting = settings.duration === "auto" ? "auto" : Number(settings.duration) || 30;
    const fixedDuration = durationSetting === "auto" ? 30 : durationSetting;

    // ---------- 2. Analysis ----------
    let moments = [];
    let analysisSummary = { engine: "uniform", warnings };
    let transcriptSegments = null;
    const needAi = settings.smart || settings.captions;
    if (needAi) {
      const output = path.join(workDir, "analysis.json");
      const aiConfig = {
        input: source,
        output,
        work_dir: workDir,
        cache_dir: path.join(config.dirs.cache, "analysis"),
        ffmpeg: config.ffmpeg,
        ffprobe: config.ffprobe,
        count: settings.count,
        duration: durationSetting,
        smart: !!settings.smart,
        transcribe: media.hasAudio && (settings.smart || settings.captions),
        language: settings.language || appSettings.language,
        model: appSettings.whisperModel,
        device: appSettings.device,
        allow_download: !!(settings.allowModelDownload || appSettings.allowModelDownload),
        vision: appSettings.visionEnabled !== false,
        weights: appSettings.weights,
        min_score: appSettings.minScore,
        media,
        output_aspect: settings.format === "16:9" ? 16 / 9 : settings.format === "1:1" ? 1 : 9 / 16,
      };
      try {
        let analysis = null;
        if (fs.existsSync(output)) {
          try {
            const cached = JSON.parse(fs.readFileSync(output, "utf8"));
            if (cached.request_hash && cached.request_hash === hashRequest(aiConfig)) analysis = cached;
          } catch {
            analysis = null;
          }
        }
        if (!analysis) {
          set(20, "Extraindo áudio...");
          analysis = await runAnalysis(config, { ...aiConfig, request_hash: hashRequest(aiConfig) }, {
            signal,
            onProgress: (ev) => {
              const pct = 20 + Math.round((Number(ev.progress) || 0) * 50);
              let label = ev.label || "Analisando...";
              if (ev.done != null && ev.total) label += ` (${fmtClock(ev.done)} de ${fmtClock(ev.total)})`;
              set(pct, label);
            },
          });
        }
        transcriptSegments = Array.isArray(analysis.segments) ? analysis.segments : null;
        if (transcriptSegments) {
          repo.saveTranscript(projectId, { language: analysis.language, model: analysis.model, engine: analysis.engine, segments: transcriptSegments });
        }
        warnings.push(...(analysis.warnings || []));
        analysisSummary = {
          engine: analysis.engine,
          language: analysis.language,
          model: analysis.model,
          device: analysis.device,
          capabilities: analysis.capabilities,
          transcribed: !!transcriptSegments?.length,
          stats: analysis.stats,
          candidates: analysis.stats?.candidates,
          insufficient: !!analysis.insufficient,
          message: analysis.message || null,
          warnings,
        };
        if (settings.smart) moments = analysis.moments || [];
      } catch (error) {
        if (error instanceof CancelError || error.code === "CANCELED") throw error;
        log.warn("AI analysis failed", { projectId, error: error.message });
        warnings.push(`A análise de IA falhou: ${error.message.slice(0, 300)}`);
        analysisSummary = { engine: "fallback", warnings, aiFailed: true };
        if (settings.smart) {
          moments = uniformMoments(media.duration, settings.count, fixedDuration, "A análise de IA falhou: corte distribuído uniformemente, sem pontuação.");
        }
      }
    }
    if (!settings.smart) {
      moments = uniformMoments(media.duration, settings.count, fixedDuration, "Seleção inteligente desligada: cortes distribuídos uniformemente pela gravação.");
      analysisSummary.engine = analysisSummary.engine === "uniform" ? "uniform" : analysisSummary.engine;
      analysisSummary.selection = "uniform";
    }
    if (settings.captions && !transcriptSegments?.length) {
      warnings.push("Legendas não aplicadas: não há transcrição disponível (faster-whisper ausente, modelo não baixado ou vídeo sem fala).");
    }
    analysisSummary.warnings = [...new Set(warnings)];
    repo.updateProject(projectId, { analysis: analysisSummary });
    checkCancel();

    // ---------- 3. Segments + render ----------
    const total = moments.length;
    const encoder = chooseEncoder(appSettings, this.diagnostics?.cached());
    const segDir = path.join(config.dirs.segments);
    if (total === 0) {
      set(98, "Finalizando...");
    }
    for (let i = 0; i < total; i++) {
      checkCancel();
      const m = moments[i];
      const index = i + 1;
      const clipId = clipIdFor(projectId, index);
      const existing = repo.getClipRow(clipId);
      if (existing && existing.file_status === "ok" && existing.filename && fs.existsSync(path.join(config.dirs.clips, existing.filename))) continue;

      const pctBase = 70 + Math.round((28 * i) / total);
      set(pctBase, `Salvando trecho de origem ${index}/${total}...`);
      const segmentFilename = `${clipId}.mkv`;
      const segmentPath = path.join(segDir, segmentFilename);
      let seg;
      if (existing?.segment_filename && fs.existsSync(segmentPath)) {
        seg = { offset: existing.segment_offset, duration: existing.segment_duration };
      } else {
        seg = await extractSegment(config, { source, start: m.start, end: m.end, media, target: segmentPath, signal });
      }

      const render = {
        start: m.start,
        end: m.end,
        peak: m.peak ?? null,
        format: settings.format,
        framing: settings.framing,
        custom: null,
        quality: settings.quality,
        autoEdit: !!settings.autoEdit,
        captionsEnabled: !!settings.captions && !!transcriptSegments?.length,
        captionOptions: { ...appSettings.captions, ...(settings.captionOptions || {}) },
        cropTrack: m.crop_track || null,
      };
      const clipRowStub = { id: clipId, segment_filename: segmentFilename, segment_offset: seg.offset, segment_duration: seg.duration };
      const baseRow = {
        id: clipId, projectId, index, filename: null, segmentFilename, segmentOffset: seg.offset, segmentDuration: seg.duration,
        start: m.start, end: m.end, peak: m.peak ?? null, score: m.score ?? null, breakdown: m.breakdown || null,
        reasons: m.reasons || [], penalties: m.penalties || [], title: m.title || `Momento ${index}`, transcript: m.transcript || "",
        render, fileStatus: "rendering",
      };
      if (!existing) repo.insertClip(baseRow);
      else repo.updateClip(clipId, { fileStatus: "rendering", error: null, segmentFilename, segmentOffset: seg.offset, segmentDuration: seg.duration });

      set(pctBase, `Renderizando clipe ${index}/${total}...`);
      try {
        const filename = `${clipId}.mp4`;
        const out = await this.renderClipFiles({
          project, clipRow: clipRowStub, render, captions: null, transcriptSegments, signal, encoder, filename,
          onProgress: (f) => set(pctBase + Math.round((28 / total) * f), `Renderizando clipe ${index}/${total}... ${Math.round(f * 100)}%`),
        });
        repo.updateClip(clipId, {
          filename, fileStatus: "ok", sizeBytes: out.size, thumbFilename: out.thumbFilename, srtFilename: out.srtFilename,
          captions: out.cues, render: { ...render, captionsApplied: out.captionsApplied, width: out.width, height: out.height, fps: out.fps, encoder: out.encoder },
        });
      } catch (error) {
        if (error instanceof CancelError || error.code === "CANCELED") {
          repo.updateClip(clipId, { fileStatus: "failed", error: "Renderização cancelada." });
          throw error;
        }
        log.error("Clip render failed", { clipId, error });
        repo.updateClip(clipId, { fileStatus: "failed", error: `Falha ao renderizar: ${error.message.slice(0, 500)}` });
        warnings.push(`Clipe ${index} falhou na renderização.`);
      }
    }

    // ---------- 4. Finalize ----------
    set(99, "Finalizando exportação...");
    const p = repo.getProjectRow(projectId);
    if (p.source_owned && appSettings.sourceRetention !== "full" && p.source_path && p.source_type !== "library") {
      // Managed copy (upload/YouTube) only — the user's original recording is never touched.
      safeRemoveDir(config.dirs.uploads, path.dirname(p.source_path));
      repo.updateProject(projectId, { sourceAvailable: false, sourcePath: null });
    }
    safeRemoveDir(config.dirs.work, workDir);
    const failed = repo.clipRowsForProject(projectId).filter((c) => c.file_status === "failed").length;
    const summary = { ...analysisSummary, warnings: [...new Set(warnings)] };
    if (total === 0) {
      summary.insufficient = true;
      summary.message = summary.message || "Nenhum momento atingiu a nota mínima. Nenhum clipe foi gerado para não inventar destaques.";
    } else if (settings.smart && total < settings.count && !summary.aiFailed) {
      summary.insufficient = true;
      summary.message = summary.message || `Só ${total} de ${settings.count} momentos atingiram a nota mínima.`;
    }
    repo.updateProject(projectId, {
      status: "completed",
      progress: 100,
      step: failed ? `Concluído com ${failed} falha(s)` : total === 0 ? "Concluído: nenhum momento forte encontrado" : "Concluído!",
      analysis: summary,
      finishedAt: now(),
    });
    progress(100, "Concluído!");
  }

  /** Called by the queue when a process_project task ends in a non-success state. */
  onProjectTaskFinish(task, status, error) {
    const project = this.repo.getProjectRow(task.projectId);
    if (!project || status === "completed") return;
    const step = status === "canceled" ? "Cancelado pelo usuário" : status === "interrupted" ? "Interrompido (pode ser retomado)" : "Falha";
    this.repo.updateProject(task.projectId, {
      status,
      step,
      error: status === "failed" ? friendlyError(error) : null,
      finishedAt: now(),
    });
    // Clips stuck in "rendering" are marked failed so the UI stays consistent.
    for (const c of this.repo.clipRowsForProject(task.projectId)) {
      if (c.file_status === "rendering") this.repo.updateClip(c.id, { fileStatus: "failed", error: "Renderização interrompida." });
    }
  }
}

function friendlyError(error) {
  const msg = String(error?.message || error || "Erro desconhecido");
  if (/Programa não encontrado: ffmpeg|ffprobe/i.test(msg)) return "FFmpeg/FFprobe não encontrado. Verifique o diagnóstico em Configurações.";
  return msg.replace(/[A-Z]:\\[^\s"']+/g, "<caminho>").slice(0, 800);
}

function hashRequest(cfg) {
  const relevant = {
    count: cfg.count, duration: cfg.duration, smart: cfg.smart, transcribe: cfg.transcribe, language: cfg.language,
    model: cfg.model, vision: cfg.vision, weights: cfg.weights, min_score: cfg.min_score, aspect: cfg.output_aspect,
    size: cfg.media?.size, dur: cfg.media?.duration,
  };
  return crypto.createHash("sha1").update(JSON.stringify(relevant)).digest("hex");
}

module.exports = { Pipeline, uniformMoments, clipIdFor, prepareFonts, chooseEncoder, friendlyError, fmtClock };
