/**
 * An error whose message was written by us and is safe to show to the AI.
 * Any other error is replaced by a generic message (AGENTS.md R4).
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

export interface SafeError {
  code: string;
  message: string;
}

interface WithStatus {
  statusCode?: unknown;
  code?: unknown;
}

export function sanitizeError(err: unknown): SafeError {
  if (err instanceof AppError) return { code: err.code, message: err.message };

  // Azure SDK RestError exposes statusCode/code; keep those, drop the message (URLs, IDs).
  const e = (typeof err === 'object' && err !== null ? err : {}) as WithStatus;
  const status = typeof e.statusCode === 'number' ? e.statusCode : undefined;
  const code = typeof e.code === 'string' && /^[A-Za-z]+$/.test(e.code) ? e.code : 'InternalError';

  return {
    code,
    message:
      status === undefined
        ? 'The request failed. Details were withheld to avoid leaking sensitive data.'
        : `Azure returned HTTP ${status}. Details were withheld to avoid leaking sensitive data.`,
  };
}
