import { appendFileSync } from 'node:fs';
import type { Anonymizer } from '../anonymizer/index.js';
import { stripInvisibleDeep } from '../safety/index.js';
import { createLogger } from './logger.js';

export type AuditMode = 'stderr' | 'file' | 'off';

/** One tool call, as recorded by `executeTool`. Never holds the result itself. */
export interface AuditEntry {
  readonly tool: string;
  /** The arguments the AI sent. Scrubbed before they are written. */
  readonly args: unknown;
  readonly durationMs: number;
  readonly ok: boolean;
  /** `AppError` code when `ok` is false. */
  readonly error?: string;
  /** UTF-8 size of the text returned to the AI. */
  readonly resultBytes: number;
  /** Row count when the result has an obvious one (`rowCount`, or a single top-level list). */
  readonly rows?: number;
  /** Number of prompt-injection warnings added to the result. */
  readonly injectionWarnings: number;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
}

export interface AuditLogOptions {
  readonly mode: AuditMode;
  /** Required for `file`: append-only JSON Lines, no rotation. */
  readonly file?: string;
  /**
   * Scrubs every line. Use the logger's anonymizer (no public IP index): writing an audit line
   * must never trigger an Azure call.
   */
  readonly anonymizer?: Anonymizer;
  /** Overrides the sink (tests). Defaults to stderr, or to the file in `file` mode. */
  readonly write?: (line: string) => void;
}

export const NO_AUDIT: AuditLog = { record: () => undefined };

function fileWriter(file: string): (line: string) => void {
  // Fail at startup, not on the first tool call, if the path is not writable.
  appendFileSync(file, '');
  let failed = false;
  return (line) => {
    try {
      appendFileSync(file, line + '\n');
    } catch {
      if (!failed) process.stderr.write('Audit log: cannot append to the audit file (details withheld).\n');
      failed = true;
    }
  };
}

/**
 * Audit trail of tool calls for the human (issue #13). Lines go through the scrubbing logger at
 * `debug` level, so `LOG_LEVEL` never hides them. Invisible characters are stripped too, so a
 * bidi override in an argument cannot reorder what a human reads in the terminal.
 */
export function createAuditLog(opts: AuditLogOptions): AuditLog {
  if (opts.mode === 'off') return NO_AUDIT;
  if (opts.mode === 'file' && opts.write === undefined && opts.file === undefined) {
    throw new Error('AUDIT_LOG=file needs AUDIT_LOG_FILE.');
  }
  const write =
    opts.write ?? (opts.mode === 'file' && opts.file !== undefined ? fileWriter(opts.file) : undefined);
  const logger = createLogger('debug', {
    ...(opts.anonymizer === undefined ? {} : { anonymizer: opts.anonymizer }),
    ...(write === undefined ? {} : { write }),
  });
  return {
    record(entry) {
      logger.info('tool call', { audit: true, ...(stripInvisibleDeep(entry) as Record<string, unknown>) });
    },
  };
}
