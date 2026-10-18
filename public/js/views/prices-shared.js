import { h } from '../dom.js';
import { money, percent, plural } from '../format.js';
import { currencyDecimals } from '../pricing-compute.js';
import { badge } from '../ui.js';

/** Pieces shared by the Prices page's tabs (views/prices*.js) and the product page section. */

/** Where a store's price for an item comes from, as a badge (null for the rule: the default). */
export function sourceBadge(cell) {
  if (cell.source === 'sale') return badge('Sale', 'info', 'tag');
  if (cell.source === 'override') return badge('Fixed price', 'neutral');
  return null;
}

/** The price a store will charge: "$12.99", with the compare-at price struck through. */
export function targetText(cell, currencyCode) {
  if (cell.target.status !== 'ok') return null;
  const compareAt = cell.target.compareAtPrice;
  return h(
    'span',
    { class: 'price-target' },
    money(cell.target.price, currencyCode),
    typeof compareAt === 'number' &&
      h(
        'span',
        { class: 'price-compare' },
        h('span', { class: 'sr-only' }, ', compare at '),
        h('s', {}, money(compareAt, currencyCode)),
      ),
  );
}

/** "Margin 38%", red when the price doesn't cover the cost. */
export function marginText(margin) {
  if (margin === null || margin === undefined) return null;
  return h(
    'span',
    { class: ['price-margin', margin < 0 && 'text-critical'] },
    `Margin ${percent(margin)}`,
  );
}

/** Why a store has no price of Store Sync's for an item. */
export function noTargetText(cell) {
  if (cell.target.status === 'ok') return null;
  if (cell.target.reason === 'no_base_price') {
    return h('span', { class: 'text-warning' }, 'No base price');
  }
  return h('span', { class: 'muted' }, 'Set in Shopify');
}

/** What a price update was started by. */
export function runTitle(run) {
  const name = run.schedule ? `“${run.schedule.name}”` : 'a schedule that was deleted';
  switch (run.reason) {
    case 'sale_start':
      return `Sale ${name} started`;
    case 'sale_end':
      return `Sale ${name} ended`;
    case 'base_change':
      return `Price change ${name}`;
    default:
      return 'Updated from this page';
  }
}

export function runStatusBadge(run) {
  if (run.status === 'queued') return badge('Waiting', 'neutral', 'clock');
  if (run.status === 'running') return badge('Updating', 'info', 'refresh');
  const refused = run.stores.some((s) => s.failed > 0);
  if (run.status === 'failed') return badge('Some stores failed', 'critical', 'error');
  if (refused) return badge('Done, some prices refused', 'warning', 'alert');
  return badge('Done', 'success', 'check');
}

/** One store's part of a run: "14 prices updated · 2 refused". */
export function runStoreSummary(s, { showChecked = false } = {}) {
  if (s.status === 'queued') return 'Waiting to start';
  if (s.status === 'failed' && s.updated === 0) return s.error ?? 'Couldn’t be updated';
  const parts = [
    s.updated === 0 && s.status === 'done' && !s.failed
      ? 'No prices needed changing'
      : `${plural(s.updated, 'price')} updated`,
  ];
  if (s.status === 'running') parts[0] = `${plural(s.updated, 'price')} updated so far`;
  if (s.failed) parts.push(`${s.failed} refused by Shopify`);
  if (s.skipped) parts.push(`${s.skipped} left as they are`);
  if (showChecked && s.status === 'done') parts.push(`${plural(s.checked, 'price')} checked`);
  return parts.join(' · ');
}

const SCHEDULE_STATUS = {
  scheduled: ['Scheduled', 'info', 'calendar'],
  active: ['Running now', 'success', 'play'],
  ended: ['Ended', 'neutral', 'check'],
  cancelled: ['Cancelled', 'neutral', null],
  failed: ['Failed', 'critical', 'error'],
};

export function scheduleStatusBadge(s) {
  let [label, tone, iconName] = SCHEDULE_STATUS[s.status] ?? [s.status, 'neutral', null];
  if (s.status === 'ended' && s.kind === 'base_change') label = 'Done';
  if (
    s.status === 'ended' &&
    s.kind === 'sale' &&
    s.endedAt &&
    s.endsAt &&
    Date.parse(s.endedAt) < Date.parse(s.endsAt) - 60_000
  ) {
    label = 'Ended early';
  }
  return badge(label, tone, iconName);
}

const shortFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const yearFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** "Oct 20, 9:00 AM" (with the year when it isn't this year), in the browser's time zone. */
export function shortDateTime(value) {
  const date = new Date(value);
  return (date.getFullYear() === new Date().getFullYear() ? shortFormat : yearFormat).format(date);
}

/** When a schedule runs: its start, and for a sale its end, one per line. */
export function scheduleWhen(s) {
  if (s.kind === 'base_change') return h('span', {}, shortDateTime(s.startsAt));
  return h(
    'span',
    { class: 'schedule-when' },
    h('span', {}, shortDateTime(s.startsAt)),
    h('span', {}, h('span', { class: 'muted' }, 'to '), shortDateTime(s.endsAt)),
  );
}

/** A Date or ISO string as a datetime-local input value (the browser's time zone). */
export function toLocalInput(value) {
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Reads an amount typed in a number input: null when empty, NaN when not a number. */
export function readAmount(inputEl) {
  const text = inputEl.value.trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : NaN;
}

/** Number input attributes for amounts of money. */
export const amountProps = (currencyCode) => ({
  type: 'number',
  min: 0,
  step: 'any',
  inputmode: 'decimal',
  autocomplete: 'off',
  placeholder: (0).toFixed(currencyDecimals(currencyCode ?? 'USD')),
});
