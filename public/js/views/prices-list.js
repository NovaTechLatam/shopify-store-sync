import { api, latestOnly, qs } from '../api.js';
import { confirmDialog, formDialog } from '../dialog.js';
import { debounce, h, icon, replace, uid } from '../dom.js';
import { money, plural, timeAgo } from '../format.js';
import { roundPrice } from '../pricing-compute.js';
import { toast } from '../toast.js';
import {
  banner,
  button,
  dataTable,
  emptyState,
  field,
  filterBar,
  input,
  loadInto,
  muted,
  pagination,
  select,
  withBusy,
} from '../ui.js';
import {
  amountProps,
  marginText,
  noTargetText,
  readAmount,
  sourceBadge,
  targetText,
} from './prices-shared.js';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'changes', label: 'Will change' },
  { value: 'missing_base', label: 'No base price' },
  { value: 'overrides', label: 'Fixed prices' },
];
const PAGE_SIZE = 50;

/** The Prices tab: base prices, and what each store charges now and will charge. */
export async function render(container, { query, signal }) {
  const state = {
    search: query.get('search') ?? '',
    filter: FILTERS.some((f) => f.value === query.get('filter')) ? query.get('filter') : 'all',
    storeId: query.get('storeId') ?? '',
    page: Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1),
  };
  /** Base prices typed but not saved yet (itemId → { value, sku }); kept across pages. */
  const pending = new Map();
  /** Selected products (itemId → sku), for "Change prices…". */
  const selected = new Map();
  let last = null;

  const searchInput = input({
    type: 'search',
    id: uid('search'),
    value: state.search,
    placeholder: 'Search by SKU or name',
    autocomplete: 'off',
  });
  const storeSelect = select([{ value: '', label: 'All stores' }], { id: uid('store') });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const notes = h('div', { class: 'stack' });
  const results = h('div', { class: 'results' });
  const selection = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const changeButton = button('Change prices…', {
    iconName: 'edit',
    onClick: () => bulkDialog(scope(), last, () => update()),
  });
  const fromStore = button('Set base prices from a store…', {
    onClick: () => baseFromStoreDialog(last, () => update()),
  });

  const saveButton = button('Save base prices', { variant: 'primary' });
  const discardButton = button('Discard changes', { variant: 'plain' });
  const saveNote = h('span', { class: 'small', 'aria-live': 'polite' });
  const saveBar = h(
    'div',
    { class: 'form-actions save-bar price-save-bar', hidden: true },
    saveButton,
    discardButton,
    saveNote,
  );

  container.append(
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
      h(
        'div',
        { class: 'toolbar-select' },
        h('label', { class: 'sr-only', for: storeSelect.id }, 'Store'),
        storeSelect,
      ),
    ),
    notes,
    h(
      'div',
      { class: 'price-actions' },
      h('div', { class: 'row-actions' }, changeButton, fromStore),
      selection,
    ),
    announcer,
    results,
    saveBar,
  );

  const scope = () =>
    selected.size > 0
      ? { itemIds: [...selected.keys()], label: plural(selected.size, 'selected product') }
      : {
          // The list as shown: with a store chosen, its filters look at that store only.
          filter: {
            search: state.search || undefined,
            filter: state.filter,
            storeId: state.storeId ? Number(state.storeId) : undefined,
          },
          label:
            state.filter === 'all' && !state.search
              ? `all ${plural(last?.total ?? 0, 'product')}`
              : `the ${plural(last?.total ?? 0, 'product')} in this list`,
        };
  const refreshSelection = () => {
    selection.textContent = selected.size ? `${plural(selected.size, 'product')} selected` : '';
    changeButton.querySelector('span').textContent = selected.size
      ? `Change ${plural(selected.size, 'price')}…`
      : 'Change prices…';
  };

  const refreshSaveBar = () => {
    const dirty = pending.size > 0;
    const invalid = [...pending.values()].filter((p) => Number.isNaN(p.value) || p.value < 0);
    saveBar.hidden = !dirty;
    saveBar.classList.toggle('is-dirty', dirty);
    saveButton.disabled = invalid.length > 0;
    saveNote.className = invalid.length ? 'small text-critical' : 'small muted';
    saveNote.textContent = invalid.length
      ? `Enter a price of 0 or more for ${invalid.map((p) => p.sku).join(', ')}, or leave it empty.`
      : dirty
        ? `${plural(pending.size, 'base price')} not saved yet.`
        : '';
  };

  saveButton.addEventListener('click', () =>
    withBusy(saveButton, async () => {
      const failed = [];
      let saved = 0;
      for (const [itemId, p] of pending) {
        try {
          await api(`/api/prices/items/${itemId}`, {
            method: 'PATCH',
            body: { basePrice: p.value },
            toastErrors: false,
          });
          pending.delete(itemId);
          saved++;
        } catch (err) {
          failed.push(`${p.sku}: ${err.message}`);
        }
      }
      if (failed.length) toast(`Not saved. ${failed.join(' ')}`, { tone: 'error' });
      if (saved) {
        toast(
          `${plural(saved, 'base price')} saved. Stores get the new prices when you update prices in stores.`,
        );
      }
      refreshSaveBar();
      await update();
    }),
  );
  discardButton.addEventListener('click', () => {
    pending.clear();
    refreshSaveBar();
    update();
  });

  const update = latestOnly(signal, async (reqSignal) => {
    history.replaceState(
      null,
      '',
      `#/prices${qs({
        search: state.search,
        filter: state.filter === 'all' ? '' : state.filter,
        storeId: state.storeId,
        page: state.page > 1 ? state.page : '',
      })}`,
    );
    await loadInto(results, {
      signal: reqSignal,
      keepContent: true,
      load: () =>
        api(
          `/api/prices${qs({
            search: state.search,
            filter: state.filter,
            storeId: state.storeId,
            page: state.page,
            pageSize: PAGE_SIZE,
          })}`,
          { signal: reqSignal },
        ),
      render: (data) => {
        last = data;
        fillStores(storeSelect, data.stores, state.storeId);
        replace(notes, ...pageNotes(data));
        announcer.textContent = `${plural(data.total, 'product')} found`;
        refreshSelection();
        if (data.total === 0) return noResults(state);
        return [
          selectAll(data, selected, refreshSelection),
          priceTable(data, { pending, selected, refreshSaveBar, refreshSelection, reload: update }),
          pagination({
            page: data.page,
            pageSize: data.pageSize,
            total: data.total,
            noun: 'products',
            onPage: (page) => {
              state.page = page;
              update().then(() => results.scrollIntoView({ block: 'start' }));
            },
          }),
        ];
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
  storeSelect.addEventListener('change', () => {
    state.storeId = storeSelect.value;
    state.page = 1;
    update();
  });
  await update();
  // After an update of the stores: new prices, same filters and unsaved base prices.
  return { refresh: () => update() };
}

/** The store filter's options, once the stores are known. */
function fillStores(storeSelect, stores, current) {
  if (storeSelect.options.length > 1 || stores.length < 2) {
    storeSelect.closest('.toolbar-select').hidden = stores.length < 2 && !current;
    return;
  }
  for (const s of stores) storeSelect.append(h('option', { value: String(s.id) }, s.name));
  storeSelect.value = current;
}

function pageNotes(data) {
  const out = [];
  if (!data.stores.some((s) => s.ruleEnabled)) {
    out.push(
      banner(
        {
          tone: 'info',
          title: 'No store follows a price rule yet',
          actions: h(
            'a',
            { class: 'button button-small', href: '#/prices?tab=rules' },
            'Set up rules',
          ),
        },
        h(
          'p',
          {},
          'Until a store’s rule is on, Store Sync leaves its prices alone (except fixed prices you set here).',
        ),
      ),
    );
  }
  const denied = data.stores.filter((s) => !s.canUpdate);
  if (denied.length) {
    out.push(
      banner(
        { tone: 'warning', title: 'Some stores don’t let Store Sync change prices' },
        h(
          'p',
          {},
          `${denied.map((s) => s.name).join(', ')} ${denied.length === 1 ? 'needs' : 'need'} the “write_products” permission. `,
          h('a', { href: `#/stores/${denied[0].id}` }, 'See the store’s permissions'),
          '.',
        ),
      ),
    );
  }
  out.push(
    h(
      'p',
      { class: 'muted small' },
      'Store prices are as we last read them. ',
      data.lastRun
        ? ['Prices were last sent to your stores ', timeAgo(data.lastRun.createdAt), '. ']
        : 'Prices haven’t been sent to your stores from here yet. ',
      h('a', { href: '#/prices?tab=history' }, 'History'),
    ),
  );
  return out;
}

function noResults(state) {
  if (state.search) {
    return emptyState({
      title: `No products match “${state.search}”`,
      message: 'Try another SKU or name.',
      iconName: 'search',
    });
  }
  switch (state.filter) {
    case 'changes':
      return emptyState({
        title: 'Every store already has its price',
        message: 'From the prices we last read, updating now would change nothing.',
        iconName: 'check',
      });
    case 'missing_base':
      return emptyState({
        title: 'Every product has a base price',
        message: 'Stores with a price rule get a price for each of them.',
        iconName: 'check',
      });
    case 'overrides':
      return emptyState({
        title: 'No fixed prices',
        message:
          'To give a product its own price in one store, use the edit button in that store’s column.',
        iconName: 'tag',
      });
    default:
      return emptyState({
        title: 'No products yet',
        message: 'Products appear here once your stores are connected and their products matched.',
        action: h('a', { class: 'button', href: '#/stores' }, 'Go to stores'),
        iconName: 'tag',
      });
  }
}

function selectAll(data, selected, refreshSelection) {
  const id = uid('select-all');
  const all = data.items.every((i) => selected.has(i.itemId));
  const checkbox = h('input', { type: 'checkbox', id, checked: all && data.items.length > 0 });
  checkbox.addEventListener('change', () => {
    for (const item of data.items) {
      if (checkbox.checked) selected.set(item.itemId, item.sku);
      else selected.delete(item.itemId);
    }
    for (const box of document.querySelectorAll('input[data-select-item]')) {
      box.checked = checkbox.checked;
    }
    refreshSelection();
  });
  return h(
    'label',
    { class: 'checkbox select-all', for: id },
    checkbox,
    h('span', {}, 'Select every product on this page'),
  );
}

function priceTable(data, ctx) {
  const base = data.baseCurrency;
  return dataTable({
    caption: 'Base prices and each store’s prices',
    className: 'price-table',
    columns: [
      { label: 'Product', className: 'col-product', render: (item) => productCell(item, ctx) },
      {
        label: `Base price (${base})`,
        className: 'col-base',
        render: (item) => baseCell(item, base, ctx),
      },
      ...data.stores.map((store, i) => ({
        label: store.name,
        className: 'col-store',
        align: 'end',
        render: (item) => storeCell(item, item.stores[i], store, ctx),
      })),
    ],
    rows: data.items,
  });
}

function productCell(item, ctx) {
  const box = h('input', {
    type: 'checkbox',
    class: 'row-check',
    checked: ctx.selected.has(item.itemId),
    'aria-label': `Select ${item.sku}`,
    dataset: { selectItem: String(item.itemId) },
  });
  box.addEventListener('change', () => {
    if (box.checked) ctx.selected.set(item.itemId, item.sku);
    else ctx.selected.delete(item.itemId);
    ctx.refreshSelection();
  });
  return h(
    'div',
    { class: 'price-product' },
    box,
    h(
      'div',
      { class: 'product-cell' },
      h('a', { class: 'product-link', href: `#/items/${item.itemId}` }, item.title || item.sku),
      h('span', { class: 'product-meta' }, h('span', { class: 'mono' }, item.sku)),
    ),
  );
}

function baseCell(item, base, ctx) {
  const pending = ctx.pending.get(item.itemId);
  const field = h('input', {
    ...amountProps(base),
    class: 'input price-input',
    'aria-label': `Base price of ${item.sku}`,
    value: pending
      ? Number.isNaN(pending.value)
        ? ''
        : (pending.value ?? '')
      : (item.basePrice ?? ''),
  });
  field.addEventListener('input', () => {
    const value = readAmount(field);
    if (value === item.basePrice) ctx.pending.delete(item.itemId);
    else ctx.pending.set(item.itemId, { value, sku: item.sku });
    field.setAttribute('aria-invalid', String(Number.isNaN(value) || value < 0));
    ctx.refreshSaveBar();
  });
  const edit = button('Edit…', {
    size: 'small',
    variant: 'plain',
    attrs: { 'aria-label': `Edit the prices and cost of ${item.sku}` },
    onClick: () => itemDialog(item, base, ctx),
  });
  return h(
    'div',
    { class: 'price-base' },
    field,
    h(
      'div',
      { class: 'price-notes' },
      item.baseCompareAtPrice !== null &&
        h('span', {}, 'Compare at ', money(item.baseCompareAtPrice, base)),
      h('span', {}, item.cost === null ? muted('No cost') : ['Cost ', money(item.cost, base)]),
      edit,
    ),
  );
}

function storeCell(item, cell, store, ctx) {
  if (!cell) return '';
  const currency = store.currencyCode;
  const fixed = h(
    'button',
    {
      type: 'button',
      class: 'icon-button price-fixed',
      'aria-label': `Fixed price for ${item.sku} in ${store.name}…`,
      title: 'Fixed price…',
      onclick: () => fixedPriceDialog(item, cell, store, ctx.reload),
    },
    icon('edit'),
  );
  if (!cell.sold && !cell.override) {
    return h('div', { class: 'price-cell' }, muted('Not sold here'));
  }
  let main;
  if (cell.differs) {
    const diff = cell.target.price - cell.current.price;
    const big = cell.current.price > 0 && diff / cell.current.price <= -0.2;
    main = h(
      'span',
      { class: 'price-change' },
      h('span', { class: 'price-old' }, money(cell.current.price, currency)),
      h('span', { 'aria-hidden': 'true' }, ' → '),
      h('span', { class: 'sr-only' }, ' will become '),
      targetText(cell, currency),
      h(
        'span',
        { class: ['badge', big ? 'badge-warning' : 'badge-neutral', 'price-delta'] },
        money(diff, currency, { signDisplay: 'exceptZero' }),
      ),
    );
  } else if (cell.target.status === 'ok') {
    main = targetText(cell, currency);
  } else {
    main = cell.current ? money(cell.current.price, currency) : muted('Not read yet');
  }
  return h(
    'div',
    { class: 'price-cell' },
    h('div', { class: 'price-main' }, main),
    h(
      'div',
      { class: 'price-notes' },
      sourceBadge(cell),
      noTargetText(cell),
      cell.target.status === 'ok' && !cell.current && cell.sold && muted('Not read yet'),
      marginText(cell.margin),
      fixed,
    ),
  );
}

/** Base price, compare-at price and cost of one product. */
async function itemDialog(item, base, ctx) {
  const price = input({ ...amountProps(base), value: item.basePrice ?? '' });
  const compareAt = input({ ...amountProps(base), value: item.baseCompareAtPrice ?? '' });
  const cost = input({ ...amountProps(base), value: item.cost ?? '' });
  const saved = await formDialog({
    title: `Prices of ${item.sku}`,
    intro: h('p', {}, item.title),
    content: [
      field({
        label: `Base price (${base})`,
        control: price,
        optional: true,
        hint: 'Each store’s price is worked out from this with its rule.',
      }),
      field({
        label: `Compare-at price (${base})`,
        control: compareAt,
        optional: true,
        hint: 'Shown crossed out next to the price. Must be higher than the price.',
      }),
      field({
        label: `Cost (${base})`,
        control: cost,
        optional: true,
        hint: 'What one unit costs you. Used for margins.',
      }),
    ],
    onSubmit: async () => {
      const values = {
        basePrice: readAmount(price),
        baseCompareAtPrice: readAmount(compareAt),
        cost: readAmount(cost),
      };
      for (const v of Object.values(values)) {
        if (Number.isNaN(v) || v < 0)
          throw new Error('Enter amounts of 0 or more, or leave them empty.');
      }
      if (values.baseCompareAtPrice !== null && values.basePrice === null) {
        throw new Error(
          'A compare-at price needs a base price. Clear the compare-at price too, or enter a base price.',
        );
      }
      if (values.baseCompareAtPrice !== null && values.baseCompareAtPrice <= values.basePrice) {
        throw new Error(
          'The compare-at price must be higher than the base price. Leave it empty for none.',
        );
      }
      const body = {};
      if (values.basePrice !== item.basePrice) body.basePrice = values.basePrice;
      if (values.baseCompareAtPrice !== item.baseCompareAtPrice)
        body.baseCompareAtPrice = values.baseCompareAtPrice;
      if (values.cost !== item.cost) body.cost = values.cost;
      if (Object.keys(body).length === 0) return 'unchanged';
      await api(`/api/prices/items/${item.itemId}`, { method: 'PATCH', body, toastErrors: false });
      return 'saved';
    },
  });
  if (saved === 'saved') {
    ctx.pending.delete(item.itemId);
    ctx.refreshSaveBar();
    toast(`Prices of ${item.sku} saved. Stores get them when you update prices in stores.`);
    ctx.reload();
  }
}

/** A price for one product in one store, whatever the store's rule says. */
export async function fixedPriceDialog(item, cell, store, onSaved) {
  const currency = store.currencyCode;
  const o = cell.override;
  const price = input({ ...amountProps(currency), required: true, value: o?.price ?? '' });
  const compareAt = input({ ...amountProps(currency), value: o?.compareAtPrice ?? '' });
  const note = input({
    maxlength: 500,
    value: o?.scheduleId ? '' : (o?.note ?? ''),
    placeholder: 'e.g. Price match with a local shop',
  });
  let removed = false;
  const remove =
    o &&
    button(o.scheduleId ? 'Take out of the sale…' : 'Remove fixed price…', {
      variant: 'plain-critical',
      size: 'small',
      onClick: (event) => {
        removed = true;
        event.target.closest('dialog').close();
      },
    });
  const rulePrice =
    cell.target.status === 'ok' && cell.target.source === 'rule'
      ? money(cell.target.price, currency)
      : null;
  const saved = await formDialog({
    title: `Fixed price for ${item.sku} in ${store.name}`,
    intro: h(
      'div',
      {},
      h(
        'p',
        {},
        `${store.name} charges this price whatever its rule says, until you remove it. Your stores get it when you update prices.`,
      ),
      o?.scheduleId &&
        banner(
          { tone: 'info', title: `On sale: “${o.scheduleName}”` },
          h(
            'p',
            {},
            'A price you save here replaces the sale price, and stays when the sale ends.',
          ),
        ),
      rulePrice && h('p', { class: 'muted small' }, `The rule gives ${rulePrice}.`),
    ),
    content: [
      field({ label: `Price (${currency})`, control: price }),
      field({
        label: `Compare-at price (${currency})`,
        control: compareAt,
        optional: true,
        hint: 'Shown crossed out. Must be higher than the price.',
      }),
      field({
        label: 'Note',
        control: note,
        optional: true,
        hint: 'Why this product has its own price here.',
      }),
      remove && h('div', {}, remove),
    ],
    onSubmit: async () => {
      const p = readAmount(price);
      const c = readAmount(compareAt);
      if (p === null || Number.isNaN(p) || p < 0) throw new Error('Enter a price of 0 or more.');
      if (Number.isNaN(c) || (c !== null && c <= p)) {
        throw new Error(
          'The compare-at price must be higher than the price. Leave it empty for none.',
        );
      }
      await api(`/api/prices/overrides/${store.id}/${item.itemId}`, {
        method: 'PUT',
        body: { price: p, compareAtPrice: c, note: note.value.trim() || null },
        toastErrors: false,
      });
    },
  });
  if (saved) {
    toast(
      `Fixed price saved for ${item.sku} in ${store.name}. It reaches the store when you update prices.`,
    );
    onSaved();
    return;
  }
  if (!removed) return;
  const sale = ' The sale doesn’t put its price back when it ends.';
  const done = await formDialog({
    title: o.scheduleId
      ? `Take ${item.sku} out of the sale?`
      : `Remove the fixed price of ${item.sku}?`,
    intro: h('p', {}, afterRemoval(item, cell, store), o.scheduleId ? sale : ''),
    submitLabel: o.scheduleId ? 'Take out of the sale' : 'Remove fixed price',
    tone: 'critical',
    onSubmit: () =>
      api(`/api/prices/overrides/${store.id}/${item.itemId}`, {
        method: 'DELETE',
        toastErrors: false,
      }),
  });
  if (done) {
    toast(`Fixed price removed for ${item.sku} in ${store.name}.`);
    onSaved();
  }
}

/**
 * What the store charges once a fixed price is removed. Without a rule (or a base price for it)
 * Store Sync has no price of its own there: the store keeps what it has in Shopify, sale price
 * included.
 */
function afterRemoval(item, cell, store) {
  const now = cell.current ? ` (${money(cell.current.price, store.currencyCode)})` : '';
  if (!store.ruleEnabled) {
    return `Store Sync stops setting this product’s price in ${store.name}: it keeps the price it has in Shopify${now} until you change it there.`;
  }
  if (item.basePrice === null) {
    return `${store.name} keeps the price it has in Shopify${now}: ${item.sku} has no base price for its rule to use.`;
  }
  return `${store.name} goes back to the price its rule gives the next time you update prices.`;
}

const FIELD_LABELS = {
  basePrice: 'Base price',
  baseCompareAtPrice: 'Compare-at price',
  cost: 'Cost',
};

/** "Change prices…": one change applied to many products' base prices, compare-at or costs. */
async function bulkDialog(target, data, onDone) {
  if (!data) return;
  const base = data.baseCurrency;
  const fieldSelect = select(
    Object.entries(FIELD_LABELS).map(([value, label]) => ({ value, label })),
    { value: 'basePrice' },
  );
  const opName = uid('op');
  const ops = [
    ['percent', 'Change by a percentage'],
    ['add', 'Add or subtract an amount'],
    ['set', 'Set to an amount'],
    ['round', 'Round them'],
  ];
  const opGroup = h(
    'fieldset',
    { class: 'radio-group' },
    h('legend', { class: 'field-label' }, 'How'),
    ops.map(([value, label], i) =>
      h(
        'label',
        { class: 'radio' },
        h('input', { type: 'radio', name: opName, value, checked: i === 0 }),
        h('span', {}, label),
      ),
    ),
  );
  const value = input({
    type: 'number',
    step: 'any',
    inputmode: 'decimal',
    class: 'input input-short',
  });
  const valueField = field({ label: 'Percentage', control: value, hint: ' ' });
  const roundBox = h('input', { type: 'checkbox', class: 'checkbox-input' });
  const roundToggle = h(
    'label',
    { class: 'checkbox' },
    roundBox,
    h('span', {}, 'Round the results'),
  );
  const mode = select(
    [
      { value: 'ending', label: 'Prices end in' },
      { value: 'multiple', label: 'A multiple of' },
    ],
    { value: 'ending' },
  );
  const step = input({
    type: 'number',
    min: 0.0001,
    step: 'any',
    value: '1',
    inputmode: 'decimal',
    class: 'input input-short',
  });
  const ending = input({
    type: 'number',
    min: 0,
    step: 'any',
    value: '0.99',
    inputmode: 'decimal',
    class: 'input input-short',
  });
  const direction = select(
    [
      { value: 'up', label: 'Round up' },
      { value: 'nearest', label: 'To the nearest' },
      { value: 'down', label: 'Round down' },
    ],
    { value: 'up' },
  );
  const endingField = field({
    label: 'Ending',
    control: ending,
    hint: '0.99 turns 12.34 into 12.99.',
  });
  const roundFields = h(
    'div',
    { class: 'rounding-fields' },
    field({ label: 'Round to', control: mode }),
    field({ label: 'Step', control: step, hint: '1 for whole units, 0.05 for five cents.' }),
    endingField,
    field({ label: 'Direction', control: direction }),
  );
  const example = h('p', { class: 'preview-line', 'aria-live': 'polite' });

  const read = () => {
    const op = opGroup.querySelector('input:checked').value;
    return {
      op,
      field: fieldSelect.value,
      value: op === 'round' ? null : readAmount(value),
      rounding:
        op === 'round' || roundBox.checked
          ? {
              mode: mode.value,
              step: Number(step.value),
              ending: mode.value === 'ending' ? Number(ending.value) : 0,
              direction: direction.value,
            }
          : null,
    };
  };
  const sample = data.items.find((i) => i.basePrice !== null) ?? data.items[0];
  const refresh = () => {
    const c = read();
    valueField.hidden = c.op === 'round';
    roundToggle.hidden = c.op === 'round';
    roundFields.hidden = !c.rounding;
    endingField.hidden = mode.value !== 'ending';
    valueField.querySelector('label').textContent =
      c.op === 'percent'
        ? 'Percentage'
        : c.op === 'add'
          ? `Amount (${base})`
          : `New amount (${base})`;
    valueField.querySelector('.field-hint').textContent =
      c.op === 'percent'
        ? 'Use a minus sign to lower: -10 is 10% less.'
        : c.op === 'add'
          ? 'Use a minus sign to subtract.'
          : 'Leave it empty to remove the value.';
    const old = sample?.[c.field] ?? null;
    const next = bulkPreview(old, c, base);
    example.textContent =
      next === undefined
        ? ''
        : `Example: ${sample.sku} ${old === null ? 'none' : money(old, base)} → ${next === null ? 'none' : money(next, base)}`;
  };
  for (const el of [fieldSelect, mode, direction, roundBox, step, ending, value]) {
    el.addEventListener('input', refresh);
    el.addEventListener('change', refresh);
  }
  for (const radio of opGroup.querySelectorAll('input')) radio.addEventListener('change', refresh);
  refresh();

  const done = await formDialog({
    title: 'Change prices',
    intro: h(
      'p',
      {},
      `Applies to ${target.label}. A relative change skips products that have no value yet.`,
    ),
    content: [
      field({ label: 'Change', control: fieldSelect }),
      opGroup,
      valueField,
      roundToggle,
      roundFields,
      example,
    ],
    submitLabel: 'Apply change',
    initialFocus: () => value,
    onSubmit: async () => {
      const c = read();
      if (c.op === 'percent' && (c.value === null || Number.isNaN(c.value) || c.value <= -100)) {
        throw new Error('Enter a percentage, like 10 for 10% more or -10 for 10% less.');
      }
      if (c.op === 'add' && (c.value === null || Number.isNaN(c.value))) {
        throw new Error('Enter the amount to add, or a negative amount to subtract.');
      }
      if (c.op === 'set' && (Number.isNaN(c.value) || c.value < 0)) {
        throw new Error('Enter an amount of 0 or more, or leave it empty.');
      }
      if (c.rounding) {
        if (!(c.rounding.step > 0)) throw new Error('Enter a step above 0 for the rounding.');
        if (
          c.rounding.mode === 'ending' &&
          !(c.rounding.ending >= 0 && c.rounding.ending < c.rounding.step)
        ) {
          throw new Error(
            'The ending must be smaller than the step (for prices ending in .99 with a step of 1, use 0.99).',
          );
        }
      }
      const body = {
        ...(target.itemIds ? { itemIds: target.itemIds } : { filter: target.filter }),
        ...c,
      };
      // Counted first: removing values, or losing compare-at prices, is confirmed with the count.
      const preview = await api('/api/prices/items/bulk', {
        method: 'POST',
        body: { ...body, dryRun: true },
        toastErrors: false,
      });
      if (
        (preview.cleared > 0 || preview.compareAtLost > 0) &&
        !(await confirmBulk(preview, c.field))
      ) {
        throw new Error('Nothing was changed.');
      }
      const result = await api('/api/prices/items/bulk', {
        method: 'POST',
        body,
        toastErrors: false,
      });
      return { ...result, field: c.field };
    },
  });
  if (!done) return;
  const what = FIELD_LABELS[done.field].toLowerCase();
  const skipped = done.skipped
    ? ` ${plural(done.skipped, 'product')} without one ${done.skipped === 1 ? 'was' : 'were'} skipped.`
    : '';
  toast(
    done.updated === 0
      ? `Nothing changed: the ${what}s were already like that.${skipped}`
      : `${plural(done.updated, what)} changed.${skipped}${done.field === 'cost' ? '' : ' Stores get the new prices when you update prices in stores.'}`,
  );
  onDone();
}

/**
 * Asks before a bulk change that removes values (an empty "Set to an amount") or leaves
 * compare-at prices at or below the base price (stores drop those at the next update).
 */
function confirmBulk(preview, field) {
  const what = FIELD_LABELS[field].toLowerCase();
  const removed = {
    basePrice: `${plural(preview.cleared, 'product')} will have no base price. Stores keep what they charge now: their price rules can’t update them until you set one again.`,
    baseCompareAtPrice: `${plural(preview.cleared, 'product')} will have no compare-at price. Stores stop showing one at the next update.`,
    cost: `${plural(preview.cleared, 'product')} will have no cost, so reports show no margin for them.`,
  }[field];
  return confirmDialog({
    title:
      preview.cleared > 0
        ? `Remove the ${what} of ${plural(preview.cleared, 'product')}?`
        : `Change ${plural(preview.updated, what)}?`,
    message: [
      preview.cleared > 0 && h('p', {}, `The amount is empty, so ${removed}`),
      preview.compareAtLost > 0 &&
        h(
          'p',
          {},
          `${plural(preview.compareAtLost, 'product')} will have a compare-at price no higher than the base price. Those compare-at prices disappear from the stores at the next update.`,
        ),
    ].filter(Boolean),
    confirmLabel: preview.cleared > 0 ? `Remove ${plural(preview.cleared, what)}` : 'Apply change',
    tone: preview.cleared > 0 ? 'critical' : 'primary',
  });
}

/** What a bulk change makes of one value, for the example line (as the server does it). */
function bulkPreview(old, c, base) {
  if (c.op !== 'set' && old === null) return undefined;
  if (c.op !== 'round' && c.op !== 'set' && (c.value === null || Number.isNaN(c.value))) {
    return undefined;
  }
  if (c.op === 'set' && Number.isNaN(c.value)) return undefined;
  let next = old;
  if (c.op === 'set') next = c.value;
  if (c.op === 'percent') next = old * (1 + c.value / 100);
  if (c.op === 'add') next = old + c.value;
  if (next === null || next < 0) return next;
  const r = c.rounding;
  if (r && !(r.step > 0 && (r.mode !== 'ending' || r.ending < r.step))) return undefined;
  return roundPrice(
    next,
    r
      ? { roundMode: r.mode, roundStep: r.step, roundEnding: r.ending, roundDirection: r.direction }
      : PLAIN_ROUNDING,
    base,
  );
}

const PLAIN_ROUNDING = {
  roundMode: 'none',
  roundStep: 1,
  roundEnding: 0,
  roundDirection: 'nearest',
};

/** Base prices from what a store charges, converted with its exchange rate. */
async function baseFromStoreDialog(data, onDone) {
  if (!data) return;
  const base = data.baseCurrency;
  // A store whose rate was never set can't be converted back to base prices.
  const stores = data.stores.filter((s) => s.currencyKnown && !s.exchangeRateUnset);
  const storeSelect = select(
    stores.map((s) => ({ value: s.id, label: `${s.name} (${s.currencyCode})` })),
    { value: stores[0]?.id },
  );
  const onlyMissing = h('input', { type: 'checkbox', class: 'checkbox-input', checked: true });
  const rate = h('p', { class: 'preview-line', 'aria-live': 'polite' });
  const showRate = () => {
    const s = stores.find((x) => String(x.id) === storeSelect.value);
    rate.textContent =
      !s || s.currencyCode === base
        ? 'Prices are copied as they are.'
        : `Prices are divided by the exchange rate: 1 ${base} = ${s.exchangeRate.toLocaleString('en-US')} ${s.currencyCode}.`;
  };
  storeSelect.addEventListener('change', showRate);
  showRate();
  const done = await formDialog({
    title: 'Set base prices from a store',
    intro: h(
      'p',
      {},
      'Copies what a store charges now into the base prices (and compare-at prices). Choose the store whose prices your others follow, the one whose rule is ×1.',
    ),
    content: [
      field({ label: 'Store', control: storeSelect }),
      rate,
      h(
        'label',
        { class: 'checkbox' },
        onlyMissing,
        h(
          'span',
          {},
          'Only products without a base price',
          h(
            'span',
            { class: 'field-hint block' },
            'Leave this on to keep the base prices you already set.',
          ),
        ),
      ),
    ],
    submitLabel: 'Set base prices',
    onSubmit: () =>
      api('/api/prices/base-from-store', {
        method: 'POST',
        body: { storeId: Number(storeSelect.value), onlyMissing: onlyMissing.checked },
        toastErrors: false,
      }),
  });
  if (!done) return;
  toast(
    done.updated === 0
      ? 'No base prices were set: the store’s products already have one, or we haven’t read its prices yet.'
      : `Base prices set for ${plural(done.updated, 'product')}.`,
  );
  onDone();
}
