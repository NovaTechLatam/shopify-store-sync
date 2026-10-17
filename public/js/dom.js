/**
 * DOM helpers. Server data only ever reaches the page as text nodes or as attribute values set
 * through the DOM API (never through innerHTML), so it can't inject markup or scripts.
 */

const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction']);
// Internal hash routes, same-origin paths and plain web links; anything else (javascript:, data:)
// is dropped.
const SAFE_URL = /^(#|\/(?!\/)|https?:\/\/|mailto:)/i;

/**
 * Creates an element. `props` are attributes, except: `class` (string or array), `dataset`,
 * `value`/`checked` (set as properties) and `on<event>` functions (event listeners).
 * Children may be nodes, strings, numbers, nested arrays, or null/false (skipped).
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  append(el, children);
  // Properties after children, so a <select>'s value can pick one of its options.
  if (props) for (const [key, value] of Object.entries(props)) setProp(el, key, value);
  return el;
}

function setProp(el, key, value) {
  if (value === null || value === undefined || value === false) return;
  if (typeof value === 'function' && key.startsWith('on')) {
    el.addEventListener(key.slice(2).toLowerCase(), value);
  } else if (key === 'class') {
    el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
  } else if (key === 'dataset') {
    Object.assign(el.dataset, value);
  } else if (key === 'value' || key === 'checked') {
    el[key] = value;
  } else {
    if (URL_ATTRIBUTES.has(key) && !SAFE_URL.test(String(value))) return;
    el.setAttribute(key, value === true ? '' : String(value));
  }
}

export function append(parent, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : String(child));
  }
  return parent;
}

export function replace(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

/**
 * Replaces the content of `parent` and puts keyboard focus back on the element with the same
 * `data-key` (used by views that refresh themselves while the merchant is using them).
 */
export function replaceKeepingFocus(parent, ...children) {
  const active = document.activeElement;
  const key = active && parent.contains(active) ? active.dataset?.key : undefined;
  replace(parent, ...children);
  if (key) parent.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

let idCounter = 0;
export const uid = (prefix = 'id') => `${prefix}-${++idCounter}`;

export const srOnly = (text) => h('span', { class: 'sr-only' }, text);

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const CIRCLE = 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18';
const ICONS = {
  home: ['M3 10.5 12 3l9 7.5', 'M5 9v12h14V9', 'M10 21v-6h4v6'],
  box: ['M21 8 12 3 3 8v8l9 5 9-5z', 'M3 8l9 5 9-5', 'M12 13v8'],
  link: [
    'M10 13.5a4 4 0 0 0 5.66.3l3-3a4 4 0 0 0-5.66-5.66l-1.2 1.2',
    'M14 10.5a4 4 0 0 0-5.66-.3l-3 3a4 4 0 0 0 5.66 5.66l1.2-1.2',
  ],
  store: ['M4 10v10h16V10', 'M3 4h18l-1.5 6h-15z', 'M9.5 20v-5h5v5'],
  pulse: ['M3 12h4l3-8 4 16 3-8h4'],
  bell: ['M6 9a6 6 0 1 1 12 0c0 6 3 8 3 8H3s3-2 3-8', 'M10 21h4'],
  sliders: [
    'M4 6h9',
    'M17 6h3',
    'M4 12h3',
    'M11 12h9',
    'M4 18h11',
    'M15 4v4',
    'M9 10v4',
    'M17 16v4',
  ],
  play: [CIRCLE, 'M10 8.5v7l6-3.5z'],
  check: [CIRCLE, 'M8 12.5l2.5 2.5L16 9.5'],
  alert: ['M12 3.5 2.5 20h19z', 'M12 10v4', 'M12 17h.01'],
  error: [CIRCLE, 'M9 9l6 6', 'M15 9l-6 6'],
  pause: [CIRCLE, 'M10 9v6', 'M14 9v6'],
  info: [CIRCLE, 'M12 11v5', 'M12 8h.01'],
  clock: [CIRCLE, 'M12 7.5V12l3 2'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  chevronLeft: ['M15 6l-6 6 6 6'],
  chevronRight: ['M9 6l6 6-6 6'],
  refresh: ['M20 12a8 8 0 1 1-2.34-5.66L20 8.5', 'M20 4v4.5h-4.5'],
  search: ['M11 4a7 7 0 1 1 0 14a7 7 0 1 1 0-14', 'M20 20l-3.5-3.5'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
  plus: ['M12 5v14', 'M5 12h14'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
};

/** A decorative stroke icon; the text next to it carries the meaning. */
export function icon(name, { size = 16, className } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className ? `icon ${className}` : 'icon');
  for (const d of ICONS[name] ?? ICONS.info) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
