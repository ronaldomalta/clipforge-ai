"use strict";

/**
 * Caption generation: word-timed cues → styled ASS (libass, burned in by FFmpeg) and
 * plain SRT for separate export. All times in cues are ABSOLUTE source seconds; they
 * are converted to clip-relative time when writing files.
 */

const STYLE_PRESETS = {
  classic: { highlight: false, outline: 5, shadow: 2, glow: false, box: false, scale: 1.0, bold: 0 },
  viral: { highlight: true, outline: 6, shadow: 3, glow: false, box: false, scale: 1.1, bold: 0, pop: true },
  neon: { highlight: true, outline: 4, shadow: 0, glow: true, box: false, scale: 1.0, bold: 0 },
  minimal: { highlight: false, outline: 0, shadow: 0, glow: false, box: true, scale: 0.72, bold: 0 },
};
const SIZE_PX = { S: 64, M: 80, L: 96, XL: 116 };

function assColor(hex, alpha = 0) {
  const clean = /^#?[0-9a-fA-F]{6}$/.test(hex || "") ? hex.replace("#", "") : "FFFFFF";
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${b}${g}${r}`.toUpperCase();
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}

const cleanText = (text) =>
  String(text || "")
    .replace(/[{}]/g, "")
    .replace(/\\/g, "/")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Even word timings for text without per-word timestamps (e.g. after manual edits). */
function distributeWords(text, start, end) {
  const words = cleanText(text).split(" ").filter(Boolean);
  if (!words.length) return [];
  const totalChars = words.reduce((n, w) => n + w.length + 1, 0);
  let t = start;
  return words.map((word) => {
    const span = ((end - start) * (word.length + 1)) / totalChars;
    const item = { word, start: t, end: t + span };
    t += span;
    return item;
  });
}

/**
 * Group transcript words that fall inside [start, end] into short, readable cues.
 * @param segments transcript segments [{start,end,text,words?:[{start,end,word}]}]
 */
function buildCues(segments, start, end, { vertical = true } = {}) {
  const maxWords = vertical ? 4 : 7;
  const maxChars = vertical ? 24 : 42;
  const words = [];
  for (const seg of segments || []) {
    if (!(Number(seg.end) > start && Number(seg.start) < end)) continue;
    const segWords =
      Array.isArray(seg.words) && seg.words.length
        ? seg.words.map((w) => ({ word: cleanText(w.word), start: Number(w.start), end: Number(w.end) }))
        : distributeWords(seg.text, Number(seg.start), Number(seg.end));
    for (const w of segWords) {
      if (!w.word) continue;
      const mid = (w.start + w.end) / 2;
      if (mid >= start && mid <= end) words.push({ ...w, start: Math.max(w.start, start), end: Math.min(w.end, end) });
    }
  }
  const cues = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    cues.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((w) => w.word).join(" "),
      words: current,
    });
    current = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = current[current.length - 1];
    const chars = current.reduce((n, x) => n + x.word.length + 1, 0) + w.word.length;
    if (prev && (w.start - prev.end > 0.6 || current.length >= maxWords || chars > maxChars)) flush();
    current.push(w);
    if (/[.!?…]$/.test(w.word)) flush();
  }
  flush();
  // Keep each cue on screen until the next one starts (max +0.4s) to avoid flicker.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    const limit = next ? next.start : end;
    cues[i].end = Math.min(limit, Math.max(cues[i].end, Math.min(cues[i].end + 0.4, limit)));
    if (cues[i].end - cues[i].start < 0.3) cues[i].end = Math.min(limit, cues[i].start + 0.3);
  }
  return cues;
}

/** Apply a manual text edit to a cue, keeping timings when the word count is unchanged. */
function applyCueEdit(cue, text) {
  const clean = cleanText(text);
  const newWords = clean.split(" ").filter(Boolean);
  if (Array.isArray(cue.words) && cue.words.length === newWords.length) {
    return { ...cue, text: clean, words: cue.words.map((w, i) => ({ ...w, word: newWords[i] })) };
  }
  return { ...cue, text: clean, words: distributeWords(clean, cue.start, cue.end) };
}

function splitLines(words, maxChars) {
  const text = words.join(" ");
  if (text.length <= maxChars || words.length < 2) return [words];
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ").length;
    const b = words.slice(i).join(" ").length;
    const diff = Math.abs(a - b);
    if (diff < bestDiff) {
      best = i;
      bestDiff = diff;
    }
  }
  return [words.slice(0, best), words.slice(best)];
}

function layout(options, width, height) {
  const vertical = height > width;
  const unit = Math.min(width, height) / 1080;
  const preset = STYLE_PRESETS[options.style] || STYLE_PRESETS.viral;
  const fontSize = Math.round((SIZE_PX[options.size] || SIZE_PX.M) * unit * preset.scale);
  const pos = options.position || "lower";
  let alignment = 2;
  let marginV;
  if (pos === "top") {
    alignment = 8;
    marginV = Math.round(height * (vertical ? 0.13 : 0.06));
  } else if (pos === "middle") {
    alignment = 5;
    marginV = 0;
  } else if (pos === "bottom") {
    marginV = Math.round(height * (vertical ? 0.17 : 0.07)); // above TikTok/Reels bottom UI
  } else {
    marginV = Math.round(height * (vertical ? 0.27 : 0.12));
  }
  const marginH = Math.round(width * (vertical ? 0.09 : 0.08));
  const maxChars = Math.max(12, Math.floor(((width - marginH * 2) / (fontSize * 0.62))));
  return { preset, fontSize, alignment, marginV, marginH, maxChars };
}

/**
 * Build an ASS document for a clip.
 * @param cues cues in absolute time
 * @param clipStart absolute start of the clip
 * @param clipEnd absolute end of the clip
 */
function buildAss(cues, clipStart, clipEnd, options, width, height) {
  const opts = { style: "viral", font: "Montserrat ExtraBold", color: "#FFFFFF", highlightColor: "#FF4FA0", size: "M", position: "lower", uppercase: true, ...options };
  const { preset, fontSize, alignment, marginV, marginH, maxChars } = layout(opts, width, height);
  const primary = assColor(opts.color);
  const outline = opts.style === "neon" ? assColor(opts.highlightColor) : assColor("#000000");
  const back = opts.style === "minimal" ? assColor("#000000", 0x60) : assColor("#000000", 0x80);
  const borderStyle = preset.box ? 3 : 1;
  const highlightHex = opts.style === "neon" ? "#5CF2FF" : opts.highlightColor;
  const highlight = assColor(highlightHex);
  const highlightOverride = `${assColor(highlightHex).replace(/^&H00/, "&H")}&`;

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Main,${opts.font},${fontSize},${primary},${highlight},${outline},${back},${preset.bold},0,0,0,100,100,1,0,${borderStyle},${preset.box ? Math.round(fontSize * 0.18) : Math.round((preset.outline * fontSize) / 72)},${Math.round((preset.shadow * fontSize) / 72)},${alignment},${marginH},${marginH},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const glow = preset.glow ? `{\\blur${Math.max(2, Math.round(fontSize / 18))}}` : "";
  const events = [];
  for (const cue of cues || []) {
    const s = Math.max(cue.start, clipStart);
    const e = Math.min(cue.end, clipEnd);
    if (e - s < 0.05) continue;
    const words = (Array.isArray(cue.words) && cue.words.length ? cue.words : distributeWords(cue.text, cue.start, cue.end))
      .map((w) => ({ ...w, word: cleanText(opts.uppercase ? String(w.word).toUpperCase() : w.word) }))
      .filter((w) => w.word);
    if (!words.length) continue;
    const lines = splitLines(words.map((w) => w.word), maxChars);
    const lineBreakAt = lines.length > 1 ? lines[0].length : -1;
    const render = (activeIndex) =>
      words
        .map((w, i) => {
          const sep = i === 0 ? "" : i === lineBreakAt ? "\\N" : " ";
          if (activeIndex === i && preset.highlight) {
            const pop = preset.pop ? "\\fscx112\\fscy112" : "";
            return `${sep}{\\c${highlightOverride}${pop}}${w.word}{\\r}${glow}`;
          }
          return `${sep}${w.word}`;
        })
        .join("");

    if (!preset.highlight) {
      events.push(`Dialogue: 0,${assTime(s - clipStart)},${assTime(e - clipStart)},Main,,0,0,0,,${glow}${render(-1)}`);
      continue;
    }
    // One event per active word → current word highlighted ("karaoke pop").
    let cursor = s;
    words.forEach((w, i) => {
      const next = words[i + 1];
      const ws = i === 0 ? s : Math.max(cursor, Math.min(w.start, e));
      const we = next ? Math.max(ws, Math.min(next.start, e)) : e;
      if (we - ws >= 0.02) {
        events.push(`Dialogue: 0,${assTime(ws - clipStart)},${assTime(we - clipStart)},Main,,0,0,0,,${glow}${render(i)}`);
      }
      cursor = we;
    });
  }
  return header.concat(events).join("\n") + "\n";
}

function buildSrt(cues, clipStart, clipEnd) {
  let n = 0;
  const blocks = [];
  for (const cue of cues || []) {
    const s = Math.max(cue.start, clipStart);
    const e = Math.min(cue.end, clipEnd);
    if (e - s < 0.05 || !cleanText(cue.text)) continue;
    n += 1;
    blocks.push(`${n}\n${srtTime(s - clipStart)} --> ${srtTime(e - clipStart)}\n${cleanText(cue.text)}\n`);
  }
  return blocks.join("\n");
}

module.exports = { buildCues, buildAss, buildSrt, applyCueEdit, distributeWords, assColor, assTime, srtTime, cleanText, STYLE_PRESETS };
