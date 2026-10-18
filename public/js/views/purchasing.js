import { ApiError, api, isAbort, latestOnly, qs } from '../api.js';
import { confirmDialog, formDialog } from '../dialog.js';
import { debounce, h, icon, replace, uid } from '../dom.js';
import { dateOnly, days, money, num, percent, plural } from '../format.js';
import {
  ORDER_STATUS,
  moneyInput,
  orderStatusBadge,
  overdueBadge,
  parseDecimal,
  perDay,
  readWholeNumber,
  supplierDialog,
  wholeNumberInput,
} from '../purchasing-common.js';
import { toast } from '../toast.js';
import {
  badge,
  banner,
  button,
  card,
  dataTable,
  emptyState,
  errorState,
  facts,
  field,
  filterBar,
  input,
  linkButton,
  loadInto,
  loadingState,
  muted,
  pageHeader,
  pagination,
  select,
  setChipCount,
  withBusy,
} from '../ui.js';

const TABS = [
  { value: 'orders', label: 'Orders' },
  { value: 'reorder', label: 'Reorder', count: null },
  { value: 'suppliers', label: 'Suppliers' },
];
const STATUS_FILTERS = [
  { value: 'open', label: 'Open', count: null },
  ...['draft', 'ordered', 'partial', 'received', 'closed', 'cancelled'].map((value) => ({
    value,
    label: ORDER_STATUS[value].label,
    count: null,
  })),
  { value: 'all', label: 'All', count: null },
];
const PAGE_SIZE = 50;
const REORDER_PAGE_SIZE = 100;

/** #/purchasing: purchase orders, reorder suggestions and suppliers, as tabs (?tab=…). */
export async function render({ root, query, signal, setTitle }) {
  setTitle('Purchasing');
  const tabValue = TABS.some((t) => t.value === query.get('tab')) ? query.get('tab') : 'orders';
  const state = {
    tab: tabValue,
    // Orders
    status: STATUS_FILTERS.some((s) => s.value === query.get('status'))
      ? query.get('status')
      : 'open',
    supplierId: query.get('supplierId') ?? '',
    search: query.get('search') ?? '',
    page: Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1),
    // Reorder
    filter: query.get('filter') === 'all' ? 'all' : 'needed',
    // Suppliers
    supplier: Number(query.get('supplier')) || null,
    archived: query.get('archived') === 'true',
  };

  const tabs = filterBar({
    label: 'Purchasing sections',
    options: TABS,
    value: state.tab,
    onChange: (value) => {
      state.tab = value;
      state.page = 1;
      state.search = '';
      state.supplierId = '';
      state.supplier = null;
      show();
    },
  });
  tabs.classList.add('po-tabs');
  const panel = h('div', { class: 'stack-lg' });
  root.append(
    pageHeader({
      title: 'Purchasing',
      subtitle:
        'Order stock from your suppliers, receive it into the shared stock, and see what to reorder.',
      actions: [
        linkButton('New purchase order', '#/purchasing/orders/new', {
          variant: 'primary',
          iconName: 'plus',
        }),
      ],
    }),
    tabs,
    panel,
  );

  // The Reorder tab shows how many products need ordering, whichever tab is open.
  const refreshReorderCount = () =>
    api('/api/purchasing/reorder?pageSize=1', { signal })
      .then((data) => setChipCount(tabs, 'reorder', data.counts.needed))
      .catch(() => {});
  refreshReorderCount();

  let tabController = null;
  const show = async () => {
    tabController?.abort();
    tabController = new AbortController();
    signal.addEventListener('abort', () => tabController.abort(), {
      once: true,
      signal: tabController.signal,
    });
    replace(panel, loadingState());
    const ctx = { panel, state, signal: tabController.signal, sync, refreshReorderCount, show };
    try {
      if (state.tab === 'reorder') await reorderTab(ctx);
      else if (state.tab === 'suppliers') await suppliersTab(ctx);
      else await ordersTab(ctx);
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      replace(panel, errorState(err, show));
    }
  };
  /** Keeps the tab and its filters in the address (refresh, back, sharing) without a re-render. */
  const sync = () => {
    const params =
      state.tab === 'orders'
        ? {
            status: state.status === 'open' ? '' : state.status,
            supplierId: state.supplierId,
            search: state.search,
            page: state.page > 1 ? state.page : '',
          }
        : state.tab === 'reorder'
          ? {
              filter: state.filter === 'needed' ? '' : state.filter,
              supplierId: state.supplierId,
              search: state.search,
              page: state.page > 1 ? state.page : '',
            }
          : { supplier: state.supplier ?? '', archived: state.archived ? 'true' : '' };
    history.replaceState(
      null,
      '',
      `#/purchasing${qs({ tab: state.tab === 'orders' ? '' : state.tab, ...params })}`,
    );
  };
  await show();
}

/** A search box with a hidden label, like the other list pages. */
function searchBox(label, placeholder, value, onSearch) {
  const control = input({
    type: 'search',
    id: uid('search'),
    value,
    placeholder,
    autocomplete: 'off',
  });
  control.addEventListener(
    'input',
    debounce(() => onSearch(control.value.trim()), 300),
  );
  return h(
    'div',
    { class: 'search' },
    h('label', { class: 'sr-only', for: control.id }, label),
    icon('search', { className: 'search-icon' }),
    control,
  );
}

