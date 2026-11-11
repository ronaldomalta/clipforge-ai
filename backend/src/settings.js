"use strict";

const fs = require("fs");
const path = require("path");
const { badRequest } = require("./errors");
const { now, parseJson } = require("./db");

const WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v3", "turbo"];
const CAPTION_STYLES = ["classic", "viral", "neon", "minimal"];
const CAPTION_POSITIONS = ["top", "middle", "lower", "bottom"];
const CAPTION_SIZES = ["S", "M", "L", "XL"];
const CAPTION_FONTS = ["Montserrat ExtraBold", "Montserrat Black", "Anton", "Bebas Neue"];
const QUALITIES = ["high", "balanced", "fast"];

const DEFAULT_WEIGHTS = {
  audio: 1.0,
  speech: 1.2,
  reaction: 1.4,
  visual: 1.0,
  context: 0.6,
  scene: 0.5,
  silencePenalty: 1.0,
  repetitionPenalty: 1.0,
  loudOnlyPenalty: 1.0,
};

function defaults(config) {
  return {
    outputDir: config.defaultExportDir,
    recordingsDirs: [],
    defaultQuality: "high",
    language: "auto",
    whisperModel: "base",
    device: "auto", // auto | cpu | cuda  (Whisper)
    encoder: "auto", // auto | cpu | nvenc (FFmpeg video encoder)
    maxConcurrentJobs: 1,
    sourceRetention: "segments", // segments | full
    tempRetentionHours: 24,
    allowModelDownload: false,
    visionEnabled: true,
    minScore: 50,
    weights: { ...DEFAULT_WEIGHTS },
    captions: {
      style: "viral",
      font: "Montserrat ExtraBold",
      color: "#FFFFFF",
      highlightColor: "#FF4FA0",
      size: "M",
      position: "lower",
      uppercase: true,
    },
  };
}

const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const oneOf = (v, list) => list.includes(v);

