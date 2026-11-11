"use strict";

/**
 * Persistent background task queue with a concurrency limit, cancellation, a free-memory
 * gate and restart recovery. Tasks live in the `tasks` table; handlers do the work.
 */
const os = require("os");
const crypto = require("crypto");
const { CancelError } = require("./errors");
const { log } = require("./logger");

const MIN_FREE_BYTES = 1.0 * 1024 ** 3;

class TaskQueue {
  /**
   * @param {{repo:any, getSettings:()=>any, handlers:Record<string,{run:Function,onFinish?:Function}>}} opts
   */
  constructor({ repo, getSettings, handlers, autoStart = true }) {
    this.repo = repo;
    this.getSettings = getSettings;
    this.handlers = handlers;
    this.running = new Map(); // taskId -> AbortController
    this.autoStart = autoStart;
    this.idleWaiters = [];
    this.memoryTimer = null;
  }

  /** Restart recovery: interrupted running tasks, re-queue tasks that never started. */
  recover() {
    for (const task of this.repo.tasksByStatus("running")) {
      this.repo.updateTask(task.id, { status: "interrupted", step: "Interrompido pelo reinício do aplicativo" });
      this.handlers[task.type]?.onFinish?.(task, "interrupted", null);
    }
    if (this.autoStart) this.kick();
  }

  enqueue({ type, projectId = null, clipId = null, payload = {}, step = "Na fila" }) {
    const task = this.repo.insertTask({ id: crypto.randomUUID(), type, projectId, clipId, payload, step });
    if (this.autoStart) setImmediate(() => this.kick());
    return task;
  }

  cancel(taskId) {
    const task = this.repo.getTask(taskId);
    if (!task) return false;
    if (task.status === "queued") {
      this.repo.updateTask(taskId, { status: "canceled", step: "Cancelado" });
      this.handlers[task.type]?.onFinish?.(task, "canceled", null);
      return true;
    }
    const controller = this.running.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  limit() {
    const n = Number(this.getSettings()?.maxConcurrentJobs) || 1;
    return Math.min(2, Math.max(1, n));
  }

  kick() {
    if (this.kicking || this.stopped) return;
    this.kicking = true;
    try {
      while (this.running.size < this.limit()) {
        const next = this.repo.tasksByStatus("queued")[0];
        if (!next) break;
        if (os.freemem() < MIN_FREE_BYTES && this.running.size > 0) break; // wait for running work to finish
        if (os.freemem() < MIN_FREE_BYTES && this.running.size === 0) {
          this.repo.updateTask(next.id, {
            step: `Aguardando memória livre (${(os.freemem() / 1024 ** 3).toFixed(1)} GB disponíveis)`,
          });
          clearTimeout(this.memoryTimer);
          this.memoryTimer = setTimeout(() => this.kick(), 5000);
          break;
        }
        this.start(next);
      }
    } finally {
      this.kicking = false;
    }
    if (this.running.size === 0 && this.repo.tasksByStatus("queued").length === 0) {
      const waiters = this.idleWaiters.splice(0);
      waiters.forEach((resolve) => resolve());
    }
  }

  start(task) {
    const handler = this.handlers[task.type];
    const controller = new AbortController();
    this.running.set(task.id, controller);
    this.repo.updateTask(task.id, { status: "running", attempts: (task.attempts || 0) + 1, step: "Iniciando..." });
    const progress = (value, step) => {
      const patch = {};
      if (Number.isFinite(value)) patch.progress = Math.max(0, Math.min(100, value));
      if (step) patch.step = step;
      if (Object.keys(patch).length) this.repo.updateTask(task.id, patch);
    };
    const run = async () => {
      let status = "completed";
      let error = null;
      try {
        await handler.run(task, { signal: controller.signal, progress });
      } catch (err) {
        if (this.stopped) {
          status = "interrupted"; // app shutdown, not a user cancel → resumable
        } else if (err instanceof CancelError || err?.code === "CANCELED" || controller.signal.aborted) {
          status = "canceled";
        } else {
          status = "failed";
          error = err;
          log.error("Task failed", { taskId: task.id, type: task.type, error: err });
        }
      }
      try {
        this.repo.updateTask(task.id, {
          status,
          progress: status === "completed" ? 100 : undefined,
          step: { completed: "Concluído", canceled: "Cancelado", interrupted: "Interrompido" }[status] || "Falhou",
          error: error ? String(error.message || error).slice(0, 2000) : null,
        });
        handler.onFinish?.(task, status, error);
      } catch (hookError) {
        log.error("Task finish hook failed", { taskId: task.id, error: hookError });
      }
      this.running.delete(task.id);
      setImmediate(() => this.kick());
    };
    run();
  }

  /** Stop accepting work, abort running tasks and wait for them to settle. */
  async shutdown(timeoutMs = 8000) {
    this.stopped = true;
    clearTimeout(this.memoryTimer);
    for (const controller of this.running.values()) controller.abort();
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  /** Resolves when nothing is running or queued (used by tests). */
  whenIdle() {
    if (this.running.size === 0 && this.repo.tasksByStatus("queued").length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  isRunning(taskId) {
    return this.running.has(taskId);
  }
}

module.exports = { TaskQueue };
