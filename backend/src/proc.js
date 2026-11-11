"use strict";

/**
 * Child-process helper. Never uses a shell, so arguments can't be used for command
 * injection. Supports timeouts, cancellation (AbortSignal) and line callbacks.
 */
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const { CancelError } = require("./errors");

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32") {
    // Python spawns ffmpeg: kill the whole tree, otherwise ffmpeg.exe keeps running.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{timeout?:number, signal?:AbortSignal, cwd?:string, env?:object,
 *          onStdoutLine?:(line:string)=>void, onStderrLine?:(line:string)=>void,
 *          maxStdout?:number}} options
 */
function execute(command, args, options = {}) {
  const { timeout = 3600000, signal, cwd, env, onStdoutLine, onStderrLine, maxStdout = 16_000_000 } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelError());
    let stdout = "";
    let stderr = "";
    let outBuf = "";
    let errBuf = "";
    let finished = false;

    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        shell: false,
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        detached: process.platform !== "win32", // own process group → kill whole tree on POSIX
      });
    } catch (error) {
      return reject(error);
    }

    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };

    const onAbort = () => {
      killTree(child);
      finish(new CancelError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      killTree(child);
      finish(new Error(`${path.basename(command)}: tempo limite excedido`));
    }, timeout);

    const splitLines = (chunk, buffer, cb) => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n|\r/);
      buffer = parts.pop();
      if (cb) for (const line of parts) if (line) cb(line);
      return buffer;
    };

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      if (stdout.length > maxStdout) stdout = stdout.slice(-maxStdout);
      outBuf = splitLines(text, outBuf, onStdoutLine);
    });
    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
      errBuf = splitLines(text, errBuf, onStderrLine);
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") finish(new Error(`Programa não encontrado: ${path.basename(command)}`));
      else finish(error);
    });
    child.on("close", (code) => {
      if (outBuf && onStdoutLine) onStdoutLine(outBuf);
      if (errBuf && onStderrLine) onStderrLine(errBuf);
      if (code === 0) finish(null, { stdout, stderr, code });
      else {
        const error = new Error(`${path.basename(command)} terminou com código ${code}: ${stderr.trim().slice(-1500)}`);
        error.stderr = stderr;
        error.exitCode = code;
        finish(error);
      }
    });
  });
}

module.exports = { execute, killTree };
