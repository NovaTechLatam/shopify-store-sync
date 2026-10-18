import { api } from '../api.js';
import { h } from '../dom.js';
import { absoluteTime, plural, timeAgo } from '../format.js';
import { dataTable, emptyState, loadInto } from '../ui.js';
import { runStatusBadge, runStoreSummary, runTitle, shortDateTime } from './prices-shared.js';

/** While an update runs, the list refreshes this often. */
const REFRESH_MS = 3000;

/** The History tab: every update of the stores' prices, newest first. */
export async function render(container, { signal }) {
  const results = h('div', { class: 'results' });
  container.append(
    h(
      'p',
      { class: 'tab-help muted' },
      'Every time prices were sent to your stores, from this page or by a sale or price change, and what happened in each store.',
    ),
    results,
  );
  let timer = null;
  signal.addEventListener('abort', () => clearTimeout(timer));
  const reload = () =>
    loadInto(results, {
      signal,
      keepContent: true,
      load: () => api('/api/prices/runs?limit=30', { signal }),
      render: (runs) => {
        clearTimeout(timer);
        if (runs.some((r) => r.status === 'queued' || r.status === 'running')) {
          timer = setTimeout(reload, REFRESH_MS);
        }
        if (runs.length === 0) {
          return emptyState({
            title: 'No updates yet',
            message: 'When you update prices in your stores, each update is listed here.',
            iconName: 'clock',
          });
        }
        return runTable(runs);
      },
    });
  await reload();
  return { refresh: () => reload() };
}

function runTable(runs) {
  return dataTable({
    caption: 'Price updates',
    className: 'run-table',
    rows: runs,
    columns: [
      {
        label: 'Update',
        className: 'col-product',
        render: (run) =>
          h(
            'div',
            { class: 'product-cell' },
            h('span', { class: 'strong' }, runTitle(run)),
            h(
              'span',
              { class: 'product-meta' },
              timeAgo(run.createdAt),
              h('span', { 'aria-hidden': 'true' }, '·'),
              run.itemCount === null ? 'All products' : plural(run.itemCount, 'product'),
            ),
          ),
      },
      { label: 'Result', render: (run) => runStatusBadge(run) },
      {
        label: 'Stores',
        className: 'col-run-stores',
        render: (run) =>
          h(
            'ul',
            { class: 'plain-list run-store-list' },
            run.stores.map((s) =>
              h(
                'li',
                {},
                h('span', { class: 'strong' }, s.storeName),
                ': ',
                h(
                  'span',
                  { class: s.status === 'failed' ? 'text-critical' : null },
                  runStoreSummary(s, { showChecked: true }),
                ),
                s.status === 'failed' &&
                  s.updated > 0 &&
                  s.error &&
                  h('span', { class: 'block small' }, s.error),
                s.errors.length > 0 && refusals(s),
              ),
            ),
          ),
      },
      {
        label: 'Finished',
        render: (run) =>
          run.finishedAt
            ? h(
                'span',
                { class: 'small', title: absoluteTime(run.finishedAt) },
                shortDateTime(run.finishedAt),
              )
            : h('span', { class: 'muted small' }, 'Not yet'),
      },
    ],
  });
}

/** The SKUs Shopify refused, behind a disclosure. */
function refusals(s) {
  return h(
    'details',
    { class: 'disclosure refusals' },
    h('summary', {}, `What Shopify refused (${s.errors.length})`),
    h(
      'ul',
      { class: 'plain-list small' },
      s.errors.map((e) => h('li', {}, h('span', { class: 'mono' }, e.sku), `: ${e.message}`)),
    ),
  );
}
