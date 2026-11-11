"use strict";

/** Minimal structured logger: JSON lines to a daily file + readable console output. */
const fs = require("fs");
const path = require("path");

let logDir = null;

function configureLogger({ dir, toFile = true } = {}) {
  logDir = toFile && dir ? dir : null;
  if (logDir) fs.mkdirSync(logDir, { recursive: true });
}

function write(level, msg, ctx = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...ctx };
  if (ctx.error instanceof Error) {
    entry.error = { message: ctx.error.message, stack: ctx.error.stack?.split("\n").slice(0, 6) };
  }
  if (process.env.CLIPFORGE_QUIET !== "1") {
    const extra = Object.keys(ctx).length ? ` ${JSON.stringify({ ...ctx, error: entry.error?.message })}` : "";
    const line = `[${entry.ts.slice(11, 19)}] ${level.toUpperCase()} ${msg}${extra}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
  if (logDir) {
    const file = path.join(logDir, `clipforge-${entry.ts.slice(0, 10)}.log`);
    try {
      fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    } catch {
      /* logging must never crash the app */
    }
  }
}

const log = {
  info: (msg, ctx) => write("info", msg, ctx),
  warn: (msg, ctx) => write("warn", msg, ctx),
  error: (msg, ctx) => write("error", msg, ctx),
  debug: (msg, ctx) => (process.env.CLIPFORGE_DEBUG === "1" ? write("debug", msg, ctx) : undefined),
};

module.exports = { log, configureLogger };
