import { h } from './dom.js';

const numberFormat = new Intl.NumberFormat('en-US');
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateYearFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const absoluteFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const num = (n) => (n === null || n === undefined ? '—' : numberFormat.format(n));

/** "+3" / "−3" (a real minus sign, read as "minus" by screen readers). */
export const signed = (n) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');

export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/**
 * Units a day, the same on every page (Reports, the product page, Purchasing): one decimal below
 * 10, whole numbers above ("0.5", "12"); "<0.1" for a product that sells, only slowly.
 */
export function pace(velocity) {
  if (velocity === null || velocity === undefined) return '—';
  const rounded = velocity >= 10 ? Math.round(velocity) : Math.round(velocity * 10) / 10;
  return rounded === 0 && velocity > 0 ? '<0.1' : num(rounded);
}

const moneyFormats = new Map();

/**
 * "$12.90", "COP 41,900.00", "CLP 41,900": the currency's own decimals, en-US like `num`. An
 * unknown currency (a store not read yet) shows the plain number with 2 decimals. `signDisplay`
 * as in Intl ('exceptZero' for changes: "+$2.00").
 */
export function money(amount, currencyCode, { signDisplay = 'auto' } = {}) {
  if (amount === null || amount === undefined || amount === '') return '—';
  const key = `${currencyCode}|${signDisplay}`;
  let format = moneyFormats.get(key);
  if (!format) {
    try {
      format = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currencyCode,
        signDisplay,
      });
    } catch {
      format = new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        signDisplay,
      });
    }
    moneyFormats.set(key, format);
  }
  return format.format(Number(amount));
}

const percentFormats = new Map();

/** 0.125 → "13%" (digits 0) or "12.5%" (digits 1). */
export function percent(fraction, digits = 0) {
  if (fraction === null || fraction === undefined || !Number.isFinite(Number(fraction))) {
    return '—';
  }
  let format = percentFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    percentFormats.set(digits, format);
  }
  return format.format(Number(fraction));
}

const dateOnlyFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * A calendar date: '2026-10-17' (as the API sends dates) → "Oct 17, 2026", the same day wherever
 * the browser is. A Date shows its local calendar day.
 */
export function dateOnly(value) {
  if (value === null || value === undefined || value === '') return '—';
  let utc;
  if (value instanceof Date) {
    utc = Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (!match) return '—';
    utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  return dateOnlyFormat.format(new Date(utc));
}

/** A duration in whole days, rounded down: "4 days", "1 day", "less than a day". */
export function days(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  if (n < 1) return 'less than a day';
  return plural(Math.floor(n), 'day');
}

export function relativeTime(value, now = Date.now()) {
  const date = new Date(value);
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '—';
  // Slightly-ahead server clocks would otherwise read "in 2 seconds".
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? dateFormat.format(date)
    : dateYearFormat.format(date);
}

export const absoluteTime = (value) => absoluteFormat.format(new Date(value));

/** "3 min ago", with the exact date and time on hover; kept fresh by the ticker below. */
export function timeAgo(value, { never = 'Never' } = {}) {
  if (!value) return h('span', { class: 'muted' }, never);
  return h(
    'time',
    { datetime: new Date(value).toISOString(), title: absoluteTime(value), 'data-relative': '' },
    relativeTime(value),
  );
}

export function startRelativeTimeTicker() {
  setInterval(() => {
    for (const el of document.querySelectorAll('time[data-relative]')) {
      el.textContent = relativeTime(el.dateTime);
    }
  }, 30_000);
}
