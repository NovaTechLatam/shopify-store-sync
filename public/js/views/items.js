import { api, latestOnly, qs } from '../api.js';
import { debounce, h, icon, srOnly, uid } from '../dom.js';
import { num, plural } from '../format.js';
import {
  badge,
  dataTable,
  emptyState,
  filterBar,
  input,
  linkButton,
  loadInto,
  muted,
  pageHeader,
  pagination,
} from '../ui.js';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'issues', label: 'Needs attention' },
  { value: 'uninitialized', label: 'Not started' },
  { value: 'low', label: 'Low stock' },
  { value: 'oversold', label: 'Oversold' },
  { value: 'disabled', label: 'Paused' },
];
const PAGE_SIZE = 50;
const ISSUES_SHOWN = 2;

export async function render({ root, query, signal, setTitle }) {
  setTitle('Products');
  const state = {
    search: query.get('search') ?? '',
    filter: FILTERS.some((f) => f.value === query.get('filter')) ? query.get('filter') : 'all',
    page: Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1),
  };

  const searchInput = input({
    type: 'search',
    id: uid('search'),
    value: state.search,
    placeholder: 'Search by SKU, name or barcode',
    autocomplete: 'off',
  });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const results = h('div', { class: 'results' });
  root.append(
    pageHeader({
      title: 'Products',
      subtitle: 'One shared stock number per product, and what each store shows.',
    }),
    h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'search' },
        h('label', { class: 'sr-only', for: searchInput.id }, 'Search products'),
        icon('search', { className: 'search-icon' }),
        searchInput,
      ),
      filterBar({
        label: 'Show',
        options: FILTERS,
        value: state.filter,
        onChange: (value) => {
          state.filter = value;
          state.page = 1;
          update();
        },
      }),
    ),
    announcer,
    results,
  );

  // Stores and settings rarely change: load them once per visit (again only after a failure).
  let shared = null;
  const loadShared = () =>
    (shared ??= Promise.all([
      api('/api/stores', { signal }),
      api('/api/settings', { signal }),
    ]).catch((err) => {
      shared = null;
      throw err;
    }));

  const update = latestOnly(signal, async (reqSignal) => {
    // replaceState: keeps the filters in the address (refresh, sharing) without a re-render.
    history.replaceState(
      null,
      '',
      `#/items${qs({
        search: state.search,
        filter: state.filter === 'all' ? '' : state.filter,
        page: state.page > 1 ? state.page : '',
      })}`,
    );
    await loadInto(results, {
      signal: reqSignal,
      keepContent: true,
      load: async () => {
        const [list, [stores, settings]] = await Promise.all([
          api(
            `/api/items${qs({ search: state.search, filter: state.filter, page: state.page, pageSize: PAGE_SIZE })}`,
            { signal: reqSignal },
          ),
          loadShared(),
        ]);
        return { list, stores, settings };
      },
      render: ({ list, stores, settings }) => {
        announcer.textContent = `${plural(list.total, 'product')} found`;
        return renderList(list, stores, settings, state, (page) => {
          state.page = page;
          update().then(() => results.scrollIntoView({ block: 'start' }));
        });
      },
    });
  });

  searchInput.addEventListener(
    'input',
    debounce(() => {
      state.search = searchInput.value.trim();
      state.page = 1;
      update();
    }, 300),
  );
  await update();
}

function renderList(list, stores, settings, state, onPage) {
  if (list.total === 0) return noResults(state);
  const columns = [
    { label: 'Product', className: 'col-product', render: productCell },
    {
      label: 'Shared stock',
      align: 'end',
      render: (item) => sharedCell(item, settings.lowStockThreshold),
    },
    ...stores.map((store) => ({
      label: store.name,
      align: 'end',
      render: (item) => storeCell(item, store.id),
    })),
    { label: 'Issues', className: 'col-issues', render: issuesCell },
  ];
  return [
    dataTable({
      columns,
      rows: list.items,
      caption: 'Products and the stock each store shows',
      rowHref: (item) => `#/items/${item.id}`,
      className: 'items-table',
    }),
    pagination({
      page: list.page,
      pageSize: list.pageSize,
      total: list.total,
      onPage,
      noun: 'products',
    }),
  ];
}

