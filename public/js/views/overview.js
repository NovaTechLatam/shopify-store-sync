import { api, isAbort } from '../api.js';
import { isDialogOpen } from '../dialog.js';
import { h, icon, replace, replaceKeepingFocus } from '../dom.js';
import { num, plural, timeAgo } from '../format.js';
import { alertBadge, alertLink, storeProblem, storeStatusBadge } from '../labels.js';
import { resumeSync, updateShell } from '../shell.js';
import {
  banner,
  button,
  card,
  emptyState,
  errorState,
  facts,
  linkButton,
  loadingState,
  muted,
  pageHeader,
  statTile,
  withBusy,
} from '../ui.js';

const REFRESH_MS = 15_000;
const ALERTS_SHOWN = 5;

export async function render({ root, signal, setTitle }) {
  setTitle('Overview');
  const updated = h('span', { class: 'refresh-note', 'aria-live': 'polite' }, 'Loading…');
  const refreshButton = button('Refresh', {
    size: 'small',
    iconName: 'refresh',
    onClick: () => withBusy(refreshButton, refresh),
  });
  const body = h('div', { class: 'stack-lg' }, loadingState({ lines: 8 }));
  root.append(
    pageHeader({
      title: 'Overview',
      subtitle: 'Your shared stock across every store, at a glance.',
      actions: [updated, refreshButton],
    }),
    body,
  );

  let timer;
  let loaded = false;
  let latest = 0;
  async function refresh() {
    clearTimeout(timer);
    // A manual refresh can overlap the automatic one: only the newest response is shown.
    const request = ++latest;
    try {
      const [status, stores, alerts] = await Promise.all([
        api('/api/status', { signal }),
        api('/api/stores', { signal }),
        api('/api/alerts?status=open', { signal }),
      ]);
      if (request !== latest) return;
      updateShell(status);
      replaceKeepingFocus(body, overview(status, stores, alerts, refresh));
      replace(updated, 'Updated ', timeAgo(new Date()));
      loaded = true;
    } catch (err) {
      if (signal.aborted || isAbort(err) || request !== latest) return;
      // After the first load keep showing the last known state rather than a blank error.
      if (loaded) replace(updated, icon('alert'), ' Couldn’t refresh. Retrying…');
      else replace(body, errorState(err, retry));
    } finally {
      if (!signal.aborted && request === latest) {
        clearTimeout(timer);
        timer = setTimeout(tick, REFRESH_MS);
      }
    }
  }
  function retry() {
    replace(body, loadingState({ lines: 8 }));
    return refresh();
  }
  function tick() {
    // Don't re-render under an open dialog or in a background tab.
    if (document.hidden || isDialogOpen()) timer = setTimeout(tick, REFRESH_MS);
    else refresh();
  }
  signal.addEventListener('abort', () => clearTimeout(timer));
  document.addEventListener(
    'visibilitychange',
    () => {
      if (!document.hidden && loaded) refresh();
    },
    { signal },
  );
  await refresh();
}

function overview(status, stores, alerts, refresh) {
  // First run: nothing to count yet, just the way in.
  if (stores.length === 0) return [statusBanner(status, stores, refresh)];
  return [
    statusBanner(status, stores, refresh),
    storesSection(stores),
    productsSection(status),
    h('div', { class: 'grid-2' }, alertsCard(alerts), queueCard(status)),
  ];
}

