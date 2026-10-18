import { ApiError, api, isAbort, latestOnly, qs } from '../api.js';
import { confirmDialog, formDialog } from '../dialog.js';
import { debounce, h, icon, replace, uid } from '../dom.js';
import { absoluteTime, dateOnly, money, num, percent, plural } from '../format.js';
import {
  costText,
  moneyInput,
  orderStatusBadge,
  overdueBadge,
  parseDecimal,
  uuid,
} from '../purchasing-common.js';
import { toast } from '../toast.js';
import {
  badge,
  banner,
  button,
  card,
  dataTable,
  emptyState,
  facts,
  field,
  input,
  linkButton,
  loadInto,
  muted,
  pageHeader,
  replaceHeader,
  select,
  statTile,
  withBusy,
} from '../ui.js';

const BACK = { href: '#/purchasing', label: 'Purchasing' };

/**
 * #/purchasing/orders/new (prefilled by ?supplierId=&items=itemId:qty,…) and
 * #/purchasing/orders/:id: a purchase order. A draft is edited freely; an ordered one keeps its
 * supplier and currency (dates, notes, quantities and prices can still change); afterwards only
 * its notes. Deliveries are received from here, and can be undone.
 */
export async function render({ root, params, query, signal, setTitle }) {
  const isNew = params[0] === undefined;
  const orderId = isNew ? null : Number(params[0]);
  setTitle(isNew ? 'New purchase order' : 'Purchase order');
  let header = pageHeader({ title: isNew ? 'New purchase order' : 'Purchase order', back: BACK });
  const body = h('div', { class: 'stack-lg po-page' });
  root.append(header, body);

  const page = { dirty: () => false, reload: null, signal };
  page.reload = latestOnly(signal, (reqSignal) =>
    loadInto(body, {
      signal: reqSignal,
      keepContent: true,
      load: async () => {
        const [order, suppliers, warehouses, settings] = await Promise.all([
          isNew ? null : loadOrder(orderId, reqSignal),
          api('/api/purchasing/suppliers', { signal: reqSignal }),
          api('/api/warehouses', { signal: reqSignal }),
          api('/api/settings', { signal: reqSignal }),
        ]);
        const prefill = isNew ? await loadPrefill(query, suppliers, reqSignal) : null;
        return { order, suppliers, warehouses, settings, prefill };
      },
      render: (data) => {
        if (data.order) {
          setTitle(data.order.number);
          header = replaceHeader(header, orderHeader(data.order, page));
        }
        return data.order ? orderBody(data, page) : newOrderBody(data, page);
      },
    }),
  );
  await page.reload();
}

async function loadOrder(orderId, signal) {
  try {
    return await api(`/api/purchasing/orders/${orderId}`, { signal });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new ApiError(404, 'This purchase order doesn’t exist. It may have been deleted.');
    }
    throw err;
  }
}

/** ?supplierId=3&items=12:40,13:24 → the supplier and the lines to start with. */
async function loadPrefill(query, suppliers, signal) {
  const wanted = (query.get('items') ?? '')
    .split(',')
    .map((pair) => pair.split(':').map(Number))
    .filter(([id]) => Number.isInteger(id) && id > 0)
    .map(([id, qty]) => ({ itemId: id, quantity: Number.isInteger(qty) && qty > 0 ? qty : 1 }))
    .slice(0, 100);
  const items = (
    await Promise.all(
      wanted.map((w) =>
        api(`/api/purchasing/items/${w.itemId}`, { signal }).catch((err) => {
          if (isAbort(err)) throw err;
          return null; // a product that no longer exists is just left out
        }),
      ),
    )
  ).filter(Boolean);
  let supplierId = Number(query.get('supplierId')) || null;
  if (!suppliers.some((s) => s.id === supplierId)) supplierId = null;
  supplierId ??= items.find((i) => i.supplier)?.supplier.id ?? null;
  return {
    supplierId,
    lines: items.map((item) => ({
      item,
      quantity: wanted.find((w) => w.itemId === item.itemId).quantity,
    })),
  };
}

// ---- header and actions -------------------------------------------------------------------------

function orderHeader(order, page) {
  const a = order.allowed;
  const guard = (fn) => (event) => {
    if (page.dirty()) {
      toast('Save or undo your changes first.', { tone: 'error' });
      return;
    }
    fn(event.currentTarget);
  };
  const actions = [
    a.order &&
      button('Mark as ordered', {
        variant: 'primary',
        iconName: 'truck',
        onClick: guard((btn) => markOrdered(btn, order, page)),
      }),
    a.receive &&
      button('Receive…', {
        variant: a.order ? 'secondary' : 'primary',
        iconName: 'download',
        onClick: guard(() => receiveDialog(order, page)),
      }),
    a.close && button('Close…', { onClick: guard(() => closeOrder(order, page)) }),
    a.cancel &&
      order.status !== 'draft' &&
      button('Cancel order…', {
        variant: 'plain-critical',
        onClick: guard(() => cancelOrder(order, page)),
      }),
    a.delete &&
      button('Delete…', {
        variant: 'plain-critical',
        iconName: 'trash',
        onClick: () => deleteOrder(order),
      }),
    button('Print', { variant: 'plain', iconName: 'printer', onClick: () => window.print() }),
    linkButton('Download CSV', `/api/purchasing/orders/${order.id}.csv`, {
      variant: 'plain',
      iconName: 'download',
      attrs: { download: `${order.number}.csv` },
    }),
  ].filter(Boolean);
  return pageHeader({
    title: order.number,
    subtitle: `${order.supplier.name} · delivered to ${order.warehouse.name}`,
    back: BACK,
    badges: [orderStatusBadge(order.status), order.overdue && overdueBadge()].filter(Boolean),
    actions,
  });
}

