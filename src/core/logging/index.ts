import { Pseudonymizer, scrub } from '../anonymizer/index.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * JSON logger writing to stderr only (stdout is reserved for protocol use).
 * Everything is scrubbed with a dedicated pseudonymizer (AGENTS.md R5).
 */
export function createLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Logger {
  const p = new Pseudonymizer();
  const log =
    (lvl: LogLevel) =>
    (msg: string, data?: Record<string, unknown>): void => {
      if (ORDER[lvl] < ORDER[level]) return;
      write(JSON.stringify(scrub({ ts: new Date().toISOString(), level: lvl, msg, ...data }, p)));
    };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
