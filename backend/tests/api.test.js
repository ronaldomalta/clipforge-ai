"use strict";

/**
 * Integration tests: real HTTP server, real SQLite, real FFmpeg renders of generated videos.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startServer, makeVideo, probeFile, uploadForm, tempStorage } = require("./helpers");

const media = fs.mkdtempSync(path.join(os.tmpdir(), "cf-media-"));
const horizontal = makeVideo(path.join(media, "h30.mp4"), { duration: 40, fps: 30 });
const vertical60 = makeVideo(path.join(media, "v60.mp4"), { duration: 20, width: 720, height: 1280, fps: 60 });
const noAudio = makeVideo(path.join(media, "silent.mp4"), { duration: 16, audio: false });
// Generated up-front: blocking the event loop mid-test would break keep-alive sockets.
const long = makeVideo(path.join(media, "long.mp4"), { duration: 120 });

test("security: CSRF header, host and origin checks", async () => {
  const s = await startServer({ startWorker: false });
  try {
    let res = await fetch(`${s.base}/api/clips/batch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 403);
    res = await fetch(`${s.base}/api/health`, { headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    const ok = await fetch(`${s.base}/api/health`, { headers: { Origin: "http://localhost:5173" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const health = await s.api("GET", "/api/health");
    assert.equal(health.data.status, "ok");
  } finally {
    await s.stop();
  }
});

test("upload validation: extension, fake video, options, missing file", async () => {
  const s = await startServer({ startWorker: false });
  try {
    const txt = path.join(media, "notes.txt");
    fs.writeFileSync(txt, "hello");
    let form = await uploadForm(txt);
    let r = await s.api("POST", "/api/projects/upload", form);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Formato não suportado/);

    const fake = path.join(media, "fake.mp4");
    fs.writeFileSync(fake, Buffer.alloc(4096, 1));
    form = await uploadForm(fake);
    r = await s.api("POST", "/api/projects/upload", form);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /não é um vídeo válido/);
    assert.equal(fs.readdirSync(path.join(s.storage, "uploads", "_incoming")).length, 0, "rejected upload must be removed");

    form = await uploadForm(horizontal, { count: 99 });
    r = await s.api("POST", "/api/projects/upload", form);
    assert.equal(r.status, 400);

    r = await s.api("POST", "/api/projects/upload", new FormData());
    assert.equal(r.status, 400);

    r = await s.api("POST", "/api/projects", { source: { type: "youtube", url: "https://evil.com/watch?v=abcdefghijk" } });
    assert.equal(r.status, 400);
    r = await s.api("POST", "/api/projects", { source: { type: "library", token: "x" } });
    assert.equal(r.status, 400);
  } finally {
    await s.stop();
  }
});

test("pipeline: upload → clips with video+audio, correct fps/size, review, finalize, persistence", async () => {
  const storage = tempStorage();
  let s = await startServer({ storage });
  let projectId;
  let clipIds;
  try {
    const form = await uploadForm(horizontal, { count: 3, duration: 15, smart: false, captions: false, autoEdit: true, format: "9:16", quality: "fast" });
    const created = await s.api("POST", "/api/projects/upload", form);
    assert.equal(created.status, 202, JSON.stringify(created.data));
    projectId = created.data.id;
    const done = await s.waitProject(projectId);
    assert.equal(done.status, "completed", done.error || done.step);
    assert.equal(done.clips.length, 2, "40 s video, 15 s clips: only 2 fit without overlapping (count 3 requested)");
    assert.equal(done.analysis.selection, "uniform");
    for (const clip of done.clips) {
      assert.equal(clip.fileStatus, "ok");
      assert.equal(clip.score, null, "no fake score when AI is off");
      const file = path.join(storage, "clips", clip.filename);
      const info = probeFile(file);
      assert.ok(info.video && info.audio, "clip has video and audio");
      assert.equal(info.video.width, 720);
      assert.equal(info.video.height, 1280);
      assert.ok(Math.abs(info.fps - 30) < 0.1, `30 fps source must stay 30 fps (got ${info.fps})`);
      assert.ok(Math.abs(info.duration - 15) < 0.6);
      const media = await s.api("GET", clip.url, undefined, { raw: true });
      assert.equal(media.status, 200);
      const thumb = await s.api("GET", clip.thumbUrl, undefined, { raw: true });
      assert.equal(thumb.headers.get("content-type"), "image/jpeg");
      const range = await fetch(s.base + clip.url, { headers: { Range: "bytes=0-99" } });
      assert.equal(range.status, 206, "range requests for the video player");
    }
    // Uploaded managed copy is removed after processing (segments are kept for editing).
    assert.equal(fs.existsSync(path.join(storage, "uploads", projectId)), false);
    assert.ok(fs.readdirSync(path.join(storage, "segments")).length >= 2);
    clipIds = done.clips.map((c) => c.id);

    // review
    let r = await s.api("POST", `/api/clips/${clipIds[0]}/approve`);
    assert.equal(r.data.status, "approved");
    r = await s.api("POST", "/api/clips/batch", { ids: [clipIds[1]], action: "discard" });
    assert.equal(r.data.clips[0].status, "discarded");
    r = await s.api("POST", "/api/clips/batch", { ids: [clipIds[1], "../../etc/passwd"], action: "approve" });
    assert.equal(r.status, 400);
    r = await s.api("POST", "/api/clips/batch", { ids: [clipIds[1], clipIds[1]], action: "approve" });
    assert.equal(r.status, 400);
  } finally {
    await s.stop();
  }

  // Restart: approval state persisted.
  s = await startServer({ storage });
  try {
    let r = await s.api("GET", `/api/projects/${projectId}`);
    assert.equal(r.data.clips.find((c) => c.id === clipIds[0]).status, "approved");
    assert.equal(r.data.clips.find((c) => c.id === clipIds[1]).status, "discarded");

    r = await s.api("POST", `/api/projects/${projectId}/review/finalize`, {});
    assert.equal(r.status, 400, "destructive action needs explicit confirmation");
    const discarded = r.data;
    void discarded;
    const discardedFile = path.join(storage, "clips", `${clipIds[1]}.mp4`);
    assert.ok(fs.existsSync(discardedFile));
    r = await s.api("POST", `/api/projects/${projectId}/review/finalize`, { confirm: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.deleted, 1);
    assert.equal(r.data.kept, 1);
    assert.equal(fs.existsSync(discardedFile), false, "discarded file deleted");
    assert.ok(fs.existsSync(path.join(storage, "clips", `${clipIds[0]}.mp4`)), "approved file kept");
    assert.ok(fs.existsSync(horizontal), "the user's original recording is never touched");
    const stats = await s.api("GET", "/api/stats");
    assert.equal(stats.data.clips.approved, 1);
    assert.equal(stats.data.clips.discarded, 1);
    r = await s.api("GET", `/api/clips/${clipIds[1]}`);
    assert.equal(r.status, 404);
    r = await s.api("GET", `/media/clips/${clipIds[1]}.mp4`, undefined, { raw: true });
    assert.equal(r.status, 404);

    // export copies approved clip to the output folder
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-export-"));
    r = await s.api("PUT", "/api/settings", { outputDir: outDir });
    assert.equal(r.status, 200);
    r = await s.api("POST", `/api/projects/${projectId}/export`, {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.files.length, 1);
    assert.ok(fs.existsSync(r.data.files[0].file));
  } finally {
    await s.stop();
  }
});

test("media: traversal and unknown files are rejected", async () => {
  const s = await startServer({ startWorker: false });
  try {
    for (const url of ["/media/clips/..%2F..%2Fdb%2Fclipforge.db", "/media/clips/%2e%2e%2fbackups", "/media/thumbs/x.jpg", "/media/clips/.env"]) {
      const r = await s.api("GET", url, undefined, { raw: true });
      assert.equal(r.status, 404, url);
    }
    const r = await s.api("DELETE", "/api/clips/..%2F..%2Fpackage.json", { confirm: true });
    assert.ok([400, 404].includes(r.status));
  } finally {
    await s.stop();
  }
});

test("video formats: vertical 60 fps keeps 60 fps; silent source gets a silent audio track; 16:9 and 1:1", async () => {
  const s = await startServer();
  try {
    let form = await uploadForm(vertical60, { count: 1, duration: 15, smart: false, format: "9:16", quality: "fast" });
    let r = await s.api("POST", "/api/projects/upload", form);
    let done = await s.waitProject(r.data.id);
    assert.equal(done.status, "completed", done.error);
    let info = probeFile(path.join(s.storage, "clips", done.clips[0].filename));
    assert.ok(Math.abs(info.fps - 60) < 0.1, `60 fps kept (got ${info.fps})`);
    assert.equal(info.video.width, 720);

    form = await uploadForm(noAudio, { count: 1, duration: 15, smart: true, captions: true, format: "16:9", quality: "fast" });
    r = await s.api("POST", "/api/projects/upload", form);
    done = await s.waitProject(r.data.id);
    assert.equal(done.status, "completed", done.error);
    assert.ok(done.analysis.warnings.some((w) => /não tem áudio/.test(w)));
    info = probeFile(path.join(s.storage, "clips", done.clips[0].filename));
    assert.ok(info.audio, "silent source still produces an AAC track");
    assert.equal(info.video.width, 1280);
    assert.equal(info.video.height, 720);

    form = await uploadForm(horizontal, { count: 1, duration: 15, smart: false, format: "1:1", framing: "smart_crop", quality: "fast" });
    r = await s.api("POST", "/api/projects/upload", form);
    done = await s.waitProject(r.data.id);
    info = probeFile(path.join(s.storage, "clips", done.clips[0].filename));
    assert.equal(info.video.width, 720);
    assert.equal(info.video.height, 720);
  } finally {
    await s.stop();
  }
});

test("editor: edited captions are burned into a NEW version; original untouched; replace needs confirmation", async () => {
  const s = await startServer();
  try {
    const form = await uploadForm(horizontal, { count: 1, duration: 15, smart: false, format: "9:16", quality: "fast" });
    const r0 = await s.api("POST", "/api/projects/upload", form);
    const done = await s.waitProject(r0.data.id);
    const clip = done.clips[0];
    const originalFile = path.join(s.storage, "clips", clip.filename);
    const originalBytes = fs.readFileSync(originalFile);

    const ed = await s.api("GET", `/api/clips/${clip.id}/editor`);
    assert.equal(ed.status, 200);
    assert.ok(ed.data.segment.duration > clip.duration, "padded source segment available for re-editing");

    // Manual captions (no Whisper needed): text typed by the user.
    const cues = [
      { start: clip.start + 1, end: clip.start + 4, text: "Legenda editada à mão" },
      { start: clip.start + 4.2, end: clip.start + 8, text: "Segunda linha da legenda" },
    ];
    let r = await s.api("PUT", `/api/clips/${clip.id}/captions`, { cues });
    assert.equal(r.status, 200);
    assert.equal(r.data.cues.length, 2);

    r = await s.api("POST", `/api/clips/${clip.id}/render`, { start: clip.start - 3, end: clip.start + 9, captionsEnabled: true, captionOptions: { style: "neon", position: "middle" }, mode: "replace" });
    assert.equal(r.status, 400, "replace requires confirmReplace");

    r = await s.api("POST", `/api/clips/${clip.id}/render`, { start: clip.start - 3, end: clip.start + 9, captionsEnabled: true, captionOptions: { style: "viral" } });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    const task = await s.waitTask(r.data.id);
    assert.equal(task.status, "completed", task.error);
    const versionId = task.payload.resultClipId;
    const version = (await s.api("GET", `/api/clips/${versionId}`)).data;
    assert.equal(version.version, 2);
    assert.equal(version.parentId, clip.id);
    assert.ok(version.captionsApplied, "captions were burned in");
    assert.ok(version.srtUrl, "separate SRT exported");
    const vInfo = probeFile(path.join(s.storage, "clips", version.filename));
    assert.ok(Math.abs(vInfo.duration - 12) < 0.6, `new duration 12 s (got ${vInfo.duration})`);
    assert.deepEqual(fs.readFileSync(originalFile), originalBytes, "original clip file untouched");
    const srt = await (await s.api("GET", version.srtUrl, undefined, { raw: true })).text();
    assert.match(srt, /Legenda editada/);
    assert.match(srt, /^1\n00:00:04,000 --> /, "SRT is relative to the new start");

    r = await s.api("POST", `/api/clips/${clip.id}/render`, { start: clip.start - 500, end: clip.start });
    assert.equal(r.status, 400, "range outside the saved segment");
  } finally {
    await s.stop();
  }
});

test("queue: cancel a running project; delete rules; legacy JSON import", async () => {
  const storage = tempStorage();
  fs.mkdirSync(path.join(storage, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(storage, "clips"), { recursive: true });
  const legacyId = "11111111-2222-4333-8444-555555555555";
  fs.copyFileSync(horizontal, path.join(storage, "clips", `${legacyId}_01.mp4`));
  fs.writeFileSync(
    path.join(storage, "jobs", `${legacyId}.json`),
    JSON.stringify({
      id: legacyId, sourceType: "youtube", url: "https://youtu.be/abcdefghijk", sourceName: "YouTube", status: "running",
      progress: 40, step: "x", createdAt: "2026-11-01T10:00:00.000Z",
      settings: { count: 2, duration: 15, vertical: true, captions: false, autoEdit: false, smart: true },
      clips: [{ id: `${legacyId}_01.mp4`, filename: `${legacyId}_01.mp4`, url: `http://localhost:3001/clips/${legacyId}_01.mp4`, start: 5, duration: 15, score: 27.8, title: "Antigo" },
        { id: `${legacyId}_02.mp4`, filename: `${legacyId}_02.mp4`, start: 20, duration: 15, score: 1, title: "Sem arquivo" }],
    })
  );
  const s = await startServer({ storage });
  try {
    const legacy = (await s.api("GET", `/api/projects/${legacyId}`)).data;
    assert.equal(legacy.status, "interrupted");
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.clips[0].fileStatus, "ok");
    assert.equal(legacy.clips[0].score, null, "old heuristic score is not shown as 0-100");
    assert.equal(legacy.clips[1].fileStatus, "missing");
    assert.ok(fs.existsSync(path.join(storage, "jobs", `${legacyId}.json`)), "legacy JSON kept");
    const jobs = (await s.api("GET", "/api/jobs")).data;
    assert.ok(jobs.some((j) => j.id === legacyId), "legacy /api/jobs endpoint still works");

    const form = await uploadForm(long, { count: 5, duration: 15, smart: false, quality: "high" });
    const r = await s.api("POST", "/api/projects/upload", form);
    await s.waitProject(r.data.id, { until: ["running"] });
    let del = await s.api("DELETE", `/api/projects/${r.data.id}`, { confirm: true });
    assert.equal(del.status, 409, "can't delete a project that is processing");
    const cancel = await s.api("POST", `/api/projects/${r.data.id}/cancel`);
    assert.equal(cancel.status, 200);
    const done = await s.waitProject(r.data.id);
    assert.equal(done.status, "canceled");
    del = await s.api("DELETE", `/api/projects/${r.data.id}`, {});
    assert.equal(del.status, 400, "delete requires confirmation");
    del = await s.api("DELETE", `/api/projects/${r.data.id}`, { confirm: true });
    assert.equal(del.status, 200);
    assert.ok(fs.existsSync(long), "original file never deleted");
  } finally {
    await s.stop();
  }
});

test("library import processes the recording in place and never deletes it", async () => {
  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-recordings-"));
  const rec = path.join(recDir, "live-2026-11-10.mp4");
  fs.copyFileSync(horizontal, rec);
  const s = await startServer();
  try {
    let r = await s.api("PUT", "/api/settings", { recordingsDirs: [recDir] });
    assert.equal(r.status, 200);
    r = await s.api("GET", "/api/library/recordings");
    assert.equal(r.data.items.length, 1);
    const token = r.data.items[0].token;
    r = await s.api("POST", "/api/projects", { source: { type: "library", token }, options: { count: 1, duration: 15, smart: false, quality: "fast" } });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    const done = await s.waitProject(r.data.id);
    assert.equal(done.status, "completed", done.error);
    r = await s.api("DELETE", `/api/projects/${done.id}`, { confirm: true });
    assert.equal(r.status, 200);
    assert.ok(fs.existsSync(rec), "recording in the user's folder is untouched");
    r = await s.api("PUT", "/api/settings", { recordingsDirs: ["relative/path"] });
    assert.equal(r.status, 400);
  } finally {
    await s.stop();
  }
});