async function markOrdered(btn, order, page) {
  await withBusy(btn, async () => {
    await api(`/api/purchasing/orders/${order.id}/order`, { method: 'POST' });
    toast(
      `${order.number} is marked as ordered. Its ${plural(order.totals.quantityOrdered, 'unit')} now count as on order.`,
    );
    await page.reload();
  }).catch(() => {});
}

async function closeOrder(order, page) {
  const remaining = order.totals.remaining;
  const done = await confirmDialog({
    title: `Close ${order.number}?`,
    message: [
      h(
        'p',
        {},
        remaining > 0
          ? `The ${plural(remaining, 'unit')} not delivered yet are no longer expected: they stop counting as on order in reorder suggestions.`
          : 'Nothing more is expected on it.',
      ),
      h(
        'p',
        { class: 'muted' },
        'What was received stays in your stock. A closed order can’t receive anything more.',
      ),
    ],
    confirmLabel: 'Close order',
    onConfirm: () =>
      api(`/api/purchasing/orders/${order.id}/close`, { method: 'POST', toastErrors: false }),
  });
  if (done) {
    toast(`${order.number} is closed.`);
    page.reload();
  }
}

async function cancelOrder(order, page) {
  const done = await confirmDialog({
    title: `Cancel ${order.number}?`,
    message: h(
      'p',
      {},
      `Nothing was received on it. It stays in your list as cancelled, and its units no longer count as on order. Let ${order.supplier.name} know if you already sent it.`,
    ),
    confirmLabel: 'Cancel order',
    tone: 'critical',
    onConfirm: () =>
      api(`/api/purchasing/orders/${order.id}/cancel`, { method: 'POST', toastErrors: false }),
  });
  if (done) {
    toast(`${order.number} is cancelled.`);
    page.reload();
  }
}

async function deleteOrder(order) {
  const done = await confirmDialog({
    title: `Delete draft ${order.number}?`,
    message: h(
      'p',
      {},
      'The draft and its products are deleted. Nothing was ordered, so nothing else changes.',
    ),
    confirmLabel: 'Delete draft',
    tone: 'critical',
    onConfirm: () =>
      api(`/api/purchasing/orders/${order.id}`, { method: 'DELETE', toastErrors: false }),
  });
  if (done) {
    toast(`Draft ${order.number} deleted.`);
    location.hash = '#/purchasing';
  }
}

// ---- receiving ----------------------------------------------------------------------------------

async function receiveDialog(order, page) {
  // One id per delivery: if the request is sent twice (a retry, a double click), it books once.
  const requestId = uuid();
  const open = order.lines.filter((l) => l.remaining > 0);
  const lines = open.length ? open : order.lines;
  const inputs = lines.map((line) => {
    const control = input({
      type: 'number',
      min: 0,
      max: 1000000,
      step: 1,
      inputmode: 'numeric',
      class: 'input input-qty',
      value: line.remaining,
      id: uid('receive'),
    });
    return { line, control };
  });
  const note = input({ name: 'note', maxlength: 500, placeholder: 'e.g. Delivery note 4471' });
  const fillAll = (all) => {
    for (const { line, control } of inputs) control.value = all ? line.remaining : 0;
  };
  const result = await formDialog({
    title: `Receive a delivery on ${order.number}`,
    intro: h(
      'p',
      {},
      'Enter what arrived. The units are added to the shared stock, and every store updates within seconds.',
    ),
    content: [
      h(
        'div',
        { class: 'po-receive-tools' },
        button('Everything still to come', { size: 'small', onClick: () => fillAll(true) }),
        button('Clear', { size: 'small', variant: 'plain', onClick: () => fillAll(false) }),
      ),
      h(
        'fieldset',
        { class: 'po-receive-lines' },
        h('legend', { class: 'sr-only' }, 'Units received per product'),
        inputs.map(({ line, control }) =>
          h(
            'div',
            { class: 'po-receive-line' },
            h(
              'label',
              { for: control.id, class: 'po-receive-label' },
              h('span', { class: 'strong' }, line.title || line.sku),
              h(
                'span',
                { class: 'muted small' },
                h('span', { class: 'mono' }, line.sku),
                ` · ${num(line.remaining)} of ${num(line.quantityOrdered)} still to come`,
              ),
            ),
            control,
          ),
        ),
      ),
      field({
        label: 'Note',
        control: note,
        optional: true,
        hint: 'Shown in the order’s deliveries and the activity log.',
      }),
    ],
    submitLabel: 'Receive units',
    initialFocus: () => inputs[0]?.control,
    onSubmit: async () => {
      const received = [];
      for (const { line, control } of inputs) {
        const raw = control.value.trim();
        const value = raw === '' ? 0 : Number(raw);
        if (!Number.isInteger(value) || value < 0 || value > 1000000) {
          control.focus();
          throw new Error(`Enter a whole number of units for ${line.sku}, or 0.`);
        }
        if (value > 0) received.push({ line, quantity: value });
      }
      if (received.length === 0)
        throw new Error('Enter how many units arrived for at least one product.');
      const over = received.filter((r) => r.quantity > r.line.remaining);
      let allowOver = false;
      if (over.length) {
        allowOver = await confirmDialog({
          title: 'Receive more than you ordered?',
          message: [
            h(
              'ul',
              { class: 'plain-list' },
              over.map((r) =>
                h(
                  'li',
                  {},
                  `${r.line.sku}: ${num(r.quantity)} arrived, ${num(r.line.remaining)} still to come`,
                ),
              ),
            ),
            h('p', {}, 'All of them are added to your stock.'),
          ],
          confirmLabel: 'Receive them all',
        });
        if (!allowOver) {
          throw new Error(
            'More arrived than ordered. Change the numbers, or confirm to receive them all.',
          );
        }
      }
      return api(`/api/purchasing/orders/${order.id}/receive`, {
        method: 'POST',
        body: {
          requestId,
          note: note.value.trim() || undefined,
          lines: received.map((r) => ({ lineId: r.line.id, quantity: r.quantity })),
          allowOver: allowOver || undefined,
        },
        toastErrors: false,
      });
    },
  });
  if (!result) return;
  if (result.duplicate) {
    toast('This delivery was already recorded: nothing was added twice.', { tone: 'info' });
  } else {
    const units = result.receipt?.units ?? 0;
    const waiting = result.waiting ?? [];
    const waitingNote = waiting.length
      ? ` ${waiting.map((w) => w.sku).join(', ')} ${waiting.length === 1 ? 'isn’t' : 'aren’t'} syncing yet: ${waiting.length === 1 ? 'its' : 'their'} units are added when ${waiting.length === 1 ? 'it starts' : 'they start'}.`
      : '';
    toast(
      `Received ${plural(units, 'unit')} on ${order.number}. Every store updates in a few seconds.${waitingNote}`,
    );
  }
  page.reload();
}