function noResults(state) {
  if (state.search) {
    return emptyState({
      title: `No products match “${state.search}”`,
      message: 'Check the spelling, or search by SKU or barcode.',
      iconName: 'search',
    });
  }
  const messages = {
    issues: ['Nothing needs attention', 'Every product is syncing normally.', 'check'],
    uninitialized: ['Every product is syncing', 'There are no products waiting to start.', 'check'],
    low: ['No products are low on stock', null, 'check'],
    oversold: ['No products are oversold', null, 'check'],
    disabled: ['No paused products', 'Every product is syncing.', 'check'],
  };
  const custom = messages[state.filter];
  if (custom) return emptyState({ title: custom[0], message: custom[1], iconName: custom[2] });
  return emptyState({
    title: 'No products yet',
    message:
      'Products appear here once your stores are connected and their catalogs have been read.',
    iconName: 'box',
    action: linkButton('Go to stores', '#/stores', { variant: 'primary' }),
  });
}

function productCell(item) {
  return h(
    'div',
    { class: 'product-cell' },
    h('a', { href: `#/items/${item.id}`, class: 'product-link' }, item.title || item.sku),
    h(
      'div',
      { class: 'product-meta' },
      h('span', { class: 'mono' }, item.sku),
      !item.syncEnabled && badge('Paused', 'neutral', 'pause'),
    ),
  );
}

function sharedCell(item, defaultThreshold) {
  if (item.levels.length === 0) return muted('—');
  const threshold = item.lowStockThreshold ?? defaultThreshold;
  return item.levels.map((level) =>
    h(
      'div',
      { class: 'qty-line' },
      item.levels.length > 1 && h('span', { class: 'qty-warehouse' }, level.warehouseName),
      quantity(level.quantity, threshold),
    ),
  );
}

/** The shared number with its state spelled out (never by color alone). */
export function quantity(value, threshold) {
  if (value === null) return badge('Not started', 'neutral');
  if (value < 0) return badge(`${num(value)} oversold`, 'critical', 'error');
  if (value <= threshold) {
    return h('span', { class: 'qty qty-low' }, icon('alert'), num(value), srOnly(' (low)'));
  }
  return h('span', { class: 'qty' }, num(value));
}

function storeCell(item, storeId) {
  const entries = item.levels.flatMap((level) => {
    const s = level.stores.find((x) => x.storeId === storeId);
    return s ? [{ level, s }] : [];
  });
  if (entries.length === 0) return muted('—', 'Not sold in this store');
  return entries.map(({ level, s }) =>
    h(
      'div',
      { class: 'qty-line' },
      item.levels.length > 1 && h('span', { class: 'qty-warehouse' }, level.warehouseName),
      storeQuantity(s),
    ),
  );
}

/**
 * What a store shows for a product: the number it should show, flagged when the last number we
 * saw in the store differs (not updated yet, or an update failed) and while an update is pending.
 */
export function storeQuantity(s) {
  if (!s.tracked) return badge('Not tracked', 'warning', 'alert');
  if (s.shows === null) return muted('—', 'Not syncing in this store');
  // A store below zero that should show 0 is deliberately left alone by the sync.
  const mismatch =
    s.lastKnown !== null && s.lastKnown !== s.shows && !(s.shows === 0 && s.lastKnown < 0);
  const notes = [
    mismatch && h('span', {}, `store has ${num(s.lastKnown)}`),
    s.pendingWrite && h('span', { class: 'pending' }, icon('clock', { size: 12 }), 'updating'),
  ].filter(Boolean);
  return h(
    'span',
    {
      class: ['store-qty', mismatch && 'is-mismatch'],
      title: mismatch ? `Should show ${s.shows}; last seen showing ${s.lastKnown}` : null,
    },
    h('span', { class: 'qty' }, mismatch && icon('alert'), num(s.shows)),
    notes.length > 0 && h('span', { class: 'qty-notes' }, notes),
  );
}

function issuesCell(item) {
  if (item.issues.length === 0) return null;
  const extra = item.issues.length - ISSUES_SHOWN;
  return h(
    'div',
    { class: 'badges' },
    item.issues.slice(0, ISSUES_SHOWN).map((issue) => badge(issue, 'warning')),
    extra > 0 &&
      h(
        'span',
        { class: 'badge badge-neutral', title: item.issues.slice(ISSUES_SHOWN).join('\n') },
        `+${extra} more`,
      ),
  );
}
