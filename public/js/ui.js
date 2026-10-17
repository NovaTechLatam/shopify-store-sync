import { isAbort } from './api.js';
import { h, icon, replace, uid } from './dom.js';
import { num } from './format.js';

/** Building blocks shared by the views. Each returns a DOM node. */

export function pageHeader({ title, subtitle, back, badges = [], actions = [] }) {
  return h(
    'header',
    { class: 'page-header' },
    back && h('a', { class: 'back-link', href: back.href }, icon('chevronLeft'), back.label),
    h(
      'div',
      { class: 'page-header-row' },
      h(
        'div',
        { class: 'page-header-text' },
        h(
          'div',
          { class: 'page-title-row' },
          // Focused after navigation so screen readers announce the new page.
          h('h1', { tabindex: '-1' }, title),
          badges.length > 0 && h('div', { class: 'badges' }, badges),
        ),
        subtitle && h('p', { class: 'page-subtitle' }, subtitle),
      ),
      actions.length > 0 && h('div', { class: 'page-actions' }, actions),
    ),
  );
}

export function card({ title, description, actions, className, level = 2 } = {}, ...children) {
  const headingId = title ? uid('card') : null;
  return h(
    'section',
    { class: ['card', className], 'aria-labelledby': headingId },
    (title || actions) &&
      h(
        'div',
        { class: 'card-header' },
        h(
          'div',
          { class: 'card-heading' },
          title && h(`h${level}`, { id: headingId, class: 'card-title' }, title),
          description && h('p', { class: 'card-description' }, description),
        ),
        actions && h('div', { class: 'card-actions' }, actions),
      ),
    children,
  );
}

export function badge(text, tone = 'neutral', iconName) {
  return h(
    'span',
    { class: ['badge', `badge-${tone}`] },
    iconName && icon(iconName, { size: 14 }),
    text,
  );
}

export function button(
  label,
  { variant = 'secondary', size, iconName, onClick, type = 'button', disabled, attrs } = {},
) {
  return h(
    'button',
    {
      type,
      class: ['button', `button-${variant}`, size && `button-${size}`],
      onclick: onClick,
      disabled,
      ...attrs,
    },
    iconName && icon(iconName),
    h('span', {}, label),
  );
}

export function linkButton(label, href, { variant = 'secondary', size, iconName, attrs } = {}) {
  return h(
    'a',
    { class: ['button', `button-${variant}`, size && `button-${size}`], href, ...attrs },
    iconName && icon(iconName),
    h('span', {}, label),
  );
}

/** Disables the button and shows a spinner (without changing its size) while `fn` runs. */
export async function withBusy(btn, fn) {
  if (btn.disabled) return undefined;
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
  }
}

export function loadingState({ label = 'Loading…', lines = 4, note } = {}) {
  return h(
    'div',
    { class: 'state state-loading', role: 'status' },
    h('span', { class: 'sr-only' }, label),
    note && h('p', { class: 'state-note' }, note),
    Array.from({ length: lines }, (_, i) =>
      h('div', { class: `skeleton skeleton-${i % 3}`, 'aria-hidden': 'true' }),
    ),
  );
}

export function emptyState({ title, message, action, iconName = 'info' }) {
  return h(
    'div',
    { class: 'state state-empty' },
    icon(iconName, { size: 28, className: 'state-icon' }),
    h('p', { class: 'state-title' }, title),
    message && h('p', { class: 'state-message' }, message),
    action,
  );
}

export function errorState(err, onRetry) {
  return h(
    'div',
    { class: 'state state-error', role: 'alert' },
    icon('error', { size: 28, className: 'state-icon' }),
    h('p', { class: 'state-title' }, 'This couldn’t be loaded'),
    h('p', { class: 'state-message' }, err?.message || 'Something went wrong.'),
    onRetry && button('Try again', { iconName: 'refresh', onClick: onRetry }),
  );
}

/**
 * Shows a loading state in `container`, runs `load`, then renders the result (or an error with a
 * retry button). Ignores results that arrive after the view was left (`signal` aborted).
 */
export async function loadInto(container, options) {
  const { load, render, signal, loading, keepContent } = options;
  // Reloading a list (new filter, next page): dim the old results instead of flashing a skeleton.
  const dim = keepContent && container.childElementCount > 0 && !container.querySelector('.state');
  if (dim) container.setAttribute('aria-busy', 'true');
  else replace(container, loading ?? loadingState());
  try {
    const data = await load();
    if (signal?.aborted) return;
    replace(container, render(data));
  } catch (err) {
    if (isAbort(err) || signal?.aborted) return;
    replace(
      container,
      errorState(err, () => loadInto(container, { ...options, keepContent: false })),
    );
  } finally {
    if (dim && !signal?.aborted) container.removeAttribute('aria-busy');
  }
}

/** Swaps a placeholder page header for the loaded one, keeping focus on the heading. */
export function replaceHeader(oldHeader, newHeader) {
  const hadFocus = oldHeader.contains(document.activeElement);
  oldHeader.replaceWith(newHeader);
  if (hadFocus) newHeader.querySelector('h1')?.focus({ preventScroll: true });
  return newHeader;
}

const BANNER_ICONS = {
  success: 'check',
  warning: 'alert',
  critical: 'error',
  info: 'info',
  neutral: 'info',
};

export function banner({ tone = 'info', iconName, title, actions, size }, ...children) {
  return h(
    'div',
    { class: ['banner', `banner-${tone}`, size && `banner-${size}`] },
    h(
      'span',
      { class: 'banner-icon' },
      icon(iconName ?? BANNER_ICONS[tone], { size: size === 'large' ? 24 : 20 }),
    ),
    h(
      'div',
      { class: 'banner-body' },
      title && h(size === 'large' ? 'h2' : 'p', { class: 'banner-title' }, title),
      children.length > 0 && h('div', { class: 'banner-content' }, children),
      actions && h('div', { class: 'banner-actions' }, actions),
    ),
  );
}