async function undoReceipt(order, receipt, page) {
  const done = await confirmDialog({
    title: 'Undo this delivery?',
    message: [
      h(
        'p',
        {},
        `The ${plural(receipt.units, 'unit')} received ${absoluteTime(receipt.createdAt)} are taken out of the shared stock again, and every store goes down by that much.`,
      ),
      h(
        'p',
        { class: 'muted' },
        'Use this for a delivery entered by mistake. Product costs stay as they are.',
      ),
    ],
    confirmLabel: 'Undo delivery',
    tone: 'critical',
    onConfirm: () =>
      api(`/api/purchasing/orders/${order.id}/receipts/${receipt.id}/reverse`, {
        method: 'POST',
        toastErrors: false,
      }),
  });
  if (done) {
    toast(
      `Delivery undone: ${plural(receipt.units, 'unit')} taken out again. Stores update in a few seconds.`,
    );
    page.reload();
  }
}

// ---- page body ----------------------------------------------------------------------------------

function orderBody(data, page) {
  const { order } = data;
  const t = order.totals;
  const foreign = order.currencyCode !== order.baseCurrency;
  return [
    order.supplier.archived &&
      order.allowed.edit !== 'notes' &&
      banner(
        { tone: 'warning', title: `${order.supplier.name} is archived` },
        h('p', {}, 'Restore the supplier on the Suppliers tab, or cancel this order.'),
      ),
    h(
      'div',
      { class: 'stats' },
      statTile({
        label: 'Total',
        value: money(t.total, order.currencyCode),
        note: foreign ? `About ${money(t.totalBase, order.baseCurrency)}` : null,
      }),
      statTile({
        label: 'Units ordered',
        value: num(t.quantityOrdered),
        note: plural(t.lines, 'product'),
      }),
      statTile({
        label: 'Received',
        value:
          order.status === 'draft' || order.status === 'cancelled'
            ? '—'
            : percent(t.receivedFraction),
        note: `${num(t.quantityReceived)} of ${num(t.quantityOrdered)} units`,
        tone: order.status === 'received' ? 'success' : 'neutral',
      }),
      statTile({
        label: order.status === 'received' ? 'Expected' : 'Expected delivery',
        value: order.expectedOn ? dateOnly(order.expectedOn) : '—',
        tone: order.overdue ? 'critical' : 'neutral',
        note: order.overdue ? 'Overdue' : null,
      }),
    ),
    order.allowed.edit === 'notes' ? readOnlyOrder(data, page) : orderEditor(data, page),
    receiptsCard(order, page),
  ];
}

function newOrderBody(data, page) {
  if (data.suppliers.length === 0) {
    return emptyState({
      title: 'Add a supplier first',
      message:
        'A purchase order is for one supplier. Add the companies you buy from, then come back.',
      iconName: 'users',
      action: linkButton('Add a supplier', '#/purchasing?tab=suppliers', { variant: 'primary' }),
    });
  }
  return orderEditor(data, page);
}

