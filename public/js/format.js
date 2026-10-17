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
