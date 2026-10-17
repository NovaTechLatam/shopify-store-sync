import { api, isAbort, latestOnly, qs } from '../api.js';
import { confirmDialog, formDialog } from '../dialog.js';
import { debounce, h, icon, replace, uid } from '../dom.js';
import { num, plural } from '../format.js';
import { toast } from '../toast.js';
import {
  badge,
  banner,
  button,
  dataTable,
  emptyState,
  field,
  filterBar,
  input,
  loadInto,
  muted,
  pageHeader,
  pagination,
  select,
  setChipCount,
} from '../ui.js';

const TABS = [
  { value: 'unmatched', label: 'Unmatched', count: null },
  { value: 'conflicts', label: 'Duplicate SKUs', count: null },
  { value: 'ignored', label: 'Ignored', count: null },
];
const PAGE_SIZE = 50;

export async function render({ root, query, signal, setTitle }) {
  setTitle('Matching');
  const state = {
    tab: TABS.some((t) => t.value === query.get('tab')) ? query.get('tab') : 'unmatched',
    search: query.get('search') ?? '',
    storeId: query.get('storeId') ?? '',
    page: 1,
  };

  const tabs = filterBar({
    label: 'Variants to show',
    options: TABS,
    value: state.tab,
    onChange: (value) => {
      state.tab = value;
      state.page = 1;
      update();
    },
  });
  const searchInput = input({
    type: 'search',
    id: uid('search'),
    value: state.search,
    placeholder: 'Search SKU, product or barcode',
    autocomplete: 'off',
  });
  const storeSelect = select([{ value: '', label: 'All stores' }], { id: uid('store') });
  const help = h('div', { class: 'tab-help' });
  const results = h('div', { class: 'results' });
  root.append(
    pageHeader({
      title: 'Matching',
      subtitle:
        'Products are matched across stores by SKU. Here are the variants that couldn’t be matched.',
    }),
    tabs,
    h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'search' },
        h('label', { class: 'sr-only', for: searchInput.id }, 'Search variants'),
        icon('search', { className: 'search-icon' }),
        searchInput,
      ),
      h(
        'div',
        { class: 'toolbar-select' },
        h('label', { class: 'sr-only', for: storeSelect.id }, 'Store'),
        storeSelect,
      ),
    ),
    help,
    results,
  );

  api('/api/stores', { signal })
    .then((stores) => {
      for (const s of stores) storeSelect.append(h('option', { value: String(s.id) }, s.name));
      storeSelect.value = state.storeId;
    })
    .catch(() => {
      // The store filter is optional; the list itself reports connection problems.
    });

  const update = latestOnly(signal, async (reqSignal) => {
    history.replaceState(
      null,
      '',
      `#/mapping${qs({
        tab: state.tab === 'unmatched' ? '' : state.tab,
        search: state.search,
        storeId: state.storeId,
      })}`,
    );
    replace(help, tabHelp(state.tab));
    const filters = { search: state.search, storeId: state.storeId };
    // The other tabs only need their totals.
    const counts = TABS.filter((t) => t.value !== state.tab).map((t) =>
      api(`/api/variants${qs({ ...filters, filter: t.value, pageSize: 1 })}`, { signal: reqSignal })
        .then((r) => setChipCount(tabs, t.value, r.total))
        .catch(() => {}),
    );
    await loadInto(results, {
      signal: reqSignal,
      keepContent: true,
      load: () =>
        api(
          `/api/variants${qs({ ...filters, filter: state.tab, page: state.page, pageSize: PAGE_SIZE })}`,
          { signal: reqSignal },
        ),
      render: (data) => {
        setChipCount(tabs, state.tab, data.total);
        return renderTab(state, data, update, (page) => {
          state.page = page;
          update().then(() => results.scrollIntoView({ block: 'start' }));
        });
      },
    });
    await Promise.all(counts);
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
}

function tabHelp(tab) {
  if (tab === 'unmatched') {
    return banner(
      { tone: 'info', title: 'Sold in only one store' },
      h(
        'p',
        {},
        'No other store has a variant with the same SKU, so there is nothing to share stock with. This is usually a small difference in the SKU. The best fix is to correct the SKU in Shopify (we pick up the change automatically). You can also link a variant to the right product here.',
      ),
    );
  }
  if (tab === 'conflicts') {
    return banner(
      { tone: 'warning', title: 'The same SKU is used more than once in a store' },
      h(
        'p',
        {},
        'We can’t tell which variant to sync, so these are skipped. To fix it, open each product in Shopify and give every variant its own SKU (Products → choose the product → the variant → SKU). If one of them is the right one, you can also choose “Sync this one”.',
      ),
    );
  }
  return banner(
    { tone: 'info', title: 'Never synced' },
    h(
      'p',
      {},
      'Bundles (their stock comes from the products inside them), variants without a SKU, and variants you chose not to sync.',
    ),
  );
}

function renderTab(state, data, refresh, onPage) {
  if (data.total === 0) {
    const titles = {
      unmatched: 'Every variant is matched',
      conflicts: 'No duplicate SKUs',
      ignored: 'Nothing is ignored',
    };
    return emptyState({
      title: state.search ? `Nothing matches “${state.search}”` : titles[state.tab],
      iconName: state.search ? 'search' : 'check',
    });
  }
  const table =
    state.tab === 'conflicts'
      ? conflictGroups(data.variants, refresh)
      : dataTable({
          caption: 'Variants',
          columns: [
            { label: 'Variant', className: 'col-product', render: variantCell },
            { label: 'Store', render: (v) => v.storeName },
            {
              label: 'SKU',
              render: (v) => (v.sku ? h('span', { class: 'mono' }, v.sku) : muted('No SKU')),
            },
            state.tab === 'ignored'
              ? { label: 'Why', render: ignoredReason }
              : { label: 'Status', render: unmatchedStatus },
            {
              label: 'Actions',
              className: 'col-actions',
              render: (v) => variantActions(state.tab, v, refresh),
            },
          ],
          rows: data.variants,
        });
  return [
    table,
    pagination({
      page: state.page,
      pageSize: PAGE_SIZE,
      total: data.total,
      onPage,
      noun: 'variants',
    }),
  ];
}

const variantName = (v) =>
  v.variantTitle && v.variantTitle !== 'Default Title'
    ? `${v.productTitle} · ${v.variantTitle}`
    : v.productTitle || 'Untitled product';

function variantCell(v) {
  return h(
    'div',
    { class: 'product-cell' },
    h('span', { class: 'strong' }, variantName(v)),
    v.barcode && h('span', { class: 'muted small' }, `Barcode ${v.barcode}`),
  );
}

function unmatchedStatus(v) {
  if (v.linkSource === 'manual') return badge('Linked by you', 'info', 'link');
  if (!v.tracked) return badge('Not tracked', 'warning', 'alert');
  return badge('Only in this store', 'neutral');
}

function ignoredReason(v) {
  if (v.isBundle) return 'Bundle';
  if (!v.sku) return 'No SKU in Shopify';
  return 'You chose not to sync it';
}

function variantActions(tab, v, refresh) {
  const actions = [];
  if (tab === 'unmatched') {
    actions.push(
      button('Link to product…', { size: 'small', onClick: () => linkPicker(v, refresh) }),
    );
    if (v.itemId === null) {
      actions.push(
        button('Create product', { size: 'small', onClick: () => createFromSku(v, refresh) }),
      );
    }
    if (v.linkSource === 'manual') {
      actions.push(
        button('Use automatic matching', {
          size: 'small',
          variant: 'plain',
          onClick: () => resetToAuto(v, refresh),
        }),
      );
    } else {
      actions.push(
        button('Don’t sync', {
          size: 'small',
          variant: 'plain',
          onClick: () => neverSync(v, refresh),
        }),
      );
    }
  } else if (tab === 'ignored' && v.linkSource === 'manual' && v.sku && !v.isBundle) {
    actions.push(
      button('Match automatically', { size: 'small', onClick: () => resetToAuto(v, refresh) }),
    );
  }
  return actions.length ? h('div', { class: 'row-actions' }, actions) : muted('—');
}

function conflictGroups(variants, refresh) {
  const groups = new Map();
  for (const v of variants) {
    const key = `${v.storeId}|${v.sku}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  return h(
    'div',
    { class: 'stack' },
    [...groups.values()].map((group) =>
      h(
        'section',
        { class: 'card conflict-group' },
        h(
          'h2',
          { class: 'card-title' },
          h('span', { class: 'mono' }, group[0].sku),
          ` in ${group[0].storeName}`,
        ),
        h('p', { class: 'muted small' }, `Used by ${plural(group.length, 'variant')}:`),
        h(
          'ul',
          { class: 'compact-list' },
          group.map((v) =>
            h(
              'li',
              { class: 'variant-row' },
              variantCell(v),
              button('Sync this one', { size: 'small', onClick: () => syncThisOne(v, refresh) }),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Lets the merchant pick the product a variant really is (by SKU or name). */
async function linkPicker(variant, refresh) {
  const searchInput = input({
    type: 'search',
    placeholder: 'SKU or product name',
    autocomplete: 'off',
  });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const results = h('div', { class: 'picker-results' });
  const radioName = uid('item');
  let controller = null;

  const search = async () => {
    controller?.abort();
    controller = new AbortController();
    results.setAttribute('aria-busy', 'true');
    try {
      const data = await api(
        `/api/items${qs({ search: searchInput.value.trim(), pageSize: 20 })}`,
        {
          signal: controller.signal,
        },
      );
      // Products this store can still be linked to come first.
      const options = data.items
        .filter((item) => item.id !== variant.itemId)
        .sort((a, b) => takenIn(a, variant.storeId) - takenIn(b, variant.storeId));
      announcer.textContent = `${plural(options.length, 'product')} found`;
      replace(
        results,
        options.length === 0
          ? muted('No products found. Try another SKU or name.')
          : h(
              'fieldset',
              { class: 'picker' },
              h('legend', { class: 'sr-only' }, 'Products'),
              options.map((item) => pickerOption(item, variant, radioName)),
            ),
      );
    } catch (err) {
      if (!isAbort(err)) replace(results, h('p', { class: 'field-error' }, err.message));
    } finally {
      results.removeAttribute('aria-busy');
    }
  };
  searchInput.addEventListener('input', debounce(search, 250));
  // Enter searches right away instead of submitting the dialog without a choice.
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      search();
    }
  });
  search();

  const linked = await formDialog({
    title: 'Link to a product',
    intro: h(
      'p',
      {},
      'Choose the product that ',
      h('strong', {}, variantName(variant)),
      ` in ${variant.storeName} really is. ${variant.storeName} will then show that product’s shared stock; its current number there is replaced.`,
    ),
    content: [field({ label: 'Search products', control: searchInput }), announcer, results],
    initialFocus: () => searchInput,
    submitLabel: 'Link',
    onSubmit: async (form) => {
      const chosen = form.querySelector(`input[name="${radioName}"]:checked`);
      if (!chosen) throw new Error('Choose a product from the list first.');
      await api(`/api/variants/${variant.id}/link`, {
        method: 'PUT',
        body: { itemId: Number(chosen.value) },
        toastErrors: false,
      });
      return chosen.dataset.sku;
    },
  });
  controller?.abort();
  if (linked) {
    toast(`${variantName(variant)} is now linked to ${linked}.`);
    refresh();
  }
}

const takenIn = (item, storeId) =>
  item.levels.some((l) => l.stores.some((s) => s.storeId === storeId));

function pickerOption(item, variant, radioName) {
  const storeNames = [...new Set(item.levels.flatMap((l) => l.stores.map((s) => s.storeName)))];
  const takenInStore = takenIn(item, variant.storeId);
  const id = uid('option');
  const quantity = item.levels[0]?.quantity;
  return h(
    'label',
    { class: ['picker-option', takenInStore && 'is-disabled'], for: id },
    h('input', {
      type: 'radio',
      name: radioName,
      id,
      value: String(item.id),
      disabled: takenInStore,
      dataset: { sku: item.sku },
    }),
    h(
      'span',
      { class: 'picker-option-body' },
      h('span', { class: 'strong' }, item.title || item.sku),
      h(
        'span',
        { class: 'muted small' },
        h('span', { class: 'mono' }, item.sku),
        storeNames.length ? ` · in ${storeNames.join(', ')}` : ' · not in any store yet',
        quantity !== null && quantity !== undefined ? ` · ${num(quantity)} in stock` : '',
      ),
      takenInStore &&
        h(
          'span',
          { class: 'small text-warning' },
          `Already linked to another variant in ${variant.storeName}`,
        ),
    ),
  );
}

async function createFromSku(variant, refresh) {
  const done = await confirmDialog({
    title: 'Create a product from this SKU?',
    message: h(
      'p',
      {},
      'This adds ',
      h('span', { class: 'mono' }, variant.sku),
      ` as a product and links ${variantName(variant)} in ${variant.storeName} to it. Variants with the same SKU in your other stores will share its stock.`,
    ),
    confirmLabel: 'Create product',
    onConfirm: async () => {
      const item = await api('/api/items', {
        method: 'POST',
        body: { sku: variant.sku, title: variantName(variant) },
        toastErrors: false,
      });
      await api(`/api/variants/${variant.id}/link`, {
        method: 'PUT',
        body: { itemId: item.id },
        toastErrors: false,
      });
    },
  });
  if (done) {
    toast(`Product ${variant.sku} created.`);
    refresh();
  }
}

/** For a duplicate SKU: sync this variant as that SKU (finding or creating its product). */
async function syncThisOne(variant, refresh) {
  const done = await confirmDialog({
    title: 'Sync this variant?',
    message: [
      h(
        'p',
        {},
        h('strong', {}, variantName(variant)),
        ` will share stock as SKU ${variant.sku} in ${variant.storeName}. The other variants with this SKU stay unsynced.`,
      ),
      h(
        'p',
        { class: 'muted' },
        'Its current number in Shopify is replaced by the shared stock. Giving every variant its own SKU in Shopify is still the cleaner fix.',
      ),
    ],
    confirmLabel: 'Sync this one',
    onConfirm: async () => {
      const found = await api(`/api/items${qs({ search: variant.sku, pageSize: 50 })}`, {
        toastErrors: false,
      });
      let item = found.items.find((i) => i.sku === variant.sku);
      item ??= await api('/api/items', {
        method: 'POST',
        body: { sku: variant.sku, title: variantName(variant) },
        toastErrors: false,
      });
      await api(`/api/variants/${variant.id}/link`, {
        method: 'PUT',
        body: { itemId: item.id },
        toastErrors: false,
      });
    },
  });
  if (done) {
    toast(`${variantName(variant)} now syncs as ${variant.sku}.`);
    refresh();
  }
}

async function neverSync(variant, refresh) {
  const done = await confirmDialog({
    title: 'Don’t sync this variant?',
    message: [
      h(
        'p',
        {},
        `${variantName(variant)} in ${variant.storeName} will be left alone: its stock in Shopify stays as it is.`,
      ),
      h('p', { class: 'muted' }, 'You can undo this from the Ignored tab.'),
    ],
    confirmLabel: 'Don’t sync',
    tone: 'critical',
    onConfirm: () =>
      api(`/api/variants/${variant.id}/link`, {
        method: 'PUT',
        body: { itemId: null },
        toastErrors: false,
      }),
  });
  if (done) {
    toast(`${variantName(variant)} won’t be synced.`);
    refresh();
  }
}

async function resetToAuto(variant, refresh) {
  try {
    await api(`/api/variants/${variant.id}/link`, { method: 'DELETE' });
    toast(`${variantName(variant)} is matched by SKU again.`);
    refresh();
  } catch {
    // api() already showed the error.
  }
}