/** Received, closed and cancelled orders: the lines as they are, and editable notes. */
function readOnlyOrder({ order }, page) {
  const notes = h('textarea', {
    class: 'input textarea',
    name: 'notes',
    rows: 3,
    maxlength: 2000,
    value: order.notes ?? '',
  });
  const save = button('Save notes', { type: 'submit', size: 'small' });
  const form = h(
    'form',
    { class: 'inline-form' },
    field({ label: 'Notes', control: notes, optional: true }),
    h('div', { class: 'form-actions' }, save),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await withBusy(save, async () => {
      await api(`/api/purchasing/orders/${order.id}`, {
        method: 'PATCH',
        body: { notes: notes.value.trim() },
      });
      toast('Notes saved.');
      await page.reload();
    }).catch(() => {});
  });
  return [
    card({ title: 'Products' }, linesTable(order)),
    h('div', { class: 'grid-2' }, detailsFacts(order), card({ title: 'Notes' }, form)),
  ];
}

function detailsFacts(order) {
  return card(
    { title: 'Supplier' },
    facts([
      ['Supplier', order.supplier.name],
      order.supplier.contactName && ['Contact', order.supplier.contactName],
      order.supplier.email && [
        'Email',
        h('a', { href: `mailto:${order.supplier.email}` }, order.supplier.email),
      ],
      order.supplier.phone && ['Phone', order.supplier.phone],
      ['Delivered to', order.warehouse.name],
      ['Currency', order.currencyCode],
      order.currencyCode !== order.baseCurrency && [
        'Exchange rate',
        `1 ${order.baseCurrency} = ${num(order.exchangeRate)} ${order.currencyCode}`,
      ],
      order.orderedAt && ['Ordered', dateOnly(order.orderedAt)],
      order.closedAt && [
        order.status === 'cancelled' ? 'Cancelled' : 'Closed',
        dateOnly(order.closedAt),
      ],
    ]),
  );
}

function linesTable(order) {
  const columns = [
    productColumn(),
    { label: 'Ordered', align: 'end', render: (l) => num(l.quantityOrdered) },
    { label: 'Received', align: 'end', render: (l) => num(l.quantityReceived) },
    {
      label: 'Not delivered',
      align: 'end',
      render: (l) => (l.remaining ? num(l.remaining) : muted('—')),
    },
    {
      label: 'Unit cost',
      align: 'end',
      render: (l) => h('span', { class: 'num' }, money(l.unitCost, order.currencyCode)),
    },
    {
      label: 'Total',
      align: 'end',
      render: (l) => h('span', { class: 'num' }, money(l.lineTotal, order.currencyCode)),
    },
  ];
  const table = dataTable({
    caption: `Products on ${order.number}`,
    className: 'po-lines',
    columns,
    rows: order.lines,
  });
  appendTotals(table, columns, [
    ['Ordered', num(order.totals.quantityOrdered)],
    ['Received', num(order.totals.quantityReceived)],
    ['Not delivered', order.totals.remaining ? num(order.totals.remaining) : ''],
    null,
    ['Total', money(order.totals.total, order.currencyCode)],
  ]);
  return table;
}

function productColumn() {
  return {
    label: 'Product',
    className: 'col-product',
    render: (l) =>
      h(
        'div',
        { class: 'product-cell' },
        h('a', { class: 'product-link', href: `#/items/${l.itemId}` }, l.title || l.sku),
        h(
          'div',
          { class: 'product-meta' },
          h('span', { class: 'mono' }, l.sku),
          l.supplierSku &&
            h(
              'span',
              { class: 'po-supplier-sku' },
              'Their code ',
              h('span', { class: 'mono' }, l.supplierSku),
            ),
          l.syncing === false && badge('Not syncing yet', 'neutral'),
        ),
      ),
  };
}

/** A totals row at the end of a dataTable: `cells` after the label cell, null = empty. */
function appendTotals(tableWrap, columns, cells) {
  const row = h(
    'tr',
    { role: 'row', class: 'table-totals' },
    h('th', { role: 'rowheader', scope: 'row' }, 'Total'),
    columns.slice(1).map((column, i) => {
      const cell = cells[i];
      return h(
        'td',
        { role: 'cell', class: ['align-end', column.className], 'data-label': cell?.[0] ?? '' },
        cell?.[1] ? h('span', { class: 'num' }, cell[1]) : '',
      );
    }),
  );
  tableWrap.querySelector('tbody').append(row);
  return row;
}

