"use strict";

/** Express application factory. `createApp()` wires DB, queue, services and routes. */
const fs = require("fs");
const path = require("path");
const express = require("express");
const { ensureDirs, buildConfig } = require("./config");
const { configureLogger, log } = require("./logger");
const { openDatabase, backupDatabase } = require("./db");
const { Repo } = require("./repo");
const { SettingsStore } = require("./settings");
const { importLegacyJobs } = require("./legacy-import");
const { TaskQueue } = require("./queue");
const { Pipeline } = require("./pipeline");
const { ClipService } = require("./clip-service");
const { Diagnostics } = require("./diagnostics");
const { AppError } = require("./errors");
const { cleanupTemp } = require("./storage");

const { securityMiddleware } = require("./middleware/security");
const systemRoutes = require("./routes/system");
const projectRoutes = require("./routes/projects");
const clipRoutes = require("./routes/clips");
const mediaRoutes = require("./routes/media");

function createApp(overrides = {}) {
  const config = overrides.config || buildConfig(overrides);
  ensureDirs(config);
  configureLogger({ dir: config.dirs.logs, toFile: config.logToFile });

  const db = openDatabase(config.dbFile);
  const repo = new Repo(db);
  const settingsStore = new SettingsStore(db, config);
  const diagnostics = new Diagnostics(config);
  const migration = importLegacyJobs({ db, repo, config });

  const pipeline = new Pipeline({ config, repo, settingsStore, diagnostics });
  const services = { config, db, repo, settingsStore, diagnostics, pipeline, migration };
  const queue = new TaskQueue({
    repo,
    getSettings: () => settingsStore.getAll(),
    autoStart: config.startWorker,
    handlers: {
      process_project: {
        run: (task, ctx) => pipeline.processProject(task, ctx),
        onFinish: (task, status, error) => pipeline.onProjectTaskFinish(task, status, error),
      },
      render_clip: {
        run: (task, ctx) => services.clipService.runRenderTask(task, ctx),
        onFinish: (task, status, error) => {
          if (status !== "completed" && task.clipId) log.warn("Editor render did not complete", { clipId: task.clipId, status, error: error?.message });
        },
      },
    },
  });
  services.queue = queue;
  services.clipService = new ClipService({ config, repo, settingsStore, queue, pipeline, diagnostics });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(securityMiddleware(config));
  app.use(express.json({ limit: "512kb" }));

  app.use(systemRoutes(services));
  app.use(projectRoutes(services));
  app.use(clipRoutes(services));
  app.use(mediaRoutes(services));

  // Built UI (npm run build) → single URL: http://localhost:3001
  if (fs.existsSync(path.join(config.frontendDist, "index.html"))) {
    app.use(express.static(config.frontendDist, { index: "index.html", maxAge: "1h" }));
    app.get(/^\/(?!api\/|media\/|clips\/).*/, (_req, res) => res.sendFile(path.join(config.frontendDist, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res.json({ status: "success", message: "ClipForge AI API running. Interface: rode `npm run build` em frontend/ ou use http://localhost:5173." })
    );
  }

  app.use("/api", (_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Rota da API não encontrada.")));

  // Central error handler: friendly message, no stack traces or absolute paths to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, _next) => {
    if (error?.name === "MulterError") {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      const message = error.code === "LIMIT_FILE_SIZE" ? "Arquivo maior que o limite permitido." : "Erro no envio do arquivo.";
      return res.status(status).json({ error: message, code: error.code });
    }
    if (error?.type === "entity.parse.failed") return res.status(400).json({ error: "JSON inválido.", code: "BAD_JSON" });
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "Requisição grande demais.", code: "TOO_LARGE" });
    if (error instanceof AppError || error?.expose) {
      return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
    }
    const ref = Math.random().toString(36).slice(2, 8);
    log.error("Unhandled request error", { ref, method: req.method, path: req.path, error });
    res.status(500).json({ error: `Erro interno (ref ${ref}). Veja os logs em storage/logs.`, code: "INTERNAL" });
  });

  const maintenance = () => {
    try {
      const active = new Set(repo.tasksByStatus("running").map((t) => t.projectId));
      cleanupTemp(config, { hours: settingsStore.getAll().tempRetentionHours, activeProjectIds: active });
      backupDatabase(db, config.dirs.backups);
    } catch (error) {
      log.warn("Maintenance failed", { error });
    }
  };

  let maintenanceTimer = null;
  const start = () => {
    queue.recover();
    maintenance();
    maintenanceTimer = setInterval(maintenance, 6 * 3600 * 1000);
    maintenanceTimer.unref?.();
    diagnostics.run().catch(() => {});
  };

  /** Abort running work, wait for handlers to settle (max 8 s), then close the database. */
  const close = async () => {
    clearInterval(maintenanceTimer);
    await queue.shutdown(8000);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  };

  return { app, services, config, start, close };
}

module.exports = { createApp };
