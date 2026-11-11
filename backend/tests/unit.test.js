"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { buildCues, buildAss, buildSrt, applyCueEdit, assColor } = require("../src/captions");
const { buildFilterGraph, outputSize, piecewiseExpr } = require("../src/render");
const { parseProjectOptions } = require("../src/validation");
const { resolveInside, safeRemove, isInside } = require("../src/storage");
const { normalizeYoutubeUrl } = require("../src/youtube");
const { resolveRecording, encodeToken } = require("../src/library");
const { outputFps } = require("../src/media");
const { uniformMoments } = require("../src/pipeline");
const { isSafeId } = require("../src/repo");

const segments = [
  {
    start: 10, end: 13, text: "Meu Deus, não acredito!",
    words: [
      { start: 10.0, end: 10.4, word: "Meu" }, { start: 10.4, end: 10.9, word: "Deus," },
      { start: 11.0, end: 11.4, word: "não" }, { start: 11.4, end: 12.2, word: "acredito!" },
    ],
  },
  { start: 14, end: 16, text: "Olha isso aqui pessoal que loucura total mesmo" },
];

test("captions: cues are short, word-timed and limited to the clip", () => {
  const cues = buildCues(segments, 9, 15, { vertical: true });
  assert.ok(cues.length >= 2);
  for (const c of cues) {
    assert.ok(c.words.length <= 4, "vertical cues have at most 4 words");
    assert.ok(c.start >= 9 && c.end <= 15.0001);
  }
  assert.equal(cues[0].words[0].word, "Meu");
});

test("captions: ASS has PlayRes, style, highlighted word events and escapes braces", () => {
  const cues = buildCues([{ start: 0, end: 2, text: "oi {x} tudo bem" }], 0, 2);
  const ass = buildAss(cues, 0, 2, { style: "viral", highlightColor: "#FF0000" }, 1080, 1920);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Style: Main,Montserrat ExtraBold,/);
  assert.match(ass, /\{\\c&H0000FF&\\fscx112\\fscy112\}OI/); // highlighted current word (BGR)
  assert.ok(!ass.includes("{X}"));
  const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.ok(events.length >= 3, "one event per word for the karaoke highlight");
  const classic = buildAss(cues, 0, 2, { style: "classic" }, 1080, 1920);
  assert.equal(classic.split("\n").filter((l) => l.startsWith("Dialogue:")).length, 1);
});

test("captions: SRT is clip-relative and edits redistribute timing", () => {
  const cues = buildCues(segments, 10, 16);
  const srt = buildSrt(cues, 10, 16);
  assert.match(srt, /^1\n00:00:00,000 --> /);
  const edited = applyCueEdit(cues[0], "Meu Deus do céu");
  assert.equal(edited.text, "Meu Deus do céu");
  assert.equal(edited.words.length, 4);
  assert.ok(edited.words.every((w) => w.start >= cues[0].start && w.end <= cues[0].end + 1e-6));
  assert.equal(assColor("#112233"), "&H00332211");
});