function receiptsCard(order, page) {
  const undoable = order.status !== 'cancelled';
  return card(
    {
      title: 'Deliveries',
      description: 'Each delivery received on this order, newest first.',
      className: 'po-receipts-card',
    },
    order.receipts.length === 0
      ? emptyState({
          title: 'Nothing received yet',
          message: order.allowed.receive
            ? 'When the delivery arrives, click “Receive…” and enter what came.'
            : null,
          iconName: 'truck',
        })
      : h(
          'ul',
          { class: 'compact-list po-receipts' },
          order.receipts.map((r) =>
            h(
              'li',
              { class: ['po-receipt', r.reversedAt && 'is-reversed'] },
              h(
                'div',
                { class: 'variant-row' },
                h(
                  'div',
                  {},
                  h(
                    'p',
                    { class: 'po-receipt-head' },
                    h('span', { class: 'strong' }, `${plural(r.units, 'unit')} received`),
                    h('span', { class: 'muted small' }, absoluteTime(r.createdAt)),
                    r.reversedAt && badge('Undone', 'neutral', 'refresh'),
                  ),
                  h(
                    'p',
                    { class: 'small' },
                    r.lines.map((l, i) => [
                      i > 0 && ', ',
                      h('span', { class: 'mono' }, l.sku),
                      ` × ${num(l.quantity)}`,
                    ]),
                  ),
                  r.note && h('p', { class: 'muted small' }, r.note),
                  r.reversedAt &&
                    h(
                      'p',
                      { class: 'muted small' },
                      `Undone ${absoluteTime(r.reversedAt)}: the units were taken out again.`,
                    ),
                ),
                undoable &&
                  !r.reversedAt &&
                  button('Undo…', {
                    size: 'small',
                    variant: 'plain-critical',
                    attrs: { 'aria-label': `Undo the delivery of ${absoluteTime(r.createdAt)}` },
                    onClick: () => {
                      if (page.dirty()) {
                        toast('Save or undo your changes first.', { tone: 'error' });
                        return;
                      }
                      undoReceipt(order, r, page);
                    },
                  }),
              ),
            ),
          ),
        ),
  );
}

// ---- the editor (new orders, drafts, open orders) -----------------------------------------------

/**
 * One form for the order's details and lines. `mode` 'full' (new or draft: everything) or 'open'
 * (ordered or partly received: expected date, notes and lines; quantities never below what was
 * received). The save bar appears when something changed.
 */
