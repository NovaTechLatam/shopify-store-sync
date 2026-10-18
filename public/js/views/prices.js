import { api, isAbort, qs } from '../api.js';
import { formDialog } from '../dialog.js';
import { h, icon, replace, uid } from '../dom.js';
import { money, percent, plural } from '../format.js';
import { toast } from '../toast.js';
import { banner, button, filterBar, pageHeader, withBusy } from '../ui.js';
import * as historyTab from './prices-history.js';
import * as listTab from './prices-list.js';
import * as rulesTab from './prices-rules.js';
import * as salesTab from './prices-schedules.js';
import { runStoreSummary } from './prices-shared.js';

const TABS = [
  { value: 'prices', label: 'Prices', view: listTab },
  { value: 'rules', label: 'Rules', view: rulesTab },
  { value: 'sales', label: 'Sales & changes', view: salesTab },
  { value: 'history', label: 'History', view: historyTab },
];

/** Checks on a running update this often. */
const POLL_MS = 1500;

/** #/prices: base prices, each brand's price rule, sales and price changes, updates. */
export async function render({ root, query, signal, setTitle }) {
  setTitle('Prices');
  let tab = TABS.find((t) => t.value === query.get('tab')) ?? TABS[0];
  const progress = h('div', { class: 'price-progress' });
  const body = h('div', { class: 'price-tab' });
  const update = button('Update prices in stores…', { variant: 'primary', iconName: 'upload' });
  root.append(
    pageHeader({
      title: 'Prices',
      subtitle: 'Set base prices once; each brand’s prices follow its own rule.',
      actions: [update],
    }),
    filterBar({
      label: 'Show',
      options: TABS,
      value: tab.value,
      onChange: (value) => {
        tab = TABS.find((t) => t.value === value);
        history.replaceState(null, '', `#/prices${qs({ tab: value === 'prices' ? '' : value })}`);
        showTab(new URLSearchParams());
      },
    }),
    progress,
    body,
  );

  // What each tab gets: its own signal (aborted when another tab is shown), the query it was
  // opened with, and ways to start an update and reload itself.
  let tabController = null;
  function showTab(tabQuery) {
    tabController?.abort();
    const controller = new AbortController();
    tabController = controller;
    signal.addEventListener('abort', () => controller.abort(), { once: true });
    replace(body);
    return tab.view.render(body, {
      query: tabQuery,
      signal: controller.signal,
      startUpdate: (opts) => openUpdate(opts),
      watchRun: (runId) => watch(runId),
      reload: () => showTab(new URLSearchParams(location.hash.split('?')[1] ?? '')),
    });
  }

  async function openUpdate({ itemIds, trigger = update } = {}) {
    const runId = await updateDialog(trigger, itemIds);
    if (runId) watch(runId);
  }
  update.addEventListener('click', () => openUpdate());

  let watching = null;
  function watch(runId) {
    if (watching === runId) return;
    watching = runId;
    const poll = async () => {
      if (signal.aborted || watching !== runId) return;
      let run;
      try {
        run = await api(`/api/prices/runs/${runId}`, { signal });
      } catch (err) {
        if (isAbort(err)) return;
        setTimeout(poll, POLL_MS * 2);
        return;
      }
      replace(
        progress,
        progressBanner(run, () => replace(progress)),
      );
      if (run.status === 'queued' || run.status === 'running') {
        setTimeout(poll, POLL_MS);
        return;
      }
      watching = null;
      const updated = run.stores.reduce((n, s) => n + s.updated, 0);
      toast(
        run.status === 'failed'
          ? 'Some stores couldn’t be updated. The reasons are at the top of this page.'
          : `Prices updated: ${plural(updated, 'price')} changed in your stores.`,
        { tone: run.status === 'failed' ? 'error' : 'success' },
      );
      showTab(new URLSearchParams(location.hash.split('?')[1] ?? ''));
    };
    poll();
  }

  // An update still running (started earlier, or by a schedule): show its progress.
  api('/api/prices/runs?limit=1', { signal })
    .then(([last]) => {
      if (last && (last.status === 'queued' || last.status === 'running')) watch(last.id);
    })
    .catch(() => {
      // The tab itself reports connection problems.
    });

  await showTab(query);
}

