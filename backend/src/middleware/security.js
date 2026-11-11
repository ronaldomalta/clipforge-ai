"use strict";

/**
 * Local-app hardening:
 *  - Host header must be localhost (DNS-rebinding protection).
 *  - CORS only for the local UI origins.
 *  - Every state-changing request needs the `X-ClipForge-Client` header. Browsers can't
 *    send custom headers cross-origin without a CORS preflight, which we refuse for
 *    foreign origins → blocks CSRF from random websites (including multipart uploads).
 */
function securityMiddleware(config) {
  const allowedOrigins = new Set(config.allowedOrigins);
  const allowedHosts = new Set(config.allowedHosts);

  return (req, res, next) => {
    const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
    if (host && !allowedHosts.has(host)) {
      return res.status(403).json({ error: "Host não permitido.", code: "BAD_HOST" });
    }

    const origin = req.headers.origin;
    if (origin) {
      if (!allowedOrigins.has(origin)) {
        return res.status(403).json({ error: "Origem não permitida.", code: "BAD_ORIGIN" });
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-ClipForge-Client");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.status(204).end();

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");

    const mutating = !["GET", "HEAD"].includes(req.method);
    if (mutating && req.headers["x-clipforge-client"] !== "1") {
      return res.status(403).json({ error: "Requisição bloqueada (cabeçalho do cliente ausente).", code: "CSRF" });
    }
    next();
  };
}

module.exports = { securityMiddleware };