function orderEditor(data, page) {
  const { order, suppliers, warehouses, settings, prefill } = data;
  const mode = !order || order.allowed.edit === 'full' ? 'full' : 'open';
  const base = settings.baseCurrency;
  const supplierById = (id) =>
    suppliers.find((s) => s.id === Number(id)) ??
    (order && order.supplier.id === Number(id) ? order.supplier : null);

  const initialSupplier = order?.supplier.id ?? prefill?.supplierId ?? null;
  const startSupplier = supplierById(initialSupplier);
  const model = {
    supplierId: initialSupplier,
    warehouseId: order?.warehouse.id ?? warehouses[0]?.id ?? null,
    currencyCode: order?.currencyCode ?? startSupplier?.currencyCode ?? base,
    exchangeRate: order?.exchangeRate ?? startSupplier?.exchangeRate ?? null,
    expectedOn: order?.expectedOn ?? '',
    notes: order?.notes ?? '',
    lines: order
      ? order.lines.map((l) => ({ ...l, key: uid('line') }))
      : (prefill?.lines ?? []).map(({ item, quantity }) =>
          newLine(item, quantity, startSupplier, null),
        ),
  };
  if (!order && startSupplier) {
    // Prefilled lines get the chosen supplier's price, in the order's currency.
    model.lines = (prefill?.lines ?? []).map(({ item, quantity }) =>
      newLine(item, quantity, startSupplier, model),
    );
  }
  const snapshot = () => JSON.stringify(payload(model, mode, base));
  const original = order ? snapshot() : null;
  let currencyTouched = Boolean(order);

  const error = h('div', {
    class: 'form-error form-error-large',
    role: 'alert',
    tabindex: '-1',
    hidden: true,
  });
  const showError = (message) => {
    replace(error, icon('error'), h('span', {}, message));
    error.hidden = false;
    error.focus();
  };

  // -- details
  const supplierSelect = select(
    [
      ...(model.supplierId ? [] : [{ value: '', label: 'Choose a supplier…' }]),
      ...suppliers.map((s) => ({ value: String(s.id), label: s.name })),
      ...(order && !suppliers.some((s) => s.id === order.supplier.id)
        ? [{ value: String(order.supplier.id), label: `${order.supplier.name} (archived)` }]
        : []),
    ],
    { value: model.supplierId ? String(model.supplierId) : '', name: 'supplierId', required: true },
  );
  const warehouseSelect = select(
    warehouses.map((w) => ({ value: String(w.id), label: w.name })),
    { value: String(model.warehouseId ?? ''), name: 'warehouseId' },
  );
  const expected = input({
    type: 'date',
    name: 'expectedOn',
    value: model.expectedOn,
    class: 'input input-date',
  });
  const currency = input({
    name: 'currencyCode',
    value: model.currencyCode,
    maxlength: 3,
    required: true,
    autocomplete: 'off',
    spellcheck: 'false',
    class: 'input input-short input-currency',
  });
  const rate = input({
    type: 'text',
    inputmode: 'decimal',
    name: 'exchangeRate',
    value: model.exchangeRate ?? '',
    autocomplete: 'off',
    class: 'input input-short',
  });
  const rateField = field({
    label: 'Exchange rate',
    control: rate,
    hint: 'How many of the order’s currency make 1 of yours.',
  });
  const notes = h('textarea', {
    class: 'input textarea',
    name: 'notes',
    rows: 3,
    maxlength: 2000,
    value: model.notes,
  });

  const refreshRate = () => {
    const code = model.currencyCode;
    rateField.hidden = code === base || !/^[A-Z]{3}$/.test(code);
    const hint = rateField.querySelector('.field-hint');
    const value = parseDecimal(rate.value);
    if (hint)
      hint.textContent =
        value && value > 0
          ? `1 ${base} = ${num(value)} ${code}. Used to turn the unit costs into ${base} for product costs.`
          : `How many ${code} make 1 ${base}.`;
  };

  supplierSelect.addEventListener('change', () => {
    model.supplierId = supplierSelect.value ? Number(supplierSelect.value) : null;
    const supplier = supplierById(model.supplierId);
    if (supplier && !currencyTouched) {
      model.currencyCode = supplier.currencyCode;
      currency.value = supplier.currencyCode;
      if (supplier.exchangeRate) {
        model.exchangeRate = supplier.exchangeRate;
        rate.value = supplier.exchangeRate;
      }
    }
    addButton.disabled = !model.supplierId;
    refreshRate();
    changed();
  });
  warehouseSelect.addEventListener('change', () => {
    model.warehouseId = Number(warehouseSelect.value);
    changed();
  });
  expected.addEventListener('input', () => {
    model.expectedOn = expected.value;
    changed();
  });
  currency.addEventListener('input', () => {
    currencyTouched = true;
    model.currencyCode = currency.value.trim().toUpperCase();
    refreshRate();
    refreshTotals();
    changed();
  });
  rate.addEventListener('input', () => {
    model.exchangeRate = rate.value;
    refreshRate();
    changed();
  });
  notes.addEventListener('input', () => {
    model.notes = notes.value;
    changed();
  });

  const details =
    mode === 'full'
      ? card(
          { title: 'Order details' },
          h(
            'div',
            { class: 'po-fields' },
            field({ label: 'Supplier', control: supplierSelect }),
            warehouses.length > 1 && field({ label: 'Deliver to', control: warehouseSelect }),
            field({ label: 'Expected delivery', control: expected, optional: true }),
            field({
              label: 'Currency',
              control: currency,
              hint: 'Of the unit costs: what the supplier invoices in.',
            }),
            rateField,
          ),
          field({
            label: 'Notes',
            control: notes,
            optional: true,
            hint: 'For you and your team; shown on the printed order.',
          }),
        )
      : h(
          'div',
          { class: 'grid-2' },
          detailsFacts(order),
          card(
            { title: 'Delivery' },
            h(
              'div',
              { class: 'stack' },
              field({ label: 'Expected delivery', control: expected, optional: true }),
              field({ label: 'Notes', control: notes, optional: true }),
            ),
          ),
        );
  refreshRate();

  // -- lines
  const linesHolder = h('div', {});
  const totalsCells = { quantity: null, total: null };
  const addButton = button('Add products…', {
    size: 'small',
    iconName: 'plus',
    disabled: !model.supplierId,
    onClick: async () => {
      const supplier = supplierById(model.supplierId);
      if (!supplier) return;
      const picked = await pickItems(
        supplier,
        model.lines.map((l) => l.itemId),
      );
      if (!picked) return;
      for (const item of picked) model.lines.push(newLine(item, 1, supplier, model));
      renderLines();
      changed();
      linesHolder.querySelector(`[data-key="${model.lines.at(-1)?.key}"]`)?.focus();
    },
  });
  const refreshTotals = () => {
    const quantity = model.lines.reduce((a, l) => a + (Number(l.quantityOrdered) || 0), 0);
    const total = model.lines.reduce((a, l) => a + lineTotal(l), 0);
    if (totalsCells.quantity) totalsCells.quantity.textContent = num(quantity);
    if (totalsCells.total)
      totalsCells.total.textContent = money(total, validCurrency(model.currencyCode, base));
  };
  const renderLines = () => {
    if (model.lines.length === 0) {
      replace(
        linesHolder,
        emptyState({
          title: 'No products yet',
          message: model.supplierId
            ? 'Add the products you are ordering.'
            : 'Choose the supplier first, then add products.',
          iconName: 'box',
        }),
      );
      return;
    }
    const currencyCode = () => validCurrency(model.currencyCode, base);
    const columns = [
      productColumn(),
      {
        label: mode === 'open' ? 'Ordered' : 'Quantity',
        align: 'end',
        render: (l) => {
          const control = input({
            type: 'number',
            min: Math.max(1, l.quantityReceived ?? 0),
            max: 1000000,
            step: 1,
            inputmode: 'numeric',
            class: 'input input-qty',
            value: l.quantityOrdered,
            'aria-label': `Quantity of ${l.sku}`,
            dataset: { key: l.key },
          });
          control.addEventListener('input', () => {
            l.quantityOrdered = control.value;
            updateLineTotal(l);
            refreshTotals();
            changed();
          });
          return control;
        },
      },
      mode === 'open' && {
        label: 'Received',
        align: 'end',
        render: (l) => (l.quantityReceived ? num(l.quantityReceived) : muted('—')),
      },
      {
        label: 'Unit cost',
        align: 'end',
        render: (l) => {
          const control = moneyInput({
            value:
              typeof l.unitCost === 'number'
                ? costText(l.unitCost, currencyCode())
                : (l.unitCost ?? ''),
            placeholder: '0.00',
            'aria-label': `Unit cost of ${l.sku}`,
          });
          control.addEventListener('input', () => {
            l.unitCost = control.value;
            updateLineTotal(l);
            refreshTotals();
            changed();
          });
          return control;
        },
      },
      {
        label: 'Total',
        align: 'end',
        render: (l) => {
          l.totalCell = h('span', { class: 'num' }, money(lineTotal(l), currencyCode()));
          return l.totalCell;
        },
      },
      {
        label: 'Remove',
        className: 'col-actions',
        render: (l) =>
          (l.quantityReceived ?? 0) > 0
            ? null
            : button('Remove', {
                size: 'small',
                variant: 'plain-critical',
                iconName: 'trash',
                attrs: { 'aria-label': `Remove ${l.sku}` },
                onClick: () => {
                  model.lines = model.lines.filter((x) => x !== l);
                  renderLines();
                  changed();
                  addButton.focus();
                },
              }),
      },
    ].filter(Boolean);
    const updateLineTotal = (l) => {
      if (l.totalCell) l.totalCell.textContent = money(lineTotal(l), currencyCode());
    };
    const table = dataTable({
      caption: 'Products on this order',
      className: 'po-lines po-lines-edit',
      columns,
      rows: model.lines,
    });
    const totalsRow = appendTotals(
      table,
      columns,
      columns
        .slice(1)
        .map((c) =>
          c.label === 'Quantity' || c.label === 'Ordered'
            ? [c.label, 'x']
            : c.label === 'Total'
              ? ['Total', 'x']
              : null,
        ),
    );
    const numbers = totalsRow.querySelectorAll('.num');
    totalsCells.quantity = numbers[0] ?? null;
    totalsCells.total = numbers[1] ?? null;
    replace(linesHolder, table);
    refreshTotals();
  };
  renderLines();

  // -- save
  const saveButton = button(order ? 'Save changes' : 'Save draft', {
    type: 'submit',
    variant: 'primary',
  });
  const discard = order
    ? button('Undo changes', { variant: 'plain', onClick: () => page.reload() })
    : linkButton('Cancel', '#/purchasing', { variant: 'plain' });
  const dirtyNote = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const bar = h('div', { class: 'form-actions save-bar' }, saveButton, discard, dirtyNote);
  const changed = () => {
    const dirty = !order || snapshot() !== original;
    bar.classList.toggle('is-dirty', Boolean(order) && dirty);
    saveButton.disabled = Boolean(order) && !dirty;
    if (order) discard.hidden = !dirty;
    dirtyNote.textContent = order && dirty ? 'You have unsaved changes.' : '';
  };
  page.dirty = () => Boolean(order) && snapshot() !== original;
  changed();

  const form = h(
    'form',
    { class: 'stack-lg', novalidate: true },
    error,
    details,
    card(
      {
        title: 'Products',
        description:
          mode === 'open'
            ? 'You can change quantities and prices, and add products. Quantities can’t go below what was received.'
            : null,
        actions: addButton,
      },
      linesHolder,
    ),
    bar,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    let body;
    try {
      body = validate(model, mode, base);
    } catch (err) {
      showError(err.message);
      return;
    }
    const saved = await withBusy(saveButton, () =>
      api(order ? `/api/purchasing/orders/${order.id}` : '/api/purchasing/orders', {
        method: order ? 'PATCH' : 'POST',
        body,
        toastErrors: false,
      }),
    ).catch((err) => {
      showError(err.message);
      return null;
    });
    if (!saved) return;
    if (order) {
      toast('Changes saved.');
      page.reload();
    } else {
      toast(
        `Draft ${saved.number} saved. Mark it as ordered when you send it to ${saved.supplier.name}.`,
      );
      location.hash = `#/purchasing/orders/${saved.id}`;
    }
  });
  return form;
}

