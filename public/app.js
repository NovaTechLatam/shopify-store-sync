import { closeDialogs } from './js/dialog.js';
import { h } from './js/dom.js';
import { startRelativeTimeTicker } from './js/format.js';
import { closeMenu, initShell, setActiveNav } from './js/shell.js';
import { errorState, linkButton, pageHeader } from './js/ui.js';
import * as activity from './js/views/activity.js';
import * as alerts from './js/views/alerts.js';
import * as catalogProduct from './js/views/catalog-product.js';
import * as catalog from './js/views/catalog.js';
import * as item from './js/views/item.js';
import * as items from './js/views/items.js';
import * as mapping from './js/views/mapping.js';
import * as onboarding from './js/views/onboarding.js';
import * as overview from './js/views/overview.js';
import * as prices from './js/views/prices.js';
import * as purchaseOrder from './js/views/purchase-order.js';
import * as purchasing from './js/views/purchasing.js';
import * as reports from './js/views/reports.js';
import * as settings from './js/views/settings.js';
import * as storeNew from './js/views/store-new.js';
import * as store from './js/views/store.js';
import * as stores from './js/views/stores.js';

/**
 * Hash router. Each view is `render(ctx)` with ctx = { root, params, query, signal, setTitle }:
 * it renders its page header synchronously, then loads its data. `signal` aborts when the
 * merchant navigates away, so late responses and timers of a left page are dropped.
 */
const ROUTES = [
  { path: /^\/$/, nav: 'overview', render: overview.render },
  { path: /^\/items$/, nav: 'items', render: items.render },
  { path: /^\/items\/(\d+)$/, nav: 'items', render: item.render },
  { path: /^\/catalog$/, nav: 'catalog', render: catalog.render },
  { path: /^\/catalog\/new$/, nav: 'catalog', render: catalogProduct.render },
  { path: /^\/catalog\/(\d+)$/, nav: 'catalog', render: catalogProduct.render },
  { path: /^\/prices$/, nav: 'prices', render: prices.render },
  { path: /^\/purchasing$/, nav: 'purchasing', render: purchasing.render },
  { path: /^\/purchasing\/orders\/new$/, nav: 'purchasing', render: purchaseOrder.render },
  { path: /^\/purchasing\/orders\/(\d+)$/, nav: 'purchasing', render: purchaseOrder.render },
  { path: /^\/reports$/, nav: 'reports', render: reports.render },
  { path: /^\/mapping$/, nav: 'mapping', render: mapping.render },
  { path: /^\/stores$/, nav: 'stores', render: stores.render },
  { path: /^\/stores\/new$/, nav: 'stores', render: storeNew.render },
  { path: /^\/stores\/(\d+)$/, nav: 'stores', render: store.render },
  { path: /^\/onboarding$/, nav: 'onboarding', render: onboarding.render },
  { path: /^\/activity$/, nav: 'activity', render: activity.render },
  { path: /^\/alerts$/, nav: 'alerts', render: alerts.render },
  { path: /^\/settings$/, nav: 'settings', render: settings.render },
];

let currentView = null;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(search) };
}

function setTitle(title) {
  document.title = `${title} · Store Sync`;
}

function notFound({ root }) {
  setTitle('Page not found');
  root.append(
    pageHeader({ title: 'Page not found' }),
    h(
      'p',
      {},
      'This page doesn’t exist. ',
      linkButton('Go to the overview', '#/', { variant: 'plain' }),
    ),
  );
}

async function route({ focus }) {
  currentView?.abort();
  const controller = new AbortController();
  currentView = controller;

  const { path, query } = parseHash();
  let match = null;
  const found = ROUTES.find((r) => (match = r.path.exec(path)));
  const root = h('div', { class: 'view' });
  document.getElementById('main').replaceChildren(root);
  setActiveNav(found?.nav ?? null);
  closeMenu();
  closeDialogs();
  window.scrollTo(0, 0);

  const ctx = {
    root,
    params: found ? match.slice(1) : [],
    query,
    signal: controller.signal,
    setTitle,
  };
  try {
    const rendering = (found?.render ?? notFound)(ctx);
    // Views render their header before the first await, so the new title can be announced now.
    if (focus) root.querySelector('h1')?.focus({ preventScroll: true });
    await rendering;
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error(err);
    root.append(errorState(err, () => route({ focus: false })));
  }
}

initShell();
startRelativeTimeTicker();
window.addEventListener('hashchange', () => route({ focus: true }));
route({ focus: false });