function supplierFilter(suppliers, value, onChange, { withNone = false } = {}) {
  const control = select(
    [
      { value: '', label: 'All suppliers' },
      ...(withNone ? [{ value: 'none', label: 'No supplier' }] : []),
      ...suppliers.map((s) => ({
        value: String(s.id),
        label: s.archivedAt ? `${s.name} (archived)` : s.name,
      })),
    ],
    { value, id: uid('supplier') },
  );
  control.addEventListener('change', () => onChange(control.value));
  return h(
    'div',
    { class: 'toolbar-select' },
    h('label', { class: 'field-label', for: control.id }, 'Supplier'),
    control,
  );
}

// ---- Orders tab ---------------------------------------------------------------------------------

async function ordersTab({ panel, state, signal, sync }) {
  const suppliers = await api('/api/purchasing/suppliers?archived=true', { signal });
  const results = h('div', { class: 'results' });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const chips = filterBar({
    label: 'Order status',
    options: STATUS_FILTERS,
    value: state.status,
    onChange: (value) => {
      state.status = value;
      state.page = 1;
      update();
    },
  });
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    searchBox('Search orders', 'Order number, supplier or SKU', state.search, (v) => {
      state.search = v;
      state.page = 1;
      update();
    }),
  );
  replace(panel, toolbar, chips, announcer, results);
  if (suppliers.length > 1) {
    toolbar.append(
      supplierFilter(suppliers, state.supplierId, (value) => {
        state.supplierId = value;
        state.page = 1;
        update();
      }),
    );
  }

  const update = latestOnly(signal, async (reqSignal) => {
    sync();
    await loadInto(results, {
      signal: reqSignal,
      keepContent: true,
      load: () =>
        api(
          `/api/purchasing/orders${qs({
            status: state.status,
            supplierId: state.supplierId,
            search: state.search,
            page: state.page,
            pageSize: PAGE_SIZE,
          })}`,
          { signal: reqSignal },
        ),
      render: (list) => {
        for (const s of STATUS_FILTERS) setChipCount(chips, s.value, list.counts[s.value] ?? 0);
        announcer.textContent = `${plural(list.total, 'order')} found`;
        if (list.total === 0) return noOrders(state, list, suppliers);
        return [
          ordersTable(list.orders),
          pagination({
            page: list.page,
            pageSize: list.pageSize,
            total: list.total,
            noun: 'orders',
            onPage: (page) => {
              state.page = page;
              update().then(() => results.scrollIntoView({ block: 'start' }));
            },
          }),
        ];
      },
    });
  });
  await update();
}

function noOrders(state, list, suppliers) {
  if (list.counts.all === 0 && !state.search) {
    if (suppliers.length === 0) {
      return emptyState({
        title: 'No purchase orders yet',
        message: 'Add the suppliers you buy from first, then order stock from them here.',
        iconName: 'truck',
        action: linkButton('Add a supplier', '#/purchasing?tab=suppliers', { variant: 'primary' }),
      });
    }
    return emptyState({
      title: 'No purchase orders yet',
      message:
        'Create one when you order stock: when it arrives, receive it here and every store updates.',
      iconName: 'truck',
      action: linkButton('New purchase order', '#/purchasing/orders/new', { variant: 'primary' }),
    });
  }
  if (state.search) {
    return emptyState({
      title: `No orders match “${state.search}”`,
      message: 'Search by order number (like PO-0012), supplier or SKU.',
      iconName: 'search',
    });
  }
  return emptyState({
    title:
      state.status === 'open'
        ? 'No open orders'
        : `No ${ORDER_STATUS[state.status]?.label.toLowerCase() ?? ''} orders`,
    message: state.status === 'open' ? 'Everything you ordered has arrived or was closed.' : null,
    iconName: 'check',
  });
}

function ordersTable(orders) {
  return dataTable({
    caption: 'Purchase orders',
    className: 'po-orders-table',
    rowHref: (o) => `#/purchasing/orders/${o.id}`,
    columns: [
      {
        label: 'Order',
        render: (o) =>
          h(
            'div',
            { class: 'product-cell' },
            h('a', { class: 'product-link', href: `#/purchasing/orders/${o.id}` }, o.number),
            h('span', { class: 'product-meta' }, `Created ${dateOnly(o.createdAt)}`),
          ),
      },
      { label: 'Supplier', render: (o) => o.supplier.name },
      {
        label: 'Status',
        render: (o) =>
          h('div', { class: 'badges' }, orderStatusBadge(o.status), o.overdue && overdueBadge()),
      },
      { label: 'Expected', render: (o) => (o.expectedOn ? dateOnly(o.expectedOn) : muted('—')) },
      { label: 'Products', align: 'end', render: (o) => num(o.lines) },
      {
        label: 'Total',
        align: 'end',
        render: (o) => h('span', { class: 'num' }, money(o.total, o.currencyCode)),
      },
      {
        label: 'Received',
        align: 'end',
        render: (o) =>
          o.status === 'draft' || o.status === 'cancelled'
            ? muted('—')
            : receivedMeter(o.receivedFraction, o.quantityReceived, o.quantityOrdered),
      },
    ],
    rows: orders,
  });
}

/** "62%" with a small bar; the numbers are in the title and for screen readers. */
export function receivedMeter(fraction, received, ordered) {
  const bar = h('span', { class: 'po-meter-bar' });
  bar.style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
  return h(
    'span',
    { class: 'po-meter', title: `${num(received)} of ${num(ordered)} units` },
    h('span', { class: 'po-meter-track', 'aria-hidden': 'true' }, bar),
    h('span', { class: 'num' }, percent(fraction)),
  );
}