/** A line for an item from the picker or a prefill, priced for the supplier and the order. */
function newLine(item, quantity, supplier, model) {
  const currencyCode = model?.currencyCode ?? supplier?.currencyCode;
  const rate =
    Number(parseDecimal(String(model?.exchangeRate ?? supplier?.exchangeRate ?? ''))) || null;
  // `item` comes from the item search (supplierUnitCost) or the product's purchasing info.
  const supplierPrice =
    item.supplierUnitCost ??
    item.suppliers?.find((s) => s.supplierId === supplier?.id)?.unitCost ??
    null;
  let unitCost = null;
  if (supplierPrice !== null && supplier && supplier.currencyCode === currencyCode)
    unitCost = supplierPrice;
  else if (item.cost !== null && item.cost !== undefined && rate)
    unitCost = Math.round(item.cost * rate * 10000) / 10000;
  return {
    key: uid('line'),
    itemId: item.itemId,
    sku: item.sku,
    title: item.title,
    supplierSku:
      item.supplierSku ??
      item.suppliers?.find((s) => s.supplierId === supplier?.id)?.supplierSku ??
      null,
    quantityOrdered: quantity,
    quantityReceived: 0,
    unitCost,
  };
}

const lineTotal = (l) => {
  const qty = Number(l.quantityOrdered);
  const cost = parseDecimal(String(l.unitCost ?? ''));
  return Number.isFinite(qty) && Number.isFinite(cost) && cost !== null ? qty * cost : 0;
};

const validCurrency = (code, base) => (/^[A-Z]{3}$/.test(code) ? code : base);

