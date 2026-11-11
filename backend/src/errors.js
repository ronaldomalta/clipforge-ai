"use strict";

/** Errors that are safe to show to the user (message in pt-BR, no internal paths). */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

class CancelError extends Error {
  constructor() {
    super("Processamento cancelado pelo usuário.");
    this.code = "CANCELED";
  }
}

const badRequest = (message, details) => new AppError(400, "BAD_REQUEST", message, details);
const notFound = (message = "Recurso não encontrado.") => new AppError(404, "NOT_FOUND", message);
const conflict = (message) => new AppError(409, "CONFLICT", message);

module.exports = { AppError, CancelError, badRequest, notFound, conflict };
