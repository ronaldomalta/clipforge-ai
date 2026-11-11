"use strict";

const { createApp } = require("./app");
const { log } = require("./logger");
const { nodeStatus } = require("./diagnostics");

const node = nodeStatus();
if (!node.ok) {
  console.error(`\n[ClipForge] Node.js ${node.version} não é suportado. ${node.hint}\n`);
  process.exit(1);
}

const { app, config, start, close } = createApp();
const server = app.listen(config.port, config.host, () => {
  log.info(`ClipForge AI pronto em http://localhost:${config.port}`, { host: config.host });
  start();
});
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") log.error(`A porta ${config.port} já está em uso. Feche a outra instância ou defina PORT no backend/.env.`);
  else log.error("Server error", { error });
  process.exit(1);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  log.info("Encerrando ClipForge AI...");
  server.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