/** What the API gets (also used to tell whether anything changed). */
function payload(model, mode, base) {
  const lines = model.lines.map((l) => ({
    ...(l.id ? { id: l.id } : {}),
    itemId: l.itemId,
    quantityOrdered: Number(l.quantityOrdered),
    unitCost: parseDecimal(String(l.unitCost ?? '')) ?? 0,
  }));
  const common = { expectedOn: model.expectedOn || null, notes: (model.notes ?? '').trim(), lines };
  if (mode === 'open') return common;
  return {
    supplierId: model.supplierId,
    warehouseId: model.warehouseId,
    currencyCode: model.currencyCode,
    ...(model.currencyCode !== base
      ? { exchangeRate: parseDecimal(String(model.exchangeRate ?? '')) }
      : {}),
    ...common,
  };
}

/** The payload, or an Error with a sentence that says what to fix. */
function validate(model, mode, base) {
  if (mode === 'full') {
    if (!model.supplierId) throw new Error('Choose the supplier.');
    if (!/^[A-Z]{3}$/.test(model.currencyCode))
      throw new Error('Enter a 3-letter currency code, like USD.');
    if (model.currencyCode !== base) {
      const rate = parseDecimal(String(model.exchangeRate ?? ''));
      if (!rate || !(rate > 0)) {
        throw new Error(`Enter the exchange rate: how many ${model.currencyCode} make 1 ${base}.`);
      }
    }
  }
  for (const l of model.lines) {
    const qty = Number(l.quantityOrdered);
    const min = Math.max(1, l.quantityReceived ?? 0);
    if (!Number.isInteger(qty) || qty < min || qty > 1000000) {
      throw new Error(
        (l.quantityReceived ?? 0) > 0
          ? `${l.sku}: ${num(l.quantityReceived)} were already received, so order at least ${num(l.quantityReceived)}.`
          : `Enter a whole number of units for ${l.sku}, at least 1.`,
      );
    }
    const cost = parseDecimal(String(l.unitCost ?? ''));
    if (Number.isNaN(cost) || (cost !== null && cost < 0)) {
      throw new Error(
        `Enter the unit cost of ${l.sku} as a number, like 12.50 (or leave it empty).`,
      );
    }
  }
  if (mode === 'open' && model.lines.length === 0) {
    throw new Error('An ordered purchase order needs at least one product. Cancel it instead.');
  }
  return payload(model, mode, base);
}

/** Search-and-tick dialog: returns the chosen products (with the supplier's prices) or null. */
async function pickItems(supplier, onOrder) {
  const searchInput = input({
    type: 'search',
    placeholder: 'SKU, name or the supplier’s code',
    autocomplete: 'off',
  });
  const results = h('div', { class: 'picker-results' });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const chosenNote = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const chosen = new Map();
  let controller = null;
  const search = async () => {
    controller?.abort();
    controller = new AbortController();
    results.setAttribute('aria-busy', 'true');
    try {
      const items = await api(
        `/api/purchasing/item-search${qs({ search: searchInput.value.trim(), supplierId: supplier.id })}`,
        { signal: controller.signal },
      );
      announcer.textContent = `${plural(items.length, 'product')} found`;
      replace(
        results,
        items.length === 0
          ? muted('No products found. Try another SKU or name.')
          : h(
              'fieldset',
              { class: 'picker' },
              h('legend', { class: 'sr-only' }, 'Products'),
              items.map((item) => {
                const id = uid('pick');
                const taken = onOrder.includes(item.itemId);
                const box = h('input', {
                  type: 'checkbox',
                  id,
                  value: String(item.itemId),
                  checked: chosen.has(item.itemId),
                  disabled: taken,
                });
                box.addEventListener('change', () => {
                  if (box.checked) chosen.set(item.itemId, item);
                  else chosen.delete(item.itemId);
                  chosenNote.textContent = chosen.size
                    ? `${plural(chosen.size, 'product')} chosen`
                    : '';
                });
                const price =
                  item.supplierUnitCost !== null
                    ? `${money(item.supplierUnitCost, supplier.currencyCode)} from ${supplier.name}`
                    : null;
                return h(
                  'label',
                  { class: ['picker-option', taken && 'is-disabled'], for: id },
                  box,
                  h(
                    'span',
                    { class: 'picker-option-body' },
                    h('span', { class: 'strong' }, item.title || item.sku),
                    h(
                      'span',
                      { class: 'muted small' },
                      h('span', { class: 'mono' }, item.sku),
                      item.available !== null
                        ? ` · ${num(item.available)} in stock`
                        : ' · not syncing yet',
                      price ? ` · ${price}` : '',
                    ),
                    taken && h('span', { class: 'small text-warning' }, 'Already on this order'),
                  ),
                );
              }),
            ),
      );
    } catch (err) {
      if (!isAbort(err)) replace(results, h('p', { class: 'field-error' }, err.message));
    } finally {
      results.removeAttribute('aria-busy');
    }
  };
  searchInput.addEventListener('input', debounce(search, 250));
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      search();
    }
  });
  search();
  const picked = await formDialog({
    title: 'Add products',
    intro: h(
      'p',
      {},
      `Products from ${supplier.name} come first. Tick every product you are ordering.`,
    ),
    content: [
      field({ label: 'Search products', control: searchInput }),
      announcer,
      results,
      chosenNote,
    ],
    initialFocus: () => searchInput,
    submitLabel: 'Add to order',
    onSubmit: () => {
      if (chosen.size === 0) throw new Error('Tick at least one product.');
      return [...chosen.values()];
    },
  });
  controller?.abort();
  return picked;
}
