import { h, icon } from './dom.js';

const MAX_VISIBLE = 3;
const TONE_ICONS = { success: 'check', error: 'error', info: 'info' };

/**
 * Shows a short message at the bottom of the screen. Errors stay longer and are announced
 * immediately (role="alert"); others go through the polite live region in index.html.
 */
export function toast(message, { tone = 'success' } = {}) {
  const region = document.getElementById('toasts');
  if (!region) return;
  const close = () => el.remove();
  const el = h(
    'div',
    { class: ['toast', `toast-${tone}`], role: tone === 'error' ? 'alert' : null },
    icon(TONE_ICONS[tone] ?? 'info', { size: 18, className: 'toast-icon' }),
    h('p', { class: 'toast-message' }, message),
    h(
      'button',
      { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', onclick: close },
      icon('close', { size: 16 }),
    ),
  );
  region.append(el);
  while (region.children.length > MAX_VISIBLE) region.firstElementChild.remove();

  // Paused while hovered or focused so it can be read (or its button reached) at any pace.
  const timeout = tone === 'error' ? 9000 : 5000;
  let timer = setTimeout(close, timeout);
  const hold = () => clearTimeout(timer);
  const release = () => {
    clearTimeout(timer);
    timer = setTimeout(close, timeout);
  };
  el.addEventListener('mouseenter', hold);
  el.addEventListener('focusin', hold);
  el.addEventListener('mouseleave', release);
  el.addEventListener('focusout', release);
}
