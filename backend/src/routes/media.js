"use strict";

/**
 * Media files are only served when (a) the name is a safe plain file name inside the
 * managed directory and (b) the database references it. Range requests are supported.
 */
const express = require("express");
const fs = require("fs");
const { resolveInside, slugify } = require("../storage");

module.exports = function mediaRoutes(s) {
  const r = express.Router();
  const { config, db } = s;

  const lookups = {
    clips: { dir: config.dirs.clips, sql: "SELECT id, title, idx FROM clips WHERE filename = ? AND file_status = 'ok'", type: "video/mp4" },
    thumbs: { dir: config.dirs.thumbs, sql: "SELECT id FROM clips WHERE thumb_filename = ? AND file_status != 'deleted'", type: "image/jpeg" },
    captions: { dir: config.dirs.captions, sql: "SELECT id, title, idx FROM clips WHERE srt_filename = ? AND file_status != 'deleted'", type: "application/x-subrip" },
  };

  const serve = (kind) => (req, res) => {
    const spec = lookups[kind];
    const name = req.params.file;
    const file = resolveInside(spec.dir, name);
    const row = file ? db.prepare(spec.sql).get(name) : null;
    if (!file || !row || !fs.existsSync(file)) return res.status(404).json({ error: "Arquivo não encontrado.", code: "NOT_FOUND" });
    const headers = { "Cache-Control": "private, max-age=60" };
    if (req.query.download === "1") {
      const ext = name.split(".").pop();
      const friendly = `${String(row.idx || "").padStart(2, "0")} - ${slugify(row.title || "clipe")}.${ext}`;
      headers["Content-Disposition"] = `attachment; filename="${friendly.replace(/"/g, "")}"`;
    }
    res.type(spec.type);
    res.sendFile(file, { headers, dotfiles: "deny" });
  };

  r.get("/media/clips/:file", serve("clips"));
  r.get("/media/thumbs/:file", serve("thumbs"));
  r.get("/media/captions/:file", serve("captions"));
  r.get("/clips/:file", serve("clips")); // legacy absolute URLs stored by v0.x
  return r;
};