// ---- Reorder tab --------------------------------------------------------------------------------

async function reorderTab({ panel, state, signal, sync, refreshReorderCount }) {
  const suppliers = await api('/api/purchasing/suppliers', { signal });
  const results = h('div', { class: 'results' });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const intro = h('div', { class: 'stack' });
  const chips = filterBar({
    label: 'Show',
    options: [
      { value: 'needed', label: 'Needs reordering', count: null },
      { value: 'all', label: 'All products', count: null },
    ],
    value: state.filter,
    onChange: (value) => {
      state.filter = value;
      state.page = 1;
      selection.clear();
      update();
    },
  });
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    searchBox('Search products', 'Search by SKU or name', state.search, (v) => {
      state.search = v;
      state.page = 1;
      update();
    }),
  );
  /** itemId → { row, quantity input } of the ticked rows. */
  const selection = new Map();
  const selectionBar = h('div', { class: 'form-actions save-bar po-selection', hidden: true });
  replace(panel, intro, toolbar, chips, announcer, results, selectionBar);
  toolbar.append(
    supplierFilter(
      suppliers,
      state.supplierId,
      (value) => {
        state.supplierId = value;
        state.page = 1;
        selection.clear();
        update();
      },
      { withNone: true },
    ),
  );

  const renderSelectionBar = () => {
    const count = selection.size;
    selectionBar.hidden = count === 0;
    selectionBar.classList.toggle('is-dirty', count > 0);
    const create = button(count === 1 ? 'Create a draft order' : 'Create draft orders', {
      variant: 'primary',
      onClick: () => createDrafts(create),
    });
    replace(
      selectionBar,
      create,
      button('Clear selection', {
        variant: 'plain',
        onClick: () => {
          selection.clear();
          for (const box of results.querySelectorAll('input[data-select]')) box.checked = false;
          renderSelectionBar();
        },
      }),
      h(
        'span',
        { class: 'muted small', 'aria-live': 'polite' },
        `${plural(count, 'product')} selected`,
      ),
    );
  };

  const createDrafts = (btn) =>
    withBusy(btn, async () => {
      const lines = [];
      for (const { row, quantity } of selection.values()) {
        const value = Number(quantity.value);
        if (!Number.isInteger(value) || value < 1 || value > 1000000) {
          quantity.focus();
          throw new Error(`Enter how many ${row.sku} to order (a whole number, at least 1).`);
        }
        lines.push({ itemId: row.itemId, quantity: value });
      }
      const send = (exchangeRates) =>
        api('/api/purchasing/reorder/draft-orders', {
          method: 'POST',
          body: { lines, exchangeRates },
          toastErrors: false,
        });
      let result;
      try {
        result = await send();
      } catch (err) {
        // A supplier invoices in a currency we have no rate for yet: ask for it, then retry.
        const needed = err instanceof ApiError ? err.body?.exchangeRatesNeeded : null;
        if (!Array.isArray(needed) || needed.length === 0) throw err;
        result = await exchangeRatesDialog(needed, err.body.baseCurrency, send);
        if (!result) return;
      }
      const n = result.orderIds.length;
      if (n === 1) {
        toast('Draft order created. Check it, then mark it as ordered when you send it.');
        location.hash = `#/purchasing/orders/${result.orderIds[0]}`;
      } else {
        toast(`${n} draft orders created, one per supplier.`);
        location.hash = '#/purchasing?status=draft';
      }
    }).catch((err) => {
      if (err) toast(err.message, { tone: 'error' });
    });

  const update = latestOnly(signal, async (reqSignal) => {
    sync();
    await loadInto(results, {
      signal: reqSignal,
      keepContent: true,
      load: () =>
        api(
          `/api/purchasing/reorder${qs({
            filter: state.filter,
            supplierId: state.supplierId,
            search: state.search,
            page: state.page,
            pageSize: REORDER_PAGE_SIZE,
          })}`,
          { signal: reqSignal },
        ),
      render: (data) => {
        setChipCount(chips, 'needed', data.counts.needed);
        setChipCount(chips, 'all', data.counts.all);
        replace(intro, reorderIntro(data));
        announcer.textContent = `${plural(data.total, 'product')} found`;
        // Rows ticked before a reload stay ticked when they are still listed.
        const kept = new Map();
        for (const row of data.rows) if (selection.has(row.itemId)) kept.set(row.itemId, null);
        selection.clear();
        renderSelectionBar();
        if (data.total === 0) return noReorder(state, data);
        const table = reorderTable(data, {
          isSelected: (row) => kept.has(row.itemId),
          onSelect: (row, quantity, selected) => {
            if (selected) selection.set(row.itemId, { row, quantity });
            else selection.delete(row.itemId);
            renderSelectionBar();
          },
          showNeeded: state.filter === 'all',
          onChooseSupplier: (row) =>
            chooseSupplier(row, suppliers, () => {
              update();
              refreshReorderCount();
            }),
        });
        return [
          data.rows.some((r) => r.needsReorder && r.supplier) &&
            h(
              'div',
              { class: 'po-select-all' },
              button('Select every product that needs reordering', {
                size: 'small',
                variant: 'plain',
                iconName: 'check',
                onClick: () => {
                  for (const box of results.querySelectorAll('input[data-select][data-needed]')) {
                    if (!box.checked && !box.disabled) box.click();
                  }
                },
              }),
            ),
          table,
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
  await update();
}

function reorderIntro(data) {
  const s = data.settings;
  return [
    !data.sales.recorded &&
      banner(
        { tone: 'info', title: 'No sales recorded yet' },
        h(
          'p',
          {},
          'Suggestions come from your stores’ sales. Give Store Sync permission to read orders on each store’s page; the sales history then loads on its own.',
        ),
        data.sales.stores > 0 &&
          h(
            'p',
            { class: 'muted' },
            `${num(data.sales.storesWithPermission)} of ${plural(data.sales.stores, 'store')} allow it now.`,
          ),
      ),
    !s.alertsEnabled &&
      banner(
        { tone: 'neutral', title: 'Reorder alerts are off' },
        h(
          'p',
          {},
          'Suggestions still show here. Turn alerts on in ',
          h('a', { href: '#/settings' }, 'Settings'),
          '.',
        ),
      ),
    h(
      'p',
      { class: 'muted' },
      `Based on sales in the last ${plural(s.lookbackDays, 'day')} across every store, ${plural(s.safetyDays, 'day')} of safety margin, and enough stock for ${plural(s.coverDays, 'day')} after a delivery. `,
      h('a', { href: '#/settings' }, 'Change in Settings'),
    ),
  ];
}

function noReorder(state, data) {
  if (state.search) {
    return emptyState({
      title: `No products match “${state.search}”`,
      message: 'Search by SKU or product name.',
      iconName: 'search',
    });
  }
  if (state.filter === 'needed') {
    return emptyState({
      title: 'Nothing needs reordering',
      message: data.sales.recorded
        ? 'Every product has enough stock, or enough on order, to last until a new delivery could arrive.'
        : 'Once sales are recorded, products that will run out before a delivery could arrive show up here.',
      iconName: 'check',
    });
  }
  return emptyState({ title: 'No products', iconName: 'box' });
}

function reorderTable(data, { isSelected, onSelect, onChooseSupplier, showNeeded }) {
  return dataTable({
    caption: 'Reorder suggestions',
    className: 'po-reorder-table',
    columns: [
      {
        label: 'Product',
        className: 'col-product',
        render: (row) => productWithCheckbox(row, isSelected(row), onSelect, showNeeded),
      },
      { label: 'In stock', align: 'end', render: stockCell },
      {
        label: 'Sells',
        align: 'end',
        render: (row) => h('span', { class: 'num' }, perDay(row.velocity, { short: true })),
      },
      {
        label: 'On order',
        align: 'end',
        render: (row) => (row.onOrder ? h('span', { class: 'num' }, num(row.onOrder)) : muted('—')),
      },
      {
        label: 'Lead time',
        align: 'end',
        render: (row) =>
          h(
            'div',
            { class: 'po-stack-end' },
            h('span', { class: 'num' }, plural(row.leadTimeDays, 'day')),
            h(
              'span',
              { class: 'po-cell-hint' },
              row.leadTimeSource === 'item'
                ? 'this product'
                : row.leadTimeSource === 'supplier'
                  ? 'supplier'
                  : 'default',
            ),
          ),
      },
      {
        label: 'Supplier',
        render: (row) =>
          row.supplier
            ? h('span', {}, row.supplier.name)
            : button('Choose…', {
                size: 'small',
                variant: 'plain',
                onClick: () => onChooseSupplier(row),
                attrs: { 'aria-label': `Choose a supplier for ${row.sku}` },
              }),
      },
      { label: 'Order', align: 'end', render: (row) => suggestedCell(row) },
    ],
    rows: data.rows,
  });
}

/** The stock, and below it how long it lasts at the current pace. */
function stockCell(row) {
  if (!row.stockKnown) return badge('Not started', 'neutral');
  const lasts =
    row.daysLeft === null
      ? null
      : row.available <= 0
        ? 'out now'
        : row.daysLeft < 1
          ? 'lasts less than a day'
          : `lasts ${days(row.daysLeft)}`;
  return h(
    'div',
    { class: 'po-stack-end' },
    row.available < 0
      ? badge(`${num(row.available)} oversold`, 'critical', 'error')
      : h('span', { class: 'num' }, num(row.available)),
    lasts &&
      h(
        'span',
        {
          class: ['po-cell-hint', row.needsReorder && 'text-warning'],
          title: row.stockoutOn ? `Runs out around ${dateOnly(row.stockoutOn)}` : null,
        },
        lasts,
      ),
  );
}

function productWithCheckbox(row, selected, onSelect, showNeeded) {
  const box = h('input', {
    type: 'checkbox',
    checked: selected,
    'aria-label': `Select ${row.sku}`,
    dataset: {
      select: String(row.itemId),
      ...(row.needsReorder && row.supplier ? { needed: '' } : {}),
    },
  });
  box.addEventListener('change', () => {
    const quantity = box.closest('tr')?.querySelector('input[data-quantity]');
    onSelect(row, quantity, box.checked);
  });
  if (selected) queueMicrotask(() => box.dispatchEvent(new Event('change')));
  return h(
    'div',
    { class: 'po-pick' },
    box,
    h(
      'div',
      { class: 'product-cell' },
      h('a', { class: 'product-link', href: `#/items/${row.itemId}` }, row.title || row.sku),
      h(
        'div',
        { class: 'product-meta' },
        h('span', { class: 'mono' }, row.sku),
        !row.reorderEnabled && badge('Not reordered', 'neutral'),
        showNeeded && row.needsReorder && badge('Reorder', 'warning', 'alert'),
      ),
    ),
  );
}

function suggestedCell(row) {
  if (!row.reorderEnabled) return muted('Off');
  const quantity = input({
    type: 'number',
    min: 1,
    max: 1000000,
    step: 1,
    inputmode: 'numeric',
    class: 'input input-qty',
    value: row.suggested || '',
    placeholder: '0',
    'aria-label': `Units of ${row.sku} to order`,
    dataset: { quantity: '' },
  });
  const order = row.supplier
    ? linkButton('Order', '#/purchasing/orders/new', {
        size: 'small',
        variant: 'plain',
        attrs: { 'aria-label': `Order ${row.sku} from ${row.supplier.name}` },
      })
    : null;
  // The link carries what is typed, so "Order" opens a new order already filled in.
  const syncLink = () => {
    if (!order) return;
    const qty = Number(quantity.value) > 0 ? Number(quantity.value) : row.suggested || 1;
    order.href = `#/purchasing/orders/new?supplierId=${row.supplier.id}&items=${row.itemId}:${qty}`;
  };
  quantity.addEventListener('input', syncLink);
  syncLink();
  const hint =
    row.minOrderQty || (row.packSize && row.packSize > 1)
      ? h(
          'span',
          { class: 'po-cell-hint' },
          [
            row.minOrderQty && `min. ${num(row.minOrderQty)}`,
            row.packSize > 1 && `packs of ${num(row.packSize)}`,
          ]
            .filter(Boolean)
            .join(' · '),
        )
      : null;
  return h(
    'div',
    { class: 'po-order-cell' },
    h('div', { class: 'po-order-inputs' }, quantity, order),
    hint,
  );
}

/**
 * Asks for the exchange rate of each currency (units of it per 1 of the base currency), then
 * calls `send(rates)`. Resolves with what `send` returned, or null when cancelled.
 */
function exchangeRatesDialog(currencies, baseCurrency, send) {
  const controls = currencies.map((code) => ({
    code,
    control: moneyInput({ name: `rate-${code}` }),
  }));
  return formDialog({
    title: currencies.length === 1 ? `Exchange rate for ${currencies[0]}` : 'Exchange rates needed',
    intro: h(
      'p',
      {},
      `${currencies.length === 1 ? 'A supplier invoices' : 'Suppliers invoice'} in ${currencies.join(' and ')}, and Store Sync doesn’t know ${currencies.length === 1 ? 'that rate' : 'those rates'} yet. ${currencies.length === 1 ? 'It turns' : 'They turn'} the order’s prices into product costs in ${baseCurrency}.`,
    ),
    content: controls.map(({ code, control }) =>
      field({
        label: `${code} per 1 ${baseCurrency}`,
        control,
        hint: `How many ${code} make 1 ${baseCurrency}.`,
      }),
    ),
    submitLabel: 'Create draft orders',
    initialFocus: () => controls[0]?.control,
    onSubmit: () => {
      const rates = {};
      for (const { code, control } of controls) {
        const value = parseDecimal(control.value);
        if (!(value > 0)) {
          control.focus();
          throw new Error(`Enter how many ${code} make 1 ${baseCurrency}: a number above 0.`);
        }
        rates[code] = value;
      }
      return send(rates);
    },
  });
}

async function chooseSupplier(row, suppliers, done) {
  if (suppliers.length === 0) {
    toast('Add a supplier on the Suppliers tab first.', { tone: 'info' });
    return;
  }
  const control = select(
    suppliers.map((s) => ({ value: String(s.id), label: s.name })),
    { name: 'supplierId' },
  );
  const saved = await formDialog({
    title: `Choose a supplier for ${row.sku}`,
    intro: h('p', {}, 'Reorder suggestions and draft orders for this product go to this supplier.'),
    content: field({ label: 'Supplier', control }),
    submitLabel: 'Save',
    onSubmit: () =>
      api(`/api/purchasing/items/${row.itemId}`, {
        method: 'PATCH',
        body: { supplierId: Number(control.value) },
        toastErrors: false,
      }),
  });
  if (saved) {
    toast(`${row.sku} is now ordered from ${saved.supplier?.name ?? 'that supplier'}.`);
    done();
  }
}

// ---- Suppliers tab ------------------------------------------------------------------------------

async function suppliersTab(ctx) {
  if (ctx.state.supplier) return supplierDetail(ctx);
  const { panel, state, signal, sync } = ctx;
  const results = h('div', { class: 'results' });
  const settings = await api('/api/settings', { signal });
  const archived = h('input', { type: 'checkbox', checked: state.archived, id: uid('archived') });
  const add = button('Add supplier…', {
    variant: 'primary',
    iconName: 'plus',
    onClick: async () => {
      const created = await supplierDialog(null, settings);
      if (created) {
        toast(`${created.name} added. Add the products you buy from them next.`);
        state.supplier = created.id;
        ctx.show();
      }
    },
  });
  replace(
    panel,
    h(
      'div',
      { class: 'toolbar po-suppliers-toolbar' },
      add,
      h(
        'label',
        { class: 'checkbox', for: archived.id },
        archived,
        h('span', {}, 'Show archived suppliers'),
      ),
    ),
    results,
  );
  const update = latestOnly(signal, (reqSignal) => {
    sync();
    return loadInto(results, {
      signal: reqSignal,
      keepContent: true,
      load: () =>
        api(`/api/purchasing/suppliers${qs({ archived: state.archived ? 'true' : '' })}`, {
          signal: reqSignal,
        }),
      render: (suppliers) =>
        suppliers.length === 0
          ? emptyState({
              title: 'No suppliers yet',
              message: 'Add the companies you buy stock from, with their prices and lead times.',
              iconName: 'users',
            })
          : suppliersTable(suppliers),
    });
  });
  archived.addEventListener('change', () => {
    state.archived = archived.checked;
    update();
  });
  await update();
}

function suppliersTable(suppliers) {
  const href = (s) => `#/purchasing?tab=suppliers&supplier=${s.id}`;
  return dataTable({
    caption: 'Suppliers',
    rowHref: href,
    columns: [
      {
        label: 'Supplier',
        render: (s) =>
          h(
            'div',
            { class: 'product-cell' },
            h('a', { class: 'product-link', href: href(s) }, s.name),
            s.archivedAt && h('div', { class: 'product-meta' }, badge('Archived', 'neutral')),
          ),
      },
      {
        label: 'Contact',
        render: (s) =>
          s.contactName || s.email
            ? h(
                'div',
                { class: 'po-contact' },
                s.contactName && h('span', {}, s.contactName),
                s.email && h('span', { class: 'muted' }, s.email),
              )
            : muted('—'),
      },
      { label: 'Currency', render: (s) => s.currencyCode },
      {
        label: 'Lead time',
        render: (s) =>
          s.leadTimeDays === null
            ? muted('Not set')
            : days(s.leadTimeDays || 0.5).replace('less than a day', 'same day'),
      },
      { label: 'Products', align: 'end', render: (s) => num(s.itemCount) },
      {
        label: 'Open orders',
        align: 'end',
        render: (s) => (s.openOrders ? num(s.openOrders) : muted('—')),
      },
    ],
    rows: suppliers,
  });
}

async function supplierDetail({ panel, state, signal, sync, show }) {
  const body = h('div', { class: 'stack-lg' });
  replace(
    panel,
    h(
      'a',
      {
        class: 'back-link',
        href: '#/purchasing?tab=suppliers',
        onclick: (e) => {
          e.preventDefault();
          state.supplier = null;
          show();
        },
      },
      icon('chevronLeft'),
      'All suppliers',
    ),
    body,
  );
  const reload = latestOnly(signal, (reqSignal) => {
    sync();
    return loadInto(body, {
      signal: reqSignal,
      keepContent: true,
      load: () =>
        Promise.all([
          api(`/api/purchasing/suppliers/${state.supplier}`, { signal: reqSignal }),
          api('/api/settings', { signal: reqSignal }),
        ]),
      render: ([supplier, settings]) => supplierCards(supplier, settings, { reload, state, show }),
    });
  });
  await reload();
}

function supplierCards(supplier, settings, { reload, state, show }) {
  const archived = Boolean(supplier.archivedAt);
  const edit = button('Edit…', {
    size: 'small',
    iconName: 'edit',
    onClick: async () => {
      if (await supplierDialog(supplier, settings)) {
        toast('Supplier saved.');
        reload();
      }
    },
  });
  const archive = archived
    ? button('Restore', {
        size: 'small',
        onClick: (e) =>
          withBusy(e.currentTarget, async () => {
            await api(`/api/purchasing/suppliers/${supplier.id}/restore`, { method: 'POST' });
            toast(`${supplier.name} is back in your supplier list.`);
            reload();
          }).catch(() => {}),
      })
    : supplier.orderCount === 0
      ? button('Delete…', {
          size: 'small',
          variant: 'plain-critical',
          onClick: async () => {
            const done = await confirmDialog({
              title: `Delete “${supplier.name}”?`,
              message: h(
                'p',
                {},
                'It has no purchase orders. Its product prices are deleted too. This can’t be undone.',
              ),
              confirmLabel: 'Delete supplier',
              tone: 'critical',
              onConfirm: () =>
                api(`/api/purchasing/suppliers/${supplier.id}`, {
                  method: 'DELETE',
                  toastErrors: false,
                }),
            });
            if (done) {
              toast('Supplier deleted.');
              state.supplier = null;
              show();
            }
          },
        })
      : button('Archive…', {
          size: 'small',
          variant: 'plain-critical',
          onClick: async () => {
            if (supplier.openOrders > 0) {
              toast(
                `${supplier.name} has ${plural(supplier.openOrders, 'open order')}. Receive, close or cancel ${supplier.openOrders === 1 ? 'it' : 'them'} before archiving the supplier.`,
                { tone: 'info' },
              );
              return;
            }
            const done = await confirmDialog({
              title: `Archive “${supplier.name}”?`,
              message: [
                h(
                  'p',
                  {},
                  'It leaves your supplier list and can’t get new orders. Its past orders stay as they are.',
                ),
                h(
                  'p',
                  {},
                  `Products that are ordered from it (${num(supplier.preferredCount)}) no longer have a supplier: choose another one for them on the Reorder tab.`,
                ),
              ],
              confirmLabel: 'Archive supplier',
              tone: 'critical',
              onConfirm: () =>
                api(`/api/purchasing/suppliers/${supplier.id}/archive`, {
                  method: 'POST',
                  toastErrors: false,
                }),
            });
            if (done) {
              toast(`${supplier.name} is archived. You can restore it from the archived list.`);
              reload();
            }
          },
        });
  const actions = [
    !archived &&
      linkButton('New order', `#/purchasing/orders/new?supplierId=${supplier.id}`, {
        size: 'small',
        variant: 'primary',
        iconName: 'plus',
      }),
    !archived && edit,
    archive,
  ].filter(Boolean);
  return [
    card(
      {
        title: supplier.name,
        description: archived ? `Archived ${dateOnly(supplier.archivedAt)}` : null,
        actions,
      },
      facts([
        ['Contact', supplier.contactName ?? muted('—')],
        [
          'Email',
          supplier.email
            ? h('a', { href: `mailto:${supplier.email}` }, supplier.email)
            : muted('—'),
        ],
        ['Phone', supplier.phone ?? muted('—')],
        ['Currency', supplier.currencyCode],
        [
          'Lead time',
          supplier.leadTimeDays === null
            ? muted(
                `Not set (the default, ${plural(settings.reorderDefaultLeadTimeDays, 'day')}, is used)`,
              )
            : plural(supplier.leadTimeDays, 'day'),
        ],
        [
          'Orders',
          supplier.orderCount
            ? h(
                'a',
                { href: `#/purchasing?supplierId=${supplier.id}&status=all` },
                `${plural(supplier.orderCount, 'order')}${supplier.openOrders ? `, ${num(supplier.openOrders)} open` : ''}`,
              )
            : muted('None yet'),
        ],
        supplier.notes && ['Notes', h('span', { class: 'po-notes' }, supplier.notes)],
      ]),
    ),
    card(
      {
        title: 'Products from this supplier',
        description: 'Their code and price for each product, and how many you must order.',
        actions:
          !archived &&
          button('Add product…', {
            size: 'small',
            iconName: 'plus',
            onClick: () => supplierItemDialog(supplier, null, reload),
          }),
      },
      supplier.items.length === 0
        ? emptyState({
            title: 'No products yet',
            message:
              'Add the products you buy from this supplier, with their price. New orders then fill in the price for you.',
            iconName: 'box',
          })
        : dataTable({
            caption: `Products from ${supplier.name}`,
            columns: [
              {
                label: 'Product',
                className: 'col-product',
                render: (si) =>
                  h(
                    'div',
                    { class: 'product-cell' },
                    h(
                      'a',
                      { class: 'product-link', href: `#/items/${si.itemId}` },
                      si.title || si.sku,
                    ),
                    h(
                      'div',
                      { class: 'product-meta' },
                      h('span', { class: 'mono' }, si.sku),
                      !si.preferred && badge('Another supplier is preferred', 'neutral'),
                    ),
                  ),
              },
              {
                label: 'Their code',
                render: (si) =>
                  si.supplierSku ? h('span', { class: 'mono' }, si.supplierSku) : muted('—'),
              },
              {
                label: 'Price',
                align: 'end',
                render: (si) =>
                  h('span', { class: 'num' }, money(si.unitCost, supplier.currencyCode)),
              },
              {
                label: 'Minimum',
                align: 'end',
                render: (si) => (si.minOrderQty ? num(si.minOrderQty) : muted('—')),
              },
              {
                label: 'Pack size',
                align: 'end',
                render: (si) => (si.packSize ? num(si.packSize) : muted('—')),
              },
              {
                label: 'Actions',
                className: 'col-actions',
                render: (si) =>
                  !archived &&
                  h(
                    'div',
                    { class: 'row-actions' },
                    button('Edit…', {
                      size: 'small',
                      variant: 'plain',
                      onClick: () => supplierItemDialog(supplier, si, reload),
                      attrs: { 'aria-label': `Edit ${si.sku}` },
                    }),
                    button('Remove…', {
                      size: 'small',
                      variant: 'plain-critical',
                      attrs: { 'aria-label': `Remove ${si.sku}` },
                      onClick: async () => {
                        const done = await confirmDialog({
                          title: `Remove ${si.sku} from ${supplier.name}?`,
                          message: h(
                            'p',
                            {},
                            si.preferred
                              ? 'Its price here is deleted, and the product no longer has a preferred supplier.'
                              : 'Its price here is deleted.',
                          ),
                          confirmLabel: 'Remove',
                          tone: 'critical',
                          onConfirm: () =>
                            api(`/api/purchasing/suppliers/${supplier.id}/items/${si.itemId}`, {
                              method: 'DELETE',
                              toastErrors: false,
                            }),
                        });
                        if (done) {
                          toast(`${si.sku} removed from ${supplier.name}.`);
                          reload();
                        }
                      },
                    }),
                  ),
              },
            ],
            rows: supplier.items,
          }),
    ),
  ];
}

/** Add a product to a supplier (with a search) or edit what the supplier charges for it. */
async function supplierItemDialog(supplier, existing, reload) {
  const radioName = uid('item');
  const searchInput = input({
    type: 'search',
    placeholder: 'SKU or product name',
    autocomplete: 'off',
  });
  const results = h('div', { class: 'picker-results' });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  let controller = null;
  const search = async () => {
    controller?.abort();
    controller = new AbortController();
    results.setAttribute('aria-busy', 'true');
    try {
      const { items, total } = await api(
        `/api/purchasing/item-search${qs({ search: searchInput.value.trim(), supplierId: supplier.id })}`,
        { signal: controller.signal },
      );
      const cut = total > items.length;
      announcer.textContent = cut
        ? `${plural(total, 'product')} found, ${num(items.length)} listed`
        : `${plural(total, 'product')} found`;
      replace(
        results,
        items.length === 0
          ? muted('No products found. Try another SKU or name.')
          : h(
              'fieldset',
              { class: 'picker' },
              h('legend', { class: 'sr-only' }, 'Products'),
              items.map((item) => {
                const id = uid('option');
                return h(
                  'label',
                  { class: ['picker-option', item.soldBySupplier && 'is-disabled'], for: id },
                  h('input', {
                    type: 'radio',
                    name: radioName,
                    id,
                    value: String(item.itemId),
                    disabled: item.soldBySupplier,
                    dataset: { sku: item.sku },
                    // A product already ordered from someone else keeps that supplier unless
                    // the box is ticked on purpose.
                    onchange: () => {
                      preferred.checked =
                        item.preferredSupplierId === null ||
                        item.preferredSupplierId === supplier.id;
                    },
                  }),
                  h(
                    'span',
                    { class: 'picker-option-body' },
                    h('span', { class: 'strong' }, item.title || item.sku),
                    h('span', { class: 'muted small' }, h('span', { class: 'mono' }, item.sku)),
                    item.soldBySupplier &&
                      h('span', { class: 'small text-warning' }, 'Already in this supplier’s list'),
                  ),
                );
              }),
            ),
        cut &&
          h(
            'p',
            { class: 'muted small picker-more' },
            `Showing ${num(items.length)} of ${num(total)}. Search to narrow it down.`,
          ),
      );
    } catch (err) {
      if (!isAbort(err)) replace(results, h('p', { class: 'field-error' }, err.message));
    } finally {
      results.removeAttribute('aria-busy');
    }
  };
  if (!existing) {
    searchInput.addEventListener('input', debounce(search, 250));
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        search();
      }
    });
    search();
  }

  const supplierSku = input({
    name: 'supplierSku',
    maxlength: 100,
    value: existing?.supplierSku ?? '',
    autocomplete: 'off',
  });
  const price = moneyInput({ name: 'unitCost', value: existing?.unitCost ?? '' });
  const moq = wholeNumberInput({ name: 'minOrderQty', min: 1, value: existing?.minOrderQty ?? '' });
  const pack = wholeNumberInput({ name: 'packSize', min: 1, value: existing?.packSize ?? '' });
  const preferred = h('input', {
    type: 'checkbox',
    checked: existing ? existing.preferred : true,
    id: uid('preferred'),
  });
  const saved = await formDialog({
    title: existing ? `${existing.sku} from ${supplier.name}` : `Add a product to ${supplier.name}`,
    content: [
      !existing && field({ label: 'Search products', control: searchInput }),
      !existing && announcer,
      !existing && results,
      h(
        'div',
        { class: 'po-fields' },
        field({
          label: 'Their code',
          control: supplierSku,
          optional: true,
          hint: 'The supplier’s SKU, shown on orders.',
        }),
        field({
          label: `Price (${supplier.currencyCode})`,
          control: price,
          optional: true,
          hint: 'Per unit.',
        }),
      ),
      h(
        'div',
        { class: 'po-fields' },
        field({
          label: 'Minimum order',
          control: moq,
          optional: true,
          hint: 'Units per order, at least.',
        }),
        field({
          label: 'Pack size',
          control: pack,
          optional: true,
          hint: 'Order in multiples of this.',
        }),
      ),
      h(
        'label',
        { class: 'checkbox', for: preferred.id },
        preferred,
        h(
          'span',
          {},
          'Order this product from this supplier',
          h(
            'span',
            { class: 'field-hint block' },
            'Reorder suggestions and draft orders use the preferred supplier.',
          ),
        ),
      ),
    ],
    initialFocus: () => (existing ? supplierSku : searchInput),
    submitLabel: existing ? 'Save' : 'Add product',
    onSubmit: async (form) => {
      let itemId = existing?.itemId;
      let sku = existing?.sku;
      if (!existing) {
        const chosen = form.querySelector(`input[name="${radioName}"]:checked`);
        if (!chosen) throw new Error('Choose a product from the list first.');
        itemId = Number(chosen.value);
        sku = chosen.dataset.sku;
      }
      const unitCost = parseDecimal(price.value);
      if (Number.isNaN(unitCost) || (unitCost !== null && unitCost < 0)) {
        throw new Error('Enter the price as a number, like 12.50, or leave it empty.');
      }
      const body = {
        supplierSku: supplierSku.value.trim(),
        unitCost,
        minOrderQty: readWholeNumber(moq, {
          min: 1,
          message: 'Enter the minimum order as a whole number of 1 or more, or leave it empty.',
        }),
        packSize: readWholeNumber(pack, {
          min: 1,
          message: 'Enter the pack size as a whole number of 1 or more, or leave it empty.',
        }),
        preferred: preferred.checked,
      };
      await api(`/api/purchasing/suppliers/${supplier.id}/items/${itemId}`, {
        method: 'PUT',
        body,
        toastErrors: false,
      });
      return sku;
    },
  });
  controller?.abort();
  if (saved) {
    toast(existing ? `${saved} saved.` : `${saved} added to ${supplier.name}.`);
    reload();
  }
}