/** A labelled form control with an optional hint wired up through aria-describedby. */
export function field({ label, control, hint, optional, className }) {
  if (!control.id) control.id = uid('field');
  const hintId = hint ? `${control.id}-hint` : null;
  if (hintId) control.setAttribute('aria-describedby', hintId);
  return h(
    'div',
    { class: ['field', className] },
    h(
      'label',
      { class: 'field-label', for: control.id },
      label,
      optional && h('span', { class: 'field-optional' }, ' (optional)'),
    ),
    control,
    hint && h('p', { class: 'field-hint', id: hintId }, hint),
  );
}

export const input = (props) => h('input', { class: 'input', ...props });

export function select(options, props = {}) {
  return h(
    'select',
    { class: 'input select', ...props },
    options.map((o) => h('option', { value: String(o.value), disabled: o.disabled }, o.label)),
  );
}

const TONE_ICONS = { success: 'check', warning: 'alert', critical: 'error' };

export function statTile({ label, value, tone = 'neutral', href, linkLabel, note }) {
  return h(
    'div',
    { class: ['stat', `stat-${tone}`] },
    h('p', { class: 'stat-label' }, label),
    h(
      'p',
      { class: 'stat-value' },
      TONE_ICONS[tone] && icon(TONE_ICONS[tone], { size: 20 }),
      value,
    ),
    note && h('p', { class: 'stat-note' }, note),
    href && h('a', { class: 'stat-link', href }, linkLabel ?? 'View', icon('chevronRight')),
  );
}

/** Term/value pairs; `numbers` right-aligns the values (counts). */
export function facts(rows, { numbers = false } = {}) {
  return h(
    'dl',
    { class: ['facts', numbers && 'facts-numbers'] },
    rows
      .filter(Boolean)
      .map(([term, value]) => h('div', { class: 'fact' }, h('dt', {}, term), h('dd', {}, value))),
  );
}

/**
 * A data table that becomes a list of cards on phones (each cell shows its column label).
 * `columns`: { label, render(row), align, className }. The first column labels the row.
 * Explicit ARIA roles keep table semantics when CSS changes the display on small screens.
 */
export function dataTable({ columns, rows, caption, rowHref, className }) {
  const body = rows.map((row) => {
    const href = rowHref?.(row);
    const tr = h(
      'tr',
      { role: 'row', class: href ? 'is-clickable' : null },
      columns.map((col, i) =>
        h(
          i === 0 ? 'th' : 'td',
          {
            role: i === 0 ? 'rowheader' : 'cell',
            scope: i === 0 ? 'row' : null,
            'data-label': col.label,
            class: [col.align && `align-${col.align}`, col.className],
          },
          col.render(row),
        ),
      ),
    );
    if (href) {
      // The row's own link stays the accessible way in; this only widens the mouse target.
      tr.addEventListener('click', (event) => {
        if (event.target.closest('a, button, input, select, textarea, label')) return;
        if (window.getSelection()?.toString()) return;
        location.hash = href;
      });
    }
    return tr;
  });
  return h(
    'div',
    { class: ['table-wrap', className] },
    h(
      'table',
      { class: 'table', role: 'table' },
      caption && h('caption', { class: 'sr-only' }, caption),
      h(
        'thead',
        { role: 'rowgroup' },
        h(
          'tr',
          { role: 'row' },
          columns.map((col) =>
            h(
              'th',
              {
                scope: 'col',
                role: 'columnheader',
                class: [col.align && `align-${col.align}`, col.className],
              },
              col.label,
            ),
          ),
        ),
      ),
      h('tbody', { role: 'rowgroup' }, body),
    ),
  );
}

export function pagination({ page, pageSize, total, onPage, noun = 'results' }) {
  if (total <= pageSize && page === 1) return null;
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return h(
    'nav',
    { class: 'pagination', 'aria-label': 'Pages' },
    h('p', { class: 'muted' }, `${num(first)}–${num(last)} of ${num(total)} ${noun}`),
    h(
      'div',
      { class: 'pagination-buttons' },
      button('Previous', {
        size: 'small',
        iconName: 'chevronLeft',
        disabled: page <= 1,
        onClick: () => onPage(page - 1),
      }),
      button('Next', {
        size: 'small',
        disabled: last >= total,
        onClick: () => onPage(page + 1),
      }),
    ),
  );
}

/** A row of toggle buttons (one pressed at a time), used for filters and tabs. */
export function filterBar({ label, options, value, onChange }) {
  const group = h('div', { class: 'chips', role: 'group', 'aria-label': label });
  for (const o of options) {
    const chip = h(
      'button',
      {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(o.value === value),
        dataset: { value: o.value },
      },
      o.label,
      // count null = filled in later with setChipCount().
      o.count !== undefined &&
        h('span', { class: 'chip-count' }, o.count !== null && srParen(num(o.count))),
    );
    chip.addEventListener('click', () => {
      for (const other of group.children) other.setAttribute('aria-pressed', 'false');
      chip.setAttribute('aria-pressed', 'true');
      onChange(o.value);
    });
    group.append(chip);
  }
  return group;
}

export function setChipCount(group, value, count) {
  const target = group.querySelector(`[data-value="${CSS.escape(value)}"] .chip-count`);
  if (target) replace(target, srParen(num(count)));
}

/** "12" on screen, "(12)" for screen readers, so counts don't run into the label. */
const srParen = (text) => [
  h('span', { class: 'sr-only' }, ' ('),
  text,
  h('span', { class: 'sr-only' }, ')'),
];

export const muted = (text, title) => h('span', { class: 'muted', title }, text);
