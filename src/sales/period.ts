/**
 * Calendar dates of reports ('YYYY-MM-DD'), pure. A report day starts and ends in the report's time
 * zone; Postgres does the bucketing (AT TIME ZONE), these only pick and walk the dates.
 */

const DAY_MS = 24 * 60 * 60_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The longest period a report covers (the history setting's maximum). */
export const MAX_REPORT_DAYS = 3660;
/** Default period: the last 30 days, today included. */
export const DEFAULT_REPORT_DAYS = 30;

/** Whether `value` is a real calendar date written as 'YYYY-MM-DD' (no 2026-02-30). */
export function isDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Today's date in a time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `from` to `to`, both included (1 for the same day; 0 or less if `to` is earlier). */
export function daysInPeriod(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** Every date from `from` to `to`, both included. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export class PeriodError extends Error {
  readonly statusCode = 400;
}

/**
 * The period a report covers: the given dates, else the last 30 days up to `to` (default today in
 * the report's time zone). Refuses a start after the end, and periods longer than 10 years.
 */
export function resolvePeriod(
  query: { from?: string; to?: string },
  timeZone: string,
  now: Date = new Date(),
): { from: string; to: string; days: number } {
  const to = query.to ?? todayIn(timeZone, now);
  const from = query.from ?? addDays(to, -(DEFAULT_REPORT_DAYS - 1));
  const days = daysInPeriod(from, to);
  if (days < 1) throw new PeriodError('The start date must be on or before the end date.');
  if (days > MAX_REPORT_DAYS) throw new PeriodError('Choose a period of at most 10 years.');
  return { from, to, days };
}
