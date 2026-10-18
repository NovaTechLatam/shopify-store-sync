import { api, latestOnly, qs } from '../api.js';
import { debounce, h, icon, uid } from '../dom.js';
import { plural } from '../format.js';
import {
  button,
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
import { importDialog, isBusy, stateBadge, statusBadge, thumb } from './catalog-shared.js';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ARCHIVED', label: 'Archived' },
];
const PAGE_SIZE = 50;
// While a brand is publishing, the list checks again this often.
const POLL_MS = 3000;

/** #/catalog: master products and their state in each brand. */
export async function render({ root, query, signal, setTitle }) {
  setTitle('Catalog');
  const state = {
    search: query.get('search') ?? '',
    status: FILTERS.some((f) => f.value === query.get('status')) ? query.get('status') : 'all',
    page: Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1),
  };
  let stores = null;
  const loadStores = async () => (stores ??= await api('/api/stores', { signal }));
  const openImport = async () => importDialog({ stores: await loadStores() });

  const searchInput = input({
    type: 'search',
    id: uid('search'),
    value: state.search,
    placeholder: 'Title or SKU',
    autocomplete: 'off',
  });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const results = h('div', { class: 'results' });
  root.append(
    pageHeader({
      title: 'Catalog',
      subtitle: 'Write a product once and publish it to every brand.',
      actions: [
        button('Import from a store…', { iconName: 'download', onClick: openImport }),
        linkButton('New product', '#/catalog/new', { variant: 'primary', iconName: 'plus' }),
      ],
    }),
    h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'search' },
        h('label', { class: 'sr-only', for: searchInput.id }, 'Search the catalog'),
        icon('search', { className: 'search-icon' }),
        searchInput,
      ),
      filterBar({
        label: 'Status',
        options: FILTERS,
        value: state.status,
        onChange: (value) => {
          state.status = value;
          state.page = 1;
          update();
        },
      }),
    ),
    announcer,
    results,
  );

  let timer = null;
  signal.addEventListener('abort', () => clearTimeout(timer));
  const update = latestOnly(signal, async (reqSignal) => {
    clearTimeout(timer);
    history.replaceState(
      null,
      '',
      `#/catalog${qs({
        search: state.search,
        status: state.status === 'all' ? '' : state.status,
        page: state.page > 1 ? state.page : '',
      })}`,
    );
    await loadInto(results, {
      signal: reqSignal,
      keepContent: true,
      load: () =>
        api(
          `/api/catalog/products${qs({
            search: state.search,
            status: state.status === 'all' ? '' : state.status,
            page: state.page,
            pageSize: PAGE_SIZE,
          })}`,
          { signal: reqSignal },
        ),
      render: (list) => {
        announcer.textContent = `${plural(list.total, 'product')} found`;
        // Keep the badges moving while something is being published.
        if (list.products.some((p) => p.stores.some(isBusy))) {
          timer = setTimeout(() => {
            if (!signal.aborted && !document.hidden) update();
          }, POLL_MS);
        }
        return renderList(list, state, openImport, (page) => {
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

function renderList(list, state, openImport, onPage) {
  if (list.total === 0) {
    if (state.search) {
      return emptyState({
        title: `No products match “${state.search}”`,
        message: 'Search by title or SKU.',
        iconName: 'search',
      });
    }
    if (state.status !== 'all') {
      return emptyState({ title: 'No products with this status', iconName: 'image' });
    }
    return emptyState({
      title: 'No products in the catalog yet',
      message:
        'Create a product once and publish it to every brand, or import one a store already sells.',
      iconName: 'image',
      action: h(
        'div',
        { class: 'row-actions' },
        linkButton('Create a product', '#/catalog/new', { variant: 'primary', iconName: 'plus' }),
        button('Import a product…', { iconName: 'download', onClick: openImport }),
      ),
    });
  }
  return [
    dataTable({
      caption: 'Catalog products and their state in each brand',
      className: 'catalog-table',
      rows: list.products,
      rowHref: (p) => `#/catalog/${p.id}`,
      columns: [
        { label: 'Product', className: 'col-product', render: productCell },
        { label: 'Status', render: (p) => statusBadge(p.status) },
        { label: 'Brands', className: 'col-brands', render: brandsCell },
      ],
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

function productCell(p) {
  const skus = p.skus.slice(0, 3).join(', ') + (p.skus.length > 3 ? ', …' : '');
  return h(
    'div',
    { class: 'catalog-product-cell' },
    thumb(p.image?.url),
    h(
      'div',
      { class: 'product-cell' },
      h('a', { href: `#/catalog/${p.id}`, class: 'product-link' }, p.title),
      h(
        'div',
        { class: 'product-meta' },
        h('span', {}, plural(p.variants, 'variant')),
        h('span', { class: 'mono' }, skus),
      ),
    ),
  );
}

function brandsCell(p) {
  const sold = p.stores.filter((s) => s.enabled);
  if (sold.length === 0) return muted('Not sold in any brand yet');
  return h(
    'ul',
    { class: 'brand-states' },
    sold.map((s) =>
      h(
        'li',
        { title: s.lastError ?? undefined },
        h('span', { class: 'brand-name' }, s.storeName),
        stateBadge(s),
      ),
    ),
  );
}