function validateDir(value, label, { mustExist }) {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${label}: informe uma pasta.`);
  const resolved = path.resolve(value.trim());
  if (!path.isAbsolute(value.trim())) throw badRequest(`${label}: use um caminho absoluto (ex.: C:\\Users\\PC\\Videos).`);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) throw badRequest(`${label}: não é permitido usar a raiz do disco.`);
  const lower = resolved.toLowerCase();
  if (/^[a-z]:\\windows(\\|$)/.test(lower) || /^[a-z]:\\program files/.test(lower) || /^\/(etc|bin|usr|proc|sys)(\/|$)/.test(lower)) {
    throw badRequest(`${label}: pasta do sistema não permitida.`);
  }
  if (mustExist && !(fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())) {
    throw badRequest(`${label}: a pasta não existe (${path.basename(resolved)}).`);
  }
  return resolved;
}

/** Validate a partial settings patch and return the normalized patch. */
function validatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw badRequest("Configurações inválidas.");
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "outputDir":
        out.outputDir = validateDir(value, "Pasta de saída", { mustExist: false });
        break;
      case "recordingsDirs":
        if (!Array.isArray(value) || value.length > 5) throw badRequest("Informe até 5 pastas de gravações.");
        out.recordingsDirs = value
          .filter((v) => typeof v === "string" && v.trim())
          .map((v) => validateDir(v, "Pasta de gravações", { mustExist: true }));
        break;
      case "defaultQuality":
        if (!oneOf(value, QUALITIES)) throw badRequest("Qualidade inválida.");
        out[key] = value;
        break;
      case "language":
        if (!oneOf(value, ["auto", "pt", "en"])) throw badRequest("Idioma inválido.");
        out[key] = value;
        break;
      case "whisperModel":
        if (!oneOf(value, WHISPER_MODELS)) throw badRequest("Modelo de IA inválido.");
        out[key] = value;
        break;
      case "device":
        if (!oneOf(value, ["auto", "cpu", "cuda"])) throw badRequest("Preferência de dispositivo inválida.");
        out[key] = value;
        break;
      case "encoder":
        if (!oneOf(value, ["auto", "cpu", "nvenc"])) throw badRequest("Codificador inválido.");
        out[key] = value;
        break;
      case "maxConcurrentJobs":
        if (!Number.isInteger(value) || value < 1 || value > 2) throw badRequest("Processamentos simultâneos: 1 ou 2.");
        out[key] = value;
        break;
      case "sourceRetention":
        if (!oneOf(value, ["segments", "full"])) throw badRequest("Política de retenção inválida.");
        out[key] = value;
        break;
      case "tempRetentionHours":
        if (!Number.isInteger(value) || value < 1 || value > 24 * 30) throw badRequest("Retenção de temporários inválida.");
        out[key] = value;
        break;
      case "allowModelDownload":
      case "visionEnabled":
        if (typeof value !== "boolean") throw badRequest(`${key} deve ser verdadeiro ou falso.`);
        out[key] = value;
        break;
      case "minScore":
        if (typeof value !== "number" || value < 0 || value > 90) throw badRequest("Nota mínima deve estar entre 0 e 90.");
        out[key] = value;
        break;
      case "weights": {
        if (!value || typeof value !== "object") throw badRequest("Pesos inválidos.");
        const weights = {};
        for (const [k, v] of Object.entries(value)) {
          if (!(k in DEFAULT_WEIGHTS)) throw badRequest(`Peso desconhecido: ${k}`);
          if (typeof v !== "number" || v < 0 || v > 5) throw badRequest(`Peso ${k} deve estar entre 0 e 5.`);
          weights[k] = v;
        }
        out.weights = weights;
        break;
      }
      case "captions":
        out.captions = validateCaptionOptions(value);
        break;
      default:
        throw badRequest(`Configuração desconhecida: ${key}`);
    }
  }
  return out;
}

function validateCaptionOptions(value, { partial = true } = {}) {
  if (!value || typeof value !== "object") throw badRequest("Opções de legenda inválidas.");
  const out = {};
  if (value.style !== undefined) {
    if (!oneOf(value.style, CAPTION_STYLES)) throw badRequest("Estilo de legenda inválido.");
    out.style = value.style;
  }
  if (value.font !== undefined) {
    if (!oneOf(value.font, CAPTION_FONTS)) throw badRequest("Fonte de legenda inválida.");
    out.font = value.font;
  }
  for (const key of ["color", "highlightColor"]) {
    if (value[key] !== undefined) {
      if (!isHex(value[key])) throw badRequest("Cor inválida (use #RRGGBB).");
      out[key] = value[key].toUpperCase();
    }
  }
  if (value.size !== undefined) {
    if (!oneOf(value.size, CAPTION_SIZES)) throw badRequest("Tamanho de legenda inválido.");
    out.size = value.size;
  }
  if (value.position !== undefined) {
    if (!oneOf(value.position, CAPTION_POSITIONS)) throw badRequest("Posição de legenda inválida.");
    out.position = value.position;
  }
  if (value.uppercase !== undefined) out.uppercase = !!value.uppercase;
  if (!partial && Object.keys(out).length === 0) throw badRequest("Opções de legenda vazias.");
  return out;
}

class SettingsStore {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  getAll() {
    const base = defaults(this.config);
    for (const row of this.db.prepare("SELECT key, value_json FROM settings").all()) {
      const value = parseJson(row.value_json);
      if (value === null || !(row.key in base)) continue;
      if (row.key === "weights" || row.key === "captions") base[row.key] = { ...base[row.key], ...value };
      else base[row.key] = value;
    }
    return base;
  }

  update(patch) {
    const clean = validatePatch(patch);
    const current = this.getAll();
    const stmt = this.db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at"
    );
    for (const [key, value] of Object.entries(clean)) {
      const merged = key === "weights" || key === "captions" ? { ...current[key], ...value } : value;
      stmt.run(key, JSON.stringify(merged), now());
    }
    return this.getAll();
  }
}

module.exports = {
  SettingsStore,
  defaults,
  validateCaptionOptions,
  DEFAULT_WEIGHTS,
  WHISPER_MODELS,
  CAPTION_STYLES,
  CAPTION_POSITIONS,
  CAPTION_SIZES,
  CAPTION_FONTS,
  QUALITIES,
};