function progressBanner(run, dismiss) {
  const running = run.status === 'queued' || run.status === 'running';
  const tone = running ? 'info' : run.status === 'failed' ? 'warning' : 'success';
  const title = running
    ? 'Updating prices in your stores…'
    : run.status === 'failed'
      ? 'Prices were updated in some stores only'
      : 'Prices updated';
  return h(
    'div',
    { role: 'status' },
    banner(
      {
        tone,
        iconName: running ? 'refresh' : undefined,
        title,
        actions: running
          ? null
          : [
              h('a', { href: '#/prices?tab=history', class: 'button button-small' }, 'See details'),
              button('Dismiss', { size: 'small', variant: 'plain', onClick: dismiss }),
            ],
      },
      h(
        'ul',
        { class: 'plain-list run-store-list' },
        run.stores.map((s) =>
          h(
            'li',
            {},
            h('span', { class: 'strong' }, s.storeName),
            ': ',
            s.status === 'running' && s.error ? s.error : runStoreSummary(s),
          ),
        ),
      ),
    ),
  );
}

/**
 * "Update prices in stores…": what would change per store (from the prices we last read), big
 * drops to look at, and which stores can't be updated; then starts the update. Resolves with the
 * run id, or null when cancelled.
 */
async function updateDialog(trigger, itemIds) {
  const preview = await withBusy(trigger, () =>
    api(`/api/prices/apply/preview${qs({ itemIds: itemIds?.join(',') })}`),
  ).catch(() => null);
  if (!preview) return null;
  const name = uid('stores');
  const anyReady = preview.stores.some((s) => s.canUpdate);
  const result = await formDialog({
    title: 'Update prices in your stores?',
    intro: h(
      'div',
      {},
      h(
        'p',
        {},
        itemIds
          ? `Sends the prices of ${plural(itemIds.length, 'product')} to the stores you choose.`
          : 'Sends today’s prices to the stores you choose: base prices through each store’s rule, and fixed prices.',
      ),
      h(
        'p',
        { class: 'muted small' },
        'Counts are from the prices we last read. Each store is read again before anything is written.',
      ),
    ),
    content: [
      h(
        'fieldset',
        { class: 'update-stores' },
        h('legend', { class: 'field-label' }, 'Stores'),
        preview.stores.map((s) => storeChoice(s, name)),
      ),
      !anyReady &&
        h(
          'p',
          { class: 'field-hint' },
          'No store can be updated right now. The reasons are under each store.',
        ),
    ],
    submitLabel: 'Update prices',
    onSubmit: async (form) => {
      const storeIds = [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((el) =>
        Number(el.value),
      );
      if (storeIds.length === 0) throw new Error('Choose at least one store to update.');
      return api('/api/prices/apply', {
        method: 'POST',
        body: { storeIds, ...(itemIds ? { itemIds } : {}) },
        toastErrors: false,
      });
    },
  });
  if (!result) return null;
  const queued = result.stores.filter((s) => s.status === 'queued');
  toast(
    `Updating prices in ${plural(queued.length, 'store')}. You can follow the progress on this page.`,
    { tone: 'info' },
  );
  return result.runId;
}

function storeChoice(s, name) {
  const id = uid('store');
  const changes =
    s.changes === 0
      ? 'No changes expected'
      : `${plural(s.changes, 'price')} to change: ${s.increases} up, ${s.decreases} down`;
  return h(
    'div',
    { class: ['update-store', !s.canUpdate && 'is-disabled'] },
    h(
      'label',
      { class: 'checkbox', for: id },
      h('input', {
        type: 'checkbox',
        id,
        name,
        value: String(s.storeId),
        checked: s.canUpdate && s.changes > 0,
        disabled: !s.canUpdate,
      }),
      h(
        'span',
        {},
        h('span', { class: 'strong' }, s.storeName),
        h('span', { class: 'field-hint block' }, s.canUpdate ? changes : s.reason),
        s.canUpdate &&
          s.missingBase > 0 &&
          h(
            'span',
            { class: 'field-hint block' },
            `${plural(s.missingBase, 'product')} without a base price keep their price.`,
          ),
      ),
    ),
    s.canUpdate && s.bigDropCount > 0 && bigDrops(s),
  );
}

function bigDrops(s) {
  return h(
    'div',
    { class: 'big-drops' },
    h(
      'p',
      { class: 'big-drops-title' },
      icon('alert', { size: 14 }),
      `${plural(s.bigDropCount, 'price')} drop by 20% or more:`,
    ),
    h(
      'ul',
      { class: 'plain-list' },
      s.bigDrops.map((d) =>
        h(
          'li',
          {},
          h('span', { class: 'mono' }, d.sku),
          ` ${money(d.from, s.currencyCode)} → ${money(d.to, s.currencyCode)} (${percent(d.change)})`,
        ),
      ),
      s.bigDropCount > s.bigDrops.length &&
        h('li', { class: 'muted' }, `and ${s.bigDropCount - s.bigDrops.length} more`),
    ),
  );
}
