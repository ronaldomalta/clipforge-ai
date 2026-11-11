"use strict";

/**
 * File-system safety layer. Every delete goes through `safeRemove`, which only accepts
 * plain file names inside a managed storage directory — never a path from the client,
 * never the user's original recording.
 */
const fs = require("fs");
const path = require("path");
const { log } = require("./logger");

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/;

function isSafeName(name) {
  return typeof name === "string" && SAFE_NAME.test(name) && !name.includes("..");
}

/** Resolve `name` inside `dir`; returns null if it would escape the directory. */
function resolveInside(dir, name) {
  if (!isSafeName(name)) return null;
  const base = path.resolve(dir);
  const target = path.resolve(base, name);
  if (path.dirname(target) !== base) return null;
  return target;
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Delete a managed file. Throws if the name is unsafe; returns false if it didn't exist. */
function safeRemove(dir, name) {
  if (!name) return false;
  const target = resolveInside(dir, name);
  if (!target) throw new Error("Nome de arquivo inválido; exclusão bloqueada.");
  if (!fs.existsSync(target)) return false;
  const stat = fs.lstatSync(target);
  if (!stat.isFile()) throw new Error("Alvo de exclusão não é um arquivo comum.");
  fs.rmSync(target, { force: true });
  return true;
}

/** Remove a directory that must live inside one of the managed roots (work/uploads/segments). */
function safeRemoveDir(root, dir) {
  if (!dir || !isInside(root, dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function dirSize(dir) {
  let total = 0;
  let files = 0;
  if (!fs.existsSync(dir)) return { bytes: 0, files: 0 };
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
          files += 1;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { bytes: total, files };
}

function storageUsage(config) {
  const d = config.dirs;
  const parts = {
    clips: dirSize(d.clips),
    segments: dirSize(d.segments),
    uploads: dirSize(d.uploads),
    previews: dirSize(d.proxies),
    thumbs: dirSize(d.thumbs),
    captions: dirSize(d.captions),
    work: dirSize(d.work),
    cache: dirSize(d.cache),
    database: dirSize(d.db),
    backups: dirSize(d.backups),
  };
  const total = Object.values(parts).reduce((n, p) => n + p.bytes, 0);
  let free = null;
  try {
    const st = fs.statfsSync(d.storage);
    free = st.bavail * st.bsize;
  } catch {
    /* statfs unavailable */
  }
  return { totalBytes: total, freeBytes: free, parts };
}

/** Delete temp work dirs/partial files older than `hours` that don't belong to active tasks. */
function cleanupTemp(config, { hours = 24, activeProjectIds = new Set() } = {}) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  let removed = 0;
  for (const root of [config.dirs.work, config.dirs.uploads]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (activeProjectIds.has(entry.name)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > cutoff) continue;
        if (root === config.dirs.uploads && entry.isDirectory()) continue; // retained sources are handled by projects
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        log.warn("cleanup failed", { entry: entry.name, error });
      }
    }
  }
  // Partial render outputs
  for (const dir of [config.dirs.clips, config.dirs.proxies]) {
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!name.includes(".part.")) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { removed };
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base} (${i++})${ext}`);
  return candidate;
}

function slugify(text, max = 60) {
  return (
    String(text || "clipe")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9 _-]+/g, "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, max)
      .trim() || "clipe"
  );
}

module.exports = { isSafeName, resolveInside, isInside, safeRemove, safeRemoveDir, storageUsage, cleanupTemp, uniquePath, slugify, dirSize };