function statusBanner(status, stores, refresh) {
  if (status.syncPaused) {
    const resume = button('Resume sync', {
      variant: 'primary',
      attrs: { 'data-key': 'resume' },
      onClick: async (e) => {
        if (await resumeSync(e.currentTarget)) refresh();
      },
    });
    return banner(
      {
        tone: 'warning',
        iconName: 'pause',
        size: 'large',
        title: 'Sync is paused',
        actions: resume,
      },
      h('p', {}, status.pausedReason || 'Paused from the dashboard.'),
      h(
        'p',
        { class: 'muted' },
        'No stock changes are sent to your stores while sync is paused. Sales and edits made in the meantime are counted when you resume.',
      ),
    );
  }
  if (stores.length === 0) {
    return banner(
      {
        tone: 'info',
        size: 'large',
        title: 'Connect your first store',
        actions: linkButton('Add a store', '#/stores/new', {
          variant: 'primary',
          iconName: 'plus',
        }),
      },
      h('p', {}, 'Add each of your brand stores to start sharing one stock between them.'),
    );
  }
  const problems = attentionItems(status, stores);
  if (!status.onboardingCompleted) {
    return banner(
      {
        tone: 'info',
        iconName: 'play',
        size: 'large',
        title: 'Not syncing yet',
        actions: linkButton('Start syncing', '#/onboarding', { variant: 'primary' }),
      },
      h(
        'p',
        {},
        'Your stores are connected. Choose the starting stock numbers to begin syncing. Nothing changes in your stores until you confirm.',
      ),
      problemList(problems),
    );
  }
  if (problems.length > 0) {
    const critical = problems.some((p) => p.tone === 'critical');
    return banner(
      { tone: critical ? 'critical' : 'warning', size: 'large', title: 'Needs attention' },
      h('p', {}, 'Sync is running, but some things need a look:'),
      problemList(problems),
    );
  }
  const lastUpdate = stores
    .map((s) => s.lastWebhookAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const active = stores.filter((s) => s.status === 'active').length;
  return banner(
    { tone: 'success', size: 'large', title: 'Sync is running' },
    h(
      'p',
      {},
      `Stock is shared across ${plural(active, 'active store')}. Changes are sent to every store within seconds.`,
    ),
    lastUpdate && h('p', { class: 'muted' }, 'Last change received ', timeAgo(lastUpdate), '.'),
  );
}

function attentionItems(status, stores) {
  const items = [];
  for (const store of stores) {
    const problem = storeProblem(store);
    if (problem) {
      items.push({
        tone: problem.tone,
        text: `${store.name}: ${problem.title}`,
        href: `#/stores/${store.id}`,
      });
    }
  }
  if (status.items.oversold > 0) {
    items.push({
      tone: 'critical',
      text: `${plural(status.items.oversold, 'product')} oversold`,
      href: '#/items?filter=oversold',
    });
  }
  if (status.queue.failing > 0) {
    items.push({
      tone: 'warning',
      text: `${plural(status.queue.failing, 'product')} keep failing to sync`,
      href: '#/items?filter=issues',
    });
  }
  if (status.tasks.failing > 0) {
    items.push({
      tone: 'warning',
      text: `${plural(status.tasks.failing, 'background job')} (catalog or webhook updates) keep failing`,
      href: '#/stores',
    });
  }
  if (status.conflicts > 0) {
    items.push({
      tone: 'warning',
      text: `${plural(status.conflicts, 'variant')} not synced because of duplicate SKUs`,
      href: '#/mapping?tab=conflicts',
    });
  }
  return items;
}

function problemList(problems) {
  if (problems.length === 0) return null;
  return h(
    'ul',
    { class: 'problem-list' },
    problems.map((p) =>
      h(
        'li',
        { class: `tone-${p.tone}` },
        icon(p.tone === 'critical' ? 'error' : 'alert'),
        h('a', { href: p.href }, p.text),
      ),
    ),
  );
}

function storesSection(stores) {
  return h(
    'section',
    { class: 'section', 'aria-labelledby': 'overview-stores' },
    h(
      'div',
      { class: 'section-header' },
      h('h2', { id: 'overview-stores', class: 'section-title' }, 'Stores'),
      linkButton('Manage stores', '#/stores', { variant: 'plain', size: 'small' }),
    ),
    h('div', { class: 'tile-grid' }, stores.map(storeTile)),
  );
}

function storeTile(store) {
  const problem = storeProblem(store);
  let check = muted('Not yet');
  if (store.lastDriftScanAt) {
    check = [
      timeAgo(store.lastDriftScanAt),
      store.lastDriftCount > 0 ? ` · ${num(store.lastDriftCount)} fixed` : ' · all matched',
    ];
  }
  return h(
    'article',
    { class: 'tile' },
    h(
      'div',
      { class: 'tile-header' },
      h('h3', { class: 'tile-title' }, h('a', { href: `#/stores/${store.id}` }, store.name)),
      storeStatusBadge(store.status),
    ),
    facts([
      ['Last update', timeAgo(store.lastWebhookAt, { never: 'None yet' })],
      ['Matched', `${num(store.linkedCount)} of ${plural(store.variantCount, 'variant')}`],
      ['Full check', check],
    ]),
    problem &&
      h(
        'div',
        { class: ['tile-problem', `tone-${problem.tone}`] },
        h(
          'p',
          { class: 'tile-problem-title' },
          icon(problem.tone === 'critical' ? 'error' : 'alert'),
          problem.title,
        ),
        store.lastError && h('p', { class: 'tile-problem-detail' }, store.lastError),
        h('p', { class: 'tile-problem-hint' }, problem.hint),
      ),
  );
}

function productsSection(status) {
  const { items } = status;
  const notStartedLink =
    items.uninitialized === 0
      ? {}
      : status.onboardingCompleted
        ? { href: '#/items?filter=uninitialized' }
        : { href: '#/onboarding', linkLabel: 'Start syncing' };
  const extras = [
    items.disabled > 0 && [
      `${plural(items.disabled, 'product')} paused`,
      '#/items?filter=disabled',
    ],
    status.unmatchedVariants > 0 && [
      `${plural(status.unmatchedVariants, 'variant')} sold in only one store`,
      '#/mapping',
    ],
    status.conflicts > 0 && [
      `${plural(status.conflicts, 'variant')} with duplicate SKUs`,
      '#/mapping?tab=conflicts',
    ],
  ].filter(Boolean);
  return h(
    'section',
    { class: 'section', 'aria-labelledby': 'overview-products' },
    h(
      'div',
      { class: 'section-header' },
      h('h2', { id: 'overview-products', class: 'section-title' }, 'Products'),
      linkButton('All products', '#/items', { variant: 'plain', size: 'small' }),
    ),
    h(
      'div',
      { class: 'stats' },
      statTile({
        label: 'Syncing',
        value: num(items.initialized),
        note: `of ${plural(items.total, 'product')}`,
      }),
      statTile({
        label: 'Not started',
        value: num(items.uninitialized),
        tone: items.uninitialized > 0 && status.onboardingCompleted ? 'warning' : 'neutral',
        ...notStartedLink,
      }),
      statTile({
        label: 'Low stock',
        value: num(items.lowStock),
        tone: items.lowStock > 0 ? 'warning' : 'neutral',
        href: items.lowStock > 0 ? '#/items?filter=low' : null,
      }),
      statTile({
        label: 'Oversold',
        value: num(items.oversold),
        tone: items.oversold > 0 ? 'critical' : 'neutral',
        href: items.oversold > 0 ? '#/items?filter=oversold' : null,
      }),
    ),
    extras.length > 0 &&
      h(
        'ul',
        { class: 'inline-links' },
        extras.map(([text, href]) => h('li', {}, h('a', { href }, text))),
      ),
  );
}

/** Where to act on an alert: its page (a catalog product, the sales...), product or store. */
function overviewAlertLink(a) {
  const link =
    alertLink(a) ??
    (a.itemId
      ? { href: `#/items/${a.itemId}`, label: `Open ${a.sku ?? 'product'}` }
      : a.storeId
        ? { href: `#/stores/${a.storeId}`, label: `Open ${a.storeName ?? 'the store'}` }
        : null);
  return link && h('a', { href: link.href, class: 'small' }, link.label);
}

function alertsCard(alerts) {
  const shown = alerts.slice(0, ALERTS_SHOWN);
  return card(
    {
      title: 'Open alerts',
      actions:
        alerts.length > 0 &&
        linkButton(
          alerts.length > ALERTS_SHOWN ? `View all ${num(alerts.length)}` : 'View all',
          '#/alerts',
          {
            variant: 'plain',
            size: 'small',
          },
        ),
    },
    shown.length === 0
      ? emptyState({ title: 'No open alerts', message: 'You’re all set.', iconName: 'check' })
      : h(
          'ul',
          { class: 'compact-list' },
          shown.map((a) =>
            h(
              'li',
              {},
              h('div', { class: 'compact-list-head' }, alertBadge(a.kind), timeAgo(a.createdAt)),
              h('p', {}, a.message),
              overviewAlertLink(a),
            ),
          ),
        ),
  );
}

function queueCard(status) {
  const { queue, tasks } = status;
  const count = (n, tone) =>
    n > 0 && tone ? h('span', { class: `text-${tone}` }, icon('alert'), ' ', num(n)) : num(n);
  return card(
    {
      title: 'Sync queue',
      description: 'Usually all zero: changes reach every store within seconds.',
    },
    facts(
      [
        ['Products waiting to sync', num(queue.ready)],
        ['Syncing right now', num(queue.running)],
        ['Waiting to retry', num(queue.delayed)],
        ['Failing repeatedly', count(queue.failing, 'warning')],
        ['Background jobs waiting', num(tasks.ready + tasks.running)],
        ['Background jobs failing', count(tasks.failing, 'warning')],
      ],
      { numbers: true },
    ),
  );
}
