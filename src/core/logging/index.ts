import { createAnonymizer, type Anonymizer } from '../anonymizer/index.js';

export { silenceAzureSdkLogging } from './azure-sdk.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  /**
   * Scrubs every line. Build it with the same aliases and safeTagKeys as the tools' anonymizer.
   * Defaults to `createAnonymizer()`, the most restrictive one.
   */
  readonly anonymizer?: Anonymizer;
  /** Defaults to stderr. */
  readonly write?: (line: string) => void;
}

/**
 * JSON logger writing to stderr only (stdout is reserved for protocol use).
 * Everything is scrubbed (AGENTS.md R5).
 */
export function createLogger(level: LogLevel = 'info', opts: LoggerOptions = {}): Logger {
  const anonymizer = opts.anonymizer ?? createAnonymizer();
  const write = opts.write ?? ((line: string) => process.stderr.write(line + '\n'));
  const log =
    (lvl: LogLevel) =>
    (msg: string, data?: Record<string, unknown>): void => {
      if (ORDER[lvl] < ORDER[level]) return;
      write(JSON.stringify(anonymizer.scrub({ ts: new Date().toISOString(), level: lvl, msg, ...data })));
    };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
