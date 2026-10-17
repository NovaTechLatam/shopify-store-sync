import { h, icon } from './dom.js';
import { num, timeAgo } from './format.js';
import { deltaBadge, describeEvent } from './labels.js';

/** Activity entries, newest first. `showItem` adds a link to the product (global log). */
export function timeline(events, { showItem = false } = {}) {
  return h(
    'ol',
    { class: 'timeline' },
    events.map((e) => timelineEntry(e, { showItem })),
  );
}

export function timelineEntry(e, { showItem = false } = {}) {
  const d = describeEvent(e);
  const shared =
    e.quantityBefore !== null && e.quantityAfter !== null
      ? `Shared stock ${num(e.quantityBefore)} → ${num(e.quantityAfter)}`
      : null;
  return h(
    'li',
    { class: ['timeline-entry', `tone-${d.tone}`], tabindex: '-1' },
    h('span', { class: 'timeline-icon' }, icon(d.icon, { size: 16 })),
    h(
      'div',
      { class: 'timeline-body' },
      h(
        'div',
        { class: 'timeline-head' },
        h('p', { class: 'timeline-title' }, d.title),
        h('span', { class: 'timeline-time' }, timeAgo(e.createdAt)),
      ),
      e.message && h('p', { class: 'timeline-message' }, e.message),
      (e.delta !== null || shared || (showItem && e.itemId)) &&
        h(
          'p',
          { class: 'timeline-meta' },
          e.delta !== null && deltaBadge(e.delta),
          shared && h('span', {}, shared),
          showItem &&
            e.itemId &&
            h('a', { href: `#/items/${e.itemId}`, class: 'mono' }, e.sku ?? `Product ${e.itemId}`),
        ),
    ),
  );
}
