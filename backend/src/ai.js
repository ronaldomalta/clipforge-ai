"use strict";

/** Bridge to the Python AI service (ai-service/analyze.py). */
const fs = require("fs");
const path = require("path");
const { execute } = require("./proc");
const { log } = require("./logger");

/**
 * Run the analysis. Progress lines from Python look like: `@@CF {"progress":0.4,"label":"..."}`.
 * @returns {Promise<object>} parsed analysis.json
 */
async function runAnalysis(config, analysisConfig, { signal, onProgress } = {}) {
  const workDir = analysisConfig.work_dir;
  fs.mkdirSync(workDir, { recursive: true });
  const configPath = path.join(workDir, "analysis-config.json");
  fs.writeFileSync(configPath, JSON.stringify(analysisConfig, null, 2));
  const stderrTail = [];
  await execute(config.python, ["-u", config.aiScript, "--config", configPath], {
    signal,
    cwd: path.dirname(config.aiScript),
    env: { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    timeout: Math.max(3 * 3600 * 1000, (analysisConfig.media?.duration || 0) * 4000),
    onStdoutLine: (line) => {
      if (!line.startsWith("@@CF ")) return;
      try {
        const event = JSON.parse(line.slice(5));
        if (event.type === "log") log.info(`[ai] ${event.message}`);
        else onProgress?.(event);
      } catch {
        /* ignore malformed progress */
      }
    },
    onStderrLine: (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
    },
  }).catch((error) => {
    if (error.code === "CANCELED") throw error;
    const detail = stderrTail.filter((l) => !/warn/i.test(l)).slice(-6).join(" | ");
    const wrapped = new Error(`Serviço de IA falhou: ${detail || error.message}`.slice(0, 1500));
    wrapped.cause = error;
    throw wrapped;
  });
  const output = analysisConfig.output;
  if (!fs.existsSync(output)) throw new Error("Serviço de IA não gerou o arquivo de análise.");
  return JSON.parse(fs.readFileSync(output, "utf8"));
}

module.exports = { runAnalysis };
