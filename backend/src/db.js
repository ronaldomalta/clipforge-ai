"use strict";

/**
 * SQLite persistence using Node's built-in `node:sqlite` (no native compilation on
 * Windows). Requires Node.js >= 22.13 (or 23.4+/24 LTS).
 */

// node:sqlite prints an ExperimentalWarning on some Node versions. It is expected; hide it.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function patchedEmitWarning(warning, ...args) {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (text && text.includes("SQLite")) return;
  return originalEmitWarning.call(process, warning, ...args);
};

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const MIGRATIONS = [
  {
    version: 1,
    name: "initial schema",
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('upload','youtube','library')),
        source_url TEXT,
        source_path TEXT,
        source_owned INTEGER NOT NULL DEFAULT 1,
        source_available INTEGER NOT NULL DEFAULT 0,
        media_json TEXT,
        settings_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','running','completed','failed','canceled','interrupted')),
        progress REAL NOT NULL DEFAULT 0,
        step TEXT,
        error TEXT,
        analysis_json TEXT,
        legacy INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        reviewed_at TEXT
      );

      CREATE TABLE clips (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        parent_id TEXT REFERENCES clips(id) ON DELETE SET NULL,
        filename TEXT,
        thumb_filename TEXT,
        srt_filename TEXT,
        segment_filename TEXT,
        segment_offset REAL,
        segment_duration REAL,
        start REAL NOT NULL,
        end REAL NOT NULL,
        peak REAL,
        score REAL,
        breakdown_json TEXT,
        reasons_json TEXT,
        penalties_json TEXT,
        title TEXT,
        transcript TEXT,
        captions_json TEXT,
        render_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','discarded')),
        file_status TEXT NOT NULL DEFAULT 'ok'
          CHECK (file_status IN ('ok','missing','rendering','failed','deleted')),
        error TEXT,
        size_bytes INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_clips_project ON clips(project_id);
      CREATE INDEX idx_clips_status ON clips(status);

      CREATE TABLE transcripts (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        language TEXT,
        model TEXT,
        engine TEXT,
        segments_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('process_project','render_clip')),
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        clip_id TEXT REFERENCES clips(id) ON DELETE CASCADE,
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','running','completed','failed','canceled','interrupted')),
        progress REAL NOT NULL DEFAULT 0,
        step TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_status ON tasks(status);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE exports (
        id TEXT PRIMARY KEY,
        clip_id TEXT REFERENCES clips(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        dest_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE legacy_imports (
        filename TEXT PRIMARY KEY,
        project_id TEXT,
        imported_at TEXT NOT NULL,
        note TEXT
      );
    `,
  },
];

function openDatabase(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)"
  );
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString()
      );
    });
  }
}

function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/** Consistent snapshot with VACUUM INTO; keeps the newest `keep` backups. */
function backupDatabase(db, backupDir, { keep = 7, force = false } = {}) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const target = path.join(backupDir, `clipforge-${stamp}.db`);
  if (fs.existsSync(target)) {
    if (!force) return null;
    fs.rmSync(target, { force: true });
  }
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const backups = fs
    .readdirSync(backupDir)
    .filter((f) => /^clipforge-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  while (backups.length > keep) fs.rmSync(path.join(backupDir, backups.shift()), { force: true });
  return target;
}

const now = () => new Date().toISOString();
const parseJson = (text, fallback = null) => {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

module.exports = { openDatabase, transaction, backupDatabase, now, parseJson };
