import { api } from './api.js';
import { h, icon, replace } from './dom.js';
import { num } from './format.js';
import { toast } from './toast.js';
import { button, withBusy } from './ui.js';

/**
 * The frame around every page: navigation (a menu on phones), the open-alerts count, and a
 * "sync is paused" notice that follows the merchant to every page, so a paused sync is never
 * missed.
 */

const STATUS_REFRESH_MS = 60_000;

let status = null;
let currentNav = null;

export function initShell() {
  for (const el of document.querySelectorAll('[data-icon]')) {
    el.replaceChildren(icon(el.dataset.icon, { size: 18 }));
  }
  const menuButton = document.getElementById('menu-button');
  const sidebar = document.getElementById('sidebar');
  menuButton.addEventListener('click', () => setMenuOpen(!isMenuOpen()));
  // The phone menu closes on a choice or a tap anywhere else.
  document.addEventListener('click', (event) => {
    if (!isMenuOpen() || menuButton.contains(event.target)) return;
    if (!sidebar.contains(event.target) || event.target.closest('a')) setMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isMenuOpen()) {
      setMenuOpen(false);
      menuButton.focus();
    }
  });
  document.getElementById('skip-link').addEventListener('click', () => {
    document.getElementById('main').focus();
  });

  refreshStatus();
  setInterval(() => {
    if (!document.hidden) refreshStatus();
  }, STATUS_REFRESH_MS);
}

const isMenuOpen = () => document.getElementById('sidebar').classList.contains('is-open');

function setMenuOpen(open) {
  document.getElementById('sidebar').classList.toggle('is-open', open);
  document.getElementById('menu-button').setAttribute('aria-expanded', String(open));
}

export const closeMenu = () => setMenuOpen(false);

export function setActiveNav(nav) {
  currentNav = nav;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  renderNotice();
}

export async function refreshStatus() {
  try {
    updateShell(await api('/api/status'));
  } catch {
    // Views show their own loading errors; the frame just keeps its last known state.
  }
}

/** Views that load /api/status anyway pass it here to keep the frame current. */
export function updateShell(next) {
  status = next;
  const count = document.getElementById('alerts-count');
  count.hidden = next.openAlerts === 0;
  replace(
    count,
    h('span', { class: 'sr-only' }, ' ('),
    num(next.openAlerts),
    h('span', { class: 'sr-only' }, ' open)'),
  );
  document.getElementById('nav-onboarding').hidden = next.onboardingCompleted;
  renderNotice();
}

function renderNotice() {
  const notice = document.getElementById('global-notice');
  // The overview and settings pages show the pause state prominently themselves.
  const show = status?.syncPaused && currentNav !== 'overview' && currentNav !== 'settings';
  if (!show) {
    notice.replaceChildren();
    return;
  }
  replace(
    notice,
    h(
      'div',
      { class: 'global-notice', role: 'status' },
      icon('pause', { size: 18 }),
      h(
        'p',
        {},
        h('strong', {}, 'Sync is paused. '),
        'Stock changes are not being sent to your stores.',
      ),
      button('Resume sync', { size: 'small', onClick: (e) => resumeSync(e.currentTarget) }),
    ),
  );
}

/** Turns the global kill switch off again. Resolves true when sync was resumed. */
export async function resumeSync(btn) {
  const resumed = await withBusy(btn, async () => {
    await api('/api/settings/resume', { method: 'POST' });
    return true;
  }).catch(() => false);
  if (resumed) {
    toast('Sync resumed. Stores will catch up in a few seconds.');
    await refreshStatus();
  }
  return Boolean(resumed);
}