test("render: no forced 60 fps, filter graphs for every framing", () => {
  assert.equal(outputFps({ fps: 29.97 }), 29.97);
  assert.equal(outputFps({ fps: 30 }), 30);
  assert.equal(outputFps({ fps: 120 }), 60);
  assert.equal(outputFps({ fps: 59.94 }), 59.94);
  const base = { W: 1080, H: 1920, srcW: 1920, srcH: 1080, fps: 30, length: 30 };
  const blur = buildFilterGraph({ ...base, framing: "fit_blur" }).graph;
  assert.match(blur, /boxblur/);
  assert.match(blur, /fps=30/);
  const crop = buildFilterGraph({ ...base, framing: "smart_crop", cropTrack: [[0, 0.3], [5, 0.7]] }).graph;
  assert.match(crop, /crop=608:1080:x='/);
  const custom = buildFilterGraph({ ...base, framing: "custom", custom: { zoom: 1.5, x: 0.5, y: 0 } }).graph;
  assert.match(custom, /scale=1620:912/);
  const subs = buildFilterGraph({ ...base, assFile: "captions.ass", fontsDir: "fonts" }).graph;
  assert.match(subs, /ass=filename=captions.ass:fontsdir=fonts/);
  assert.ok(!/[A-Z]:\\/.test(subs), "no Windows drive paths inside the filter graph");
  const silent = buildFilterGraph({ ...base, hasAudio: false }).graph;
  assert.match(silent, /anullsrc/);
  const zoom = buildFilterGraph({ ...base, autoEdit: true, zoomAt: 10 }).graph;
  assert.match(zoom, /eval=frame/);
  assert.match(zoom, /loudnorm/);
  assert.deepEqual(outputSize("16:9", "high", { width: 1280, height: 720 }), [1280, 720]);
  assert.deepEqual(outputSize("1:1", "fast", {}), [720, 720]);
  assert.match(piecewiseExpr([[0, 10], [2, 110]]), /clip\(\(t-0\.00\)\/2\.00/);
});

test("validation: project options", () => {
  const s = { defaultQuality: "high" };
  assert.equal(parseProjectOptions({ vertical: "false" }, s).format, "16:9");
  assert.equal(parseProjectOptions({ count: "10", duration: "90" }, s).count, 10);
  assert.equal(parseProjectOptions({ duration: "auto" }, s).duration, "auto");
  assert.throws(() => parseProjectOptions({ count: 0 }, s), /Quantidade/);
  assert.throws(() => parseProjectOptions({ count: 21 }, s), /Quantidade/);
  assert.throws(() => parseProjectOptions({ duration: 20 }, s), /Duração/);
  assert.throws(() => parseProjectOptions({ format: "4:3" }, s), /Formato/);
  assert.throws(() => parseProjectOptions({ smart: "talvez" }, s), /booleano/);
  assert.throws(() => parseProjectOptions({ captionStyle: "comic" }, s), /Estilo/);
});

test("storage: path traversal is impossible", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-safe-"));
  fs.writeFileSync(path.join(dir, "ok.mp4"), "x");
  for (const bad of ["../x.mp4", "..\\x.mp4", "a/b.mp4", "/etc/passwd", "C:\\Windows\\x", "..", ".hidden", "", null]) {
    assert.equal(resolveInside(dir, bad), null, String(bad));
    if (bad) assert.throws(() => safeRemove(dir, bad));
  }
  assert.equal(safeRemove(dir, "ok.mp4"), true);
  assert.equal(safeRemove(dir, "missing.mp4"), false);
  assert.ok(isInside(dir, path.join(dir, "a", "b")));
  assert.ok(!isInside(dir, path.join(dir, "..", "other")));
  assert.ok(!isSafeId("../../etc"));
  assert.ok(isSafeId("701177c7-6011-4d08-8200-378db1057bfd_01.mp4"));
});

test("youtube: only https YouTube video URLs", () => {
  assert.equal(normalizeYoutubeUrl("https://youtu.be/Foh-hSvGq3E?si=abc"), "https://www.youtube.com/watch?v=Foh-hSvGq3E");
  assert.equal(normalizeYoutubeUrl("https://www.youtube.com/shorts/abcdefghijk"), "https://www.youtube.com/watch?v=abcdefghijk");
  assert.equal(normalizeYoutubeUrl("https://www.youtube.com/live/abcdefghijk?feature=x"), "https://www.youtube.com/watch?v=abcdefghijk");
  for (const bad of ["http://youtube.com/watch?v=abcdefghijk", "https://evil.com/watch?v=abc", "https://youtube.com.evil.com/watch?v=abcdefghijk",
    "https://www.youtube.com/watch?v=--exec", "file:///etc/passwd", "https://user:pw@youtube.com/watch?v=abcdefghijk", 42]) {
    assert.equal(normalizeYoutubeUrl(bad), null, String(bad));
  }
});

test("library: tokens can't escape the recordings folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-rec-"));
  fs.writeFileSync(path.join(root, "live.mp4"), "x");
  fs.writeFileSync(path.join(os.tmpdir(), "outside.mp4"), "x");
  assert.equal(resolveRecording([root], encodeToken(0, "live.mp4")), fs.realpathSync(path.join(root, "live.mp4")));
  assert.throws(() => resolveRecording([root], encodeToken(0, "../outside.mp4")), /fora|inválida/);
  assert.throws(() => resolveRecording([root], encodeToken(1, "live.mp4")), /inválida/);
  assert.throws(() => resolveRecording([root], "garbage"), /inválida/);
  assert.throws(() => resolveRecording([root], encodeToken(0, "notes.txt")), /suportado/);
});

test("uniform fallback is clearly labelled and unscored", () => {
  const m = uniformMoments(100, 3, 15, "IA desligada");
  assert.equal(m.length, 3);
  assert.ok(m.every((x) => x.score === null && x.reasons[0] === "IA desligada"));
  assert.equal(uniformMoments(10, 3, 30, "x").length, 1);
});
