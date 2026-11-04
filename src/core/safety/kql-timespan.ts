import { AppError } from '../errors/index.js';

/** Time window to pass to the Log Analytics / App Insights query API. */
export type KqlTimespan = { duration: string } | { start: string; end: string };

export type KqlTimespanInput = string | { start: string | Date; end: string | Date };

export const DEFAULT_TIMESPAN = 'P1D';

const MS = { W: 7 * 86_400_000, D: 86_400_000, H: 3_600_000, M: 60_000, S: 1000 } as const;
const NUM = String.raw`(\d+(?:\.\d+)?)`;
// Years and months are refused on purpose: their length is ambiguous, so they can't be bounded.
const DURATION = new RegExp(`^P(?:${NUM}W)?(?:${NUM}D)?(?:T(?:${NUM}H)?(?:${NUM}M)?(?:${NUM}S)?)?$`);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const reject = (reason: string): never => {
  throw new AppError('KqlRejected', reason);
};

/** Parses an ISO 8601 duration limited to weeks, days, hours, minutes and seconds. */
export function parseIsoDuration(input: string): number | undefined {
  const s = input.trim().toUpperCase();
  const m = DURATION.exec(s);
  if (!m || s === 'P' || s.endsWith('T')) return undefined;
  const [, w, d, h, min, sec] = m;
  const part = (v: string | undefined, unit: number) => (v === undefined ? 0 : Number(v) * unit);
  return part(w, MS.W) + part(d, MS.D) + part(h, MS.H) + part(min, MS.M) + part(sec, MS.S);
}

function parseInstant(v: string | Date): Date {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) reject('The timespan start/end must be valid dates.');
    return v;
  }
  // Without an explicit offset, a date-time would be read in the server's local time zone.
  if (!DATE_TIME.test(v.trim())) {
    return reject('The timespan start/end must be ISO 8601 dates (e.g. 2026-01-01T00:00:00Z).');
  }
  const d = new Date(v.trim());
  if (Number.isNaN(d.getTime())) reject('The timespan start/end must be valid dates.');
  return d;
}

export function normalizeTimespan(input: KqlTimespanInput | undefined, maxDays: number): KqlTimespan {
  const maxMs = maxDays * MS.D;
  const tooLong = `The timespan must not exceed ${maxDays} days.`;

  if (input === undefined) {
    return maxMs >= MS.D ? { duration: DEFAULT_TIMESPAN } : { duration: `PT${maxMs / 1000}S` };
  }

  let range: { start: string | Date; end: string | Date } | undefined;
  if (typeof input === 'string') {
    if (!input.includes('/')) {
      const ms = parseIsoDuration(input);
      if (ms === undefined) {
        return reject('The timespan must be an ISO 8601 duration such as PT1H, P1D or P7D.');
      }
      if (ms <= 0) reject('The timespan must be greater than zero.');
      if (ms > maxMs) reject(tooLong);
      return { duration: input.trim().toUpperCase() };
    }
    const [start = '', end = '', ...rest] = input.split('/');
    if (rest.length > 0) reject('The timespan interval must be "<start>/<end>".');
    range = { start, end };
  } else {
    range = input;
  }

  const start = parseInstant(range.start);
  const end = parseInstant(range.end);
  const span = end.getTime() - start.getTime();
  if (span <= 0) reject('The timespan end must be after its start.');
  if (span > maxMs) reject(tooLong);
  return { start: start.toISOString(), end: end.toISOString() };
}
