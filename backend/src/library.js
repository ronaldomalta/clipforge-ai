"use strict";

/**
 * Recordings folders configured by the user (e.g. OBS / TikTok LIVE Studio output).
 * Files are processed IN PLACE (no 20 GB upload copy) and are NEVER modified or deleted.
 * The client only ever sends an opaque token; the server resolves and re-validates it.
 */
const fs = require("fs");
const path = require("path");
const { badRequest } = require("./errors");
const { isInside } = require("./storage");

const VIDEO_EXT = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi"]);

const encodeToken = (dirIndex, rel) => Buffer.from(JSON.stringify({ d: dirIndex, r: rel })).toString("base64url");

function decodeToken(token) {
  if (typeof token !== "string" || token.length > 2000) return null;
  try {
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!Number.isInteger(value.d) || typeof value.r !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

function listRecordings(dirs, { maxDepth = 2, limit = 300 } = {}) {
  const items = [];
  dirs.forEach((root, d) => {
    if (!fs.existsSync(root)) return;
    const walk = (dir, depth) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (items.length >= limit) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < maxDepth && !entry.name.startsWith(".")) walk(full, depth + 1);
        else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
          try {
            const st = fs.statSync(full);
            items.push({
              token: encodeToken(d, path.relative(root, full)),
              name: entry.name,
              folder: path.basename(root),
              relativePath: path.relative(root, full),
              sizeBytes: st.size,
              modifiedAt: st.mtime.toISOString(),
            });
          } catch {
            /* ignore unreadable files */
          }
        }
      }
    };
    walk(root, 0);
  });
  return items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function resolveRecording(dirs, token) {
  const value = decodeToken(token);
  if (!value || !dirs[value.d]) throw badRequest("Gravação inválida.");
  const root = fs.realpathSync(dirs[value.d]);
  const candidate = path.resolve(root, value.r);
  if (!isInside(root, candidate)) throw badRequest("Gravação fora da pasta configurada.");
  if (!VIDEO_EXT.has(path.extname(candidate).toLowerCase())) throw badRequest("Formato de vídeo não suportado.");
  if (!fs.existsSync(candidate)) throw badRequest("A gravação não foi encontrada.");
  const real = fs.realpathSync(candidate);
  if (!isInside(root, real) || !fs.statSync(real).isFile()) throw badRequest("Gravação inválida.");
  return real;
}

module.exports = { listRecordings, resolveRecording, encodeToken, decodeToken, VIDEO_EXT };
