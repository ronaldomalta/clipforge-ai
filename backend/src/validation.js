"use strict";

const { badRequest } = require("./errors");
const { validateCaptionOptions, QUALITIES } = require("./settings");

const DURATIONS = [15, 30, 45, 60, 90];
const MAX_CLIPS = 20;

const flag = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  throw badRequest("Valor booleano inválido.");
};

/** Validate generation options (JSON body or multipart fields). */
function parseProjectOptions(body, appSettings) {
  const b = body || {};
  const count = b.count === undefined ? 5 : Number(b.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_CLIPS) throw badRequest(`Quantidade de clipes deve ser de 1 a ${MAX_CLIPS}.`);

  let duration = b.duration === undefined ? 30 : b.duration;
  if (duration !== "auto") {
    duration = Number(duration);
    if (!DURATIONS.includes(duration)) throw badRequest("Duração inválida (15, 30, 45, 60, 90 ou auto).");
  }

  let format = b.format;
  if (format === undefined) format = flag(b.vertical, true) ? "9:16" : "16:9"; // legacy `vertical` flag
  if (!["9:16", "16:9", "1:1"].includes(format)) throw badRequest("Formato inválido.");

  const framing = b.framing ?? "fit_blur";
  if (!["fit_blur", "smart_crop", "center_crop"].includes(framing)) throw badRequest("Enquadramento inválido.");

  const quality = b.quality ?? appSettings.defaultQuality ?? "high";
  if (!QUALITIES.includes(quality)) throw badRequest("Qualidade inválida.");

  const language = b.language ?? null;
  if (language !== null && !["auto", "pt", "en"].includes(language)) throw badRequest("Idioma inválido.");

  let captionOptions = null;
  if (b.captionStyle !== undefined) captionOptions = validateCaptionOptions({ style: b.captionStyle });
  if (b.captionOptions !== undefined) {
    const raw = typeof b.captionOptions === "string" ? safeJson(b.captionOptions) : b.captionOptions;
    captionOptions = { ...(captionOptions || {}), ...validateCaptionOptions(raw) };
  }

  if (duration === "auto" && !flag(b.smart, true)) duration = 30;

  return {
    count,
    duration,
    format,
    framing,
    quality,
    smart: flag(b.smart, true),
    captions: flag(b.captions, false),
    autoEdit: flag(b.autoEdit, false),
    language,
    captionOptions,
    allowModelDownload: flag(b.allowModelDownload, false),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("JSON inválido.");
  }
}

module.exports = { parseProjectOptions, flag, DURATIONS, MAX_CLIPS };
