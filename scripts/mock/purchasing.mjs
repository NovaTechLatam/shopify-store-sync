// Mock API for Purchasing (/api/purchasing/...), plugged into ../dashboard-mock-api.mjs. Same
// routes and response shapes as src/http/api/purchasing.ts, with suppliers, purchase orders in
// every status (one with an undone delivery), and reorder rows with and without a supplier.

const DAY = 86_400_000;
const daysFromNow = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const daysAgoIso = (n) => new Date(Date.now() - n * DAY).toISOString();
const round4 = (n) => Math.round(n * 10_000) / 10_000;
const OPEN = ['ordered', 'partial'];
const UNFINISHED = ['draft', 'ordered', 'partial'];

/** Units a day each product sells (all stores together): made up, but stable. */
function velocityOf(item) {
  if (item.sku.startsWith('JKT')) return 2.4;
  if (item.sku.startsWith('CAP')) return 0;
  return ((item.id * 37) % 45) / 10;
}

/** The same maths as src/purchasing/reorder.ts (computeReorder). */
function computeReorder(i) {
  const tidy = (n) => Math.round(n * 1e6) / 1e6;
  const velocity = i.velocity;
  if (velocity <= 0) {
    return { velocity: 0, daysLeft: null, coverageDays: null, needsReorder: false, suggested: 0 };
  }
  const position = i.available + i.onOrder;
  const daysLeft = Math.max(0, i.available) / velocity;
  const coverageDays = Math.max(0, position) / velocity;
  const needsReorder = tidy(position / velocity) <= i.leadTimeDays + i.safetyDays;
  if (!needsReorder) return { velocity, daysLeft, coverageDays, needsReorder, suggested: 0 };
  const days = i.leadTimeDays + Math.max(i.coverDays, i.safetyDays);
  let q = Math.max(1, Math.ceil(tidy(velocity * days - position)));
  if (i.minOrderQty && q < i.minOrderQty) q = i.minOrderQty;
  if (i.packSize && i.packSize > 1) q = Math.ceil(q / i.packSize) * i.packSize;
  return { velocity, daysLeft, coverageDays, needsReorder, suggested: q };
}

export function seed(state, { minutesAgo }) {
  const suppliers = [
    {
      id: 1,
      name: 'Acme Textiles',
      contactName: 'Dana Ruiz',
      email: 'orders@acmetextiles.example',
      phone: '+1 212 555 0148',
      currencyCode: 'USD',
      leadTimeDays: 21,
      notes: 'Orders over $2,000 ship free. Send purchase orders by email before noon.',
      archivedAt: null,
      createdAt: minutesAgo(60 * 24 * 200),
    },
    {
      id: 2,
      name: 'Bogotá Knits',
      contactName: 'Camilo Rojas',
      email: 'ventas@bogotaknits.example',
      phone: null,
      currencyCode: 'COP',
      leadTimeDays: 30,
      notes: null,
      archivedAt: null,
      createdAt: minutesAgo(60 * 24 * 150),
    },
    {
      id: 3,
      name: 'Capital Caps Co.',
      contactName: null,
      email: 'hello@capitalcaps.example',
      phone: '+44 20 7946 0321',
      currencyCode: 'USD',
      leadTimeDays: 10,
      notes: null,
      archivedAt: null,
      createdAt: minutesAgo(60 * 24 * 120),
    },
    {
      id: 4,
      name: 'Old Mill Supply',
      contactName: null,
      email: null,
      phone: null,
      currencyCode: 'USD',
      leadTimeDays: 45,
      notes: 'We stopped buying from them in spring.',
      archivedAt: minutesAgo(60 * 24 * 90),
      createdAt: minutesAgo(60 * 24 * 400),
    },
  ];

  // Purchasing fields of each product (items of the core mock), and what suppliers sell.
  const itemInfo = {};
  const supplierItems = [];
  const familyOf = (sku) => sku.split('-').slice(0, 2).join('-');
  const SUPPLIER_OF = { 'TEE-ORG': 1, 'HOOD-CLS': 1, 'SOCK-MER': 2, 'CAP-WAX': 3, 'TOTE-CNV': 3 };
  const BASE_COST = {
    'TEE-ORG': 6.4,
    'HOOD-CLS': 18.5,
    'SOCK-MER': 3.1,
    'CAP-WAX': 7.25,
    'TOTE-CNV': 4.8,
    'JKT-RAIN': 27,
  };
  for (const item of state.items) {
    const family = familyOf(item.sku);
    const supplierId = SUPPLIER_OF[family] ?? null;
    itemInfo[item.id] = {
      cost: BASE_COST[family] ?? null,
      costUpdatedAt: BASE_COST[family] ? minutesAgo(60 * 24 * ((item.id % 20) + 2)) : null,
      supplierId,
      leadTimeDays: item.id === 2 ? 7 : null,
      reorderCoverDays: null,
      reorderEnabled: item.id !== 12,
    };
    if (supplierId) {
      const supplier = suppliers.find((s) => s.id === supplierId);
      supplierItems.push({
        supplierId,
        itemId: item.id,
        supplierSku: `${supplier.name.slice(0, 2).toUpperCase()}-${item.sku}`,
        unitCost:
          supplier.currencyCode === 'COP'
            ? Math.round(BASE_COST[family] * 4100)
            : BASE_COST[family],
        minOrderQty: family === 'SOCK-MER' ? 48 : null,
        packSize: family === 'SOCK-MER' ? 12 : family === 'TEE-ORG' ? 6 : null,
        updatedAt: minutesAgo(60 * 24 * 30),
      });
    }
  }

  const bySku = (sku) => state.items.find((i) => i.sku === sku);
  const line = (id, sku, ordered, received, unitCost) => ({
    id,
    itemId: bySku(sku).id,
    quantityOrdered: ordered,
    quantityReceived: received,
    unitCost,
  });
  const receipt = (id, createdAt, lines, extra = {}) => ({
    id,
    requestId: `seed-${id}`,
    note: null,
    createdAt,
    reversedAt: null,
    lines: lines.map(([lineId, quantity]) => ({ lineId, quantity })),
    ...extra,
  });
  const order = (o) => ({
    warehouseId: 1,
    currencyCode: 'USD',
    exchangeRate: 1,
    notes: null,
    orderedAt: null,
    closedAt: null,
    receipts: [],
    updatedAt: o.createdAt,
    ...o,
  });
  const orders = [
    order({
      id: 1,
      number: 'PO-0001',
      supplierId: 1,
      status: 'received',
      expectedOn: daysFromNow(-70),
      orderedAt: daysAgoIso(95),
      createdAt: daysAgoIso(96),
      lines: [line(1, 'TEE-ORG-BLA-S', 60, 60, 6.1), line(2, 'TEE-ORG-BLA-M', 60, 60, 6.1)],
      receipts: [
        receipt(1, daysAgoIso(72), [
          [1, 60],
          [2, 60],
        ]),
      ],
    }),
    order({
      id: 2,
      number: 'PO-0002',
      supplierId: 1,
      status: 'cancelled',
      expectedOn: daysFromNow(-40),
      notes: 'Duplicate of PO-0003, sent by mistake.',
      orderedAt: daysAgoIso(60),
      closedAt: daysAgoIso(59),
      createdAt: daysAgoIso(61),
      lines: [line(3, 'HOOD-CLS-NAV-M', 20, 0, 18.5)],
    }),
    order({
      id: 3,
      number: 'PO-0003',
      supplierId: 3,
      status: 'closed',
      expectedOn: daysFromNow(-30),
      notes: 'Olive caps were discontinued by the supplier: the rest isn’t coming.',
      orderedAt: daysAgoIso(55),
      closedAt: daysAgoIso(25),
      createdAt: daysAgoIso(56),
      lines: [line(4, 'CAP-WAX-OLI-S', 30, 18, 7.25), line(5, 'CAP-WAX-OLI-M', 30, 30, 7.25)],
      receipts: [
        receipt(
          2,
          daysAgoIso(31),
          [
            [4, 18],
            [5, 30],
          ],
          { note: 'Short shipment' },
        ),
      ],
    }),
    order({
      id: 4,
      number: 'PO-0004',
      supplierId: 2,
      status: 'received',
      currencyCode: 'COP',
      exchangeRate: 4100,
      expectedOn: daysFromNow(-12),
      orderedAt: daysAgoIso(45),
      createdAt: daysAgoIso(46),
      lines: [line(6, 'SOCK-MER-GRE-M', 96, 96, 12_710), line(7, 'SOCK-MER-RUS-M', 48, 48, 12_710)],
      receipts: [
        receipt(
          3,
          daysAgoIso(13),
          [
            [6, 96],
            [7, 48],
          ],
          { note: 'Invoice FV-2231' },
        ),
      ],
    }),
    order({
      id: 5,
      number: 'PO-0005',
      supplierId: 1,
      status: 'partial',
      expectedOn: daysFromNow(4),
      notes: 'The second box ships separately.',
      orderedAt: daysAgoIso(20),
      createdAt: daysAgoIso(21),
      lines: [
        line(8, 'TEE-ORG-WHI-S', 48, 24, 6.4),
        line(9, 'TEE-ORG-WHI-M', 48, 48, 6.4),
        line(10, 'HOOD-CLS-OAT-L', 24, 0, 18.5),
      ],
      receipts: [
        receipt(
          4,
          daysAgoIso(2),
          [
            [8, 24],
            [9, 48],
          ],
          { note: 'Box 1 of 2' },
        ),
        receipt(5, daysAgoIso(3), [[10, 12]], {
          note: 'Entered on the wrong order',
          reversedAt: new Date(Date.now() - 3 * DAY + 600_000).toISOString(),
        }),
      ],
    }),
    order({
      id: 6,
      number: 'PO-0006',
      supplierId: 3,
      status: 'ordered',
      expectedOn: daysFromNow(-5),
      orderedAt: daysAgoIso(16),
      createdAt: daysAgoIso(16),
      lines: [line(11, 'TOTE-CNV-NAT-M', 40, 0, 4.8), line(12, 'TOTE-CNV-NAT-L', 40, 0, 4.8)],
    }),
    order({
      id: 7,
      number: 'PO-0007',
      supplierId: 1,
      status: 'draft',
      expectedOn: daysFromNow(25),
      createdAt: daysAgoIso(1),
      lines: [line(13, 'HOOD-CLS-NAV-S', 12, 0, 18.5), line(14, 'HOOD-CLS-NAV-L', 12, 0, 18.5)],
    }),
  ];

  state.purchasing = {
    suppliers,
    supplierItems,
    itemInfo,
    orders,
    nextIds: { supplier: 5, order: 8, line: 15, receipt: 6 },
    // Flows set this to show the "no sales history yet" state.
    noSales: false,
  };

  // Activity: the deliveries (and the undone one) as the engine logs them.
  for (const o of orders) {
    const supplier = suppliers.find((s) => s.id === o.supplierId);
    for (const r of o.receipts) {
      const details = {
        purchaseOrderId: o.id,
        number: o.number,
        supplierName: supplier.name,
        receiptId: r.id,
      };
      for (const rl of r.lines) {
        const item = state.items.find(
          (i) => i.id === o.lines.find((l) => l.id === rl.lineId).itemId,
        );
        const before = Math.max(rl.quantity, item.quantity ?? 0) - rl.quantity;
        state.events.push({
          kind: 'po_received',
          itemId: item.id,
          sku: item.sku,
          storeId: null,
          storeName: null,
          delta: rl.quantity,
          quantityBefore: before,
          quantityAfter: before + rl.quantity,
          message: `Received ${rl.quantity} on ${o.number} from ${supplier.name}`,
          details,
          createdAt: r.createdAt,
        });
        if (r.reversedAt) {
          state.events.push({
            kind: 'po_receipt_reversed',
            itemId: item.id,
            sku: item.sku,
            storeId: null,
            storeName: null,
            delta: -rl.quantity,
            quantityBefore: before + rl.quantity,
            quantityAfter: before,
            message: `Undid the delivery of ${rl.quantity} on ${o.number} from ${supplier.name}`,
            details,
            createdAt: r.reversedAt,
          });
        }
      }
    }
  }
  // Keep the activity in time order, with ids rising with time like the real log.
  state.events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  state.events.forEach((e, i) => (e.id = i + 1));

  // Open reorder alerts, as reorder_check raises them.
  for (const row of reorderRows(state)
    .filter((r) => r.needsReorder)
    .slice(0, 3)) {
    state.alerts.push({
      id: state.nextIds.alert++,
      kind: 'reorder',
      itemId: row.itemId,
      storeId: null,
      message: reorderMessage(row),
      createdAt: minutesAgo(45),
      notifiedAt: minutesAgo(44),
      resolvedAt: null,
    });
  }
}

// ---------- read models (mirror src/purchasing) ----------

function suggestedRate(state, currency) {
  if (currency === state.settings.baseCurrency) return 1;
  const order = [...state.purchasing.orders].reverse().find((o) => o.currencyCode === currency);
  if (order) return order.exchangeRate;
  return state.stores.find((s) => s.currencyCode === currency)?.exchangeRate ?? null;
}

function supplierView(state, s) {
  const p = state.purchasing;
  const orders = p.orders.filter((o) => o.supplierId === s.id);
  return {
    ...s,
    updatedAt: s.createdAt,
    itemCount: p.supplierItems.filter((si) => si.supplierId === s.id).length,
    preferredCount: Object.values(p.itemInfo).filter((i) => i.supplierId === s.id).length,
    openOrders: orders.filter((o) => UNFINISHED.includes(o.status)).length,
    orderCount: orders.length,
    exchangeRate: suggestedRate(state, s.currencyCode),
  };
}

function supplierItemsView(state, supplierId) {
  const p = state.purchasing;
  return p.supplierItems
    .filter((si) => si.supplierId === supplierId)
    .map((si) => {
      const item = state.items.find((i) => i.id === si.itemId);
      return {
        itemId: si.itemId,
        sku: item.sku,
        title: item.title,
        supplierSku: si.supplierSku,
        unitCost: si.unitCost,
        minOrderQty: si.minOrderQty,
        packSize: si.packSize,
        preferred: p.itemInfo[si.itemId]?.supplierId === supplierId,
        cost: p.itemInfo[si.itemId]?.cost ?? null,
        updatedAt: si.updatedAt,
      };
    })
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

const fullSupplier = (state, s) => ({
  ...supplierView(state, s),
  items: supplierItemsView(state, s.id),
});

const remainingOf = (l) => Math.max(0, l.quantityOrdered - l.quantityReceived);

function orderView(state, o) {
  const p = state.purchasing;
  const supplier = p.suppliers.find((s) => s.id === o.supplierId);
  const warehouse = state.warehouses.find((w) => w.id === o.warehouseId) ?? state.warehouses[0];
  const lines = o.lines.map((l) => {
    const item = state.items.find((i) => i.id === l.itemId);
    const si = p.supplierItems.find((x) => x.supplierId === o.supplierId && x.itemId === l.itemId);
    return {
      id: l.id,
      itemId: l.itemId,
      sku: item.sku,
      title: item.title,
      supplierSku: si?.supplierSku ?? null,
      quantityOrdered: l.quantityOrdered,
      quantityReceived: l.quantityReceived,
      remaining: remainingOf(l),
      unitCost: l.unitCost,
      lineTotal: round4(l.quantityOrdered * l.unitCost),
      syncing: item.quantity !== null,
    };
  });
  const sum = (f) => lines.reduce((a, l) => a + f(l), 0);
  const quantityOrdered = sum((l) => l.quantityOrdered);
  const total = round4(sum((l) => l.lineTotal));
  const received = sum((l) => l.quantityReceived);
  const today = new Date().toISOString().slice(0, 10);
  const s = o.status;
  return {
    id: o.id,
    number: o.number,
    status: s,
    supplier: {
      id: supplier.id,
      name: supplier.name,
      contactName: supplier.contactName,
      email: supplier.email,
      phone: supplier.phone,
      currencyCode: supplier.currencyCode,
      archived: Boolean(supplier.archivedAt),
    },
    warehouse: { id: warehouse.id, name: warehouse.name },
    currencyCode: o.currencyCode,
    exchangeRate: o.exchangeRate,
    baseCurrency: state.settings.baseCurrency,
    expectedOn: o.expectedOn,
    overdue: Boolean(o.expectedOn && o.expectedOn < today && OPEN.includes(s)),
    notes: o.notes,
    orderedAt: o.orderedAt,
    closedAt: o.closedAt,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    lines,
    totals: {
      lines: lines.length,
      quantityOrdered,
      quantityReceived: received,
      remaining: sum((l) => l.remaining),
      total,
      totalBase: round4(total / o.exchangeRate),
      receivedFraction:
        quantityOrdered > 0
          ? sum((l) => Math.min(l.quantityReceived, l.quantityOrdered)) / quantityOrdered
          : 0,
    },
    receipts: [...o.receipts]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
      .map((r) => ({
        id: r.id,
        note: r.note,
        createdAt: r.createdAt,
        reversedAt: r.reversedAt,
        units: r.lines.reduce((a, l) => a + l.quantity, 0),
        lines: r.lines.map((rl) => {
          const l = lines.find((x) => x.id === rl.lineId);
          return {
            lineId: rl.lineId,
            itemId: l.itemId,
            sku: l.sku,
            title: l.title,
            quantity: rl.quantity,
          };
        }),
      })),
    allowed: {
      edit: s === 'draft' ? 'full' : OPEN.includes(s) ? 'open' : 'notes',
      order: s === 'draft' && lines.length > 0,
      receive: UNFINISHED.includes(s) && lines.length > 0,
      close: OPEN.includes(s),
      cancel: ['draft', 'ordered'].includes(s) && received === 0,
      delete: s === 'draft',
    },
  };
}

function listRow(state, o) {
  const v = orderView(state, o);
  return {
    id: v.id,
    number: v.number,
    status: v.status,
    supplier: { id: v.supplier.id, name: v.supplier.name },
    warehouse: v.warehouse,
    currencyCode: v.currencyCode,
    exchangeRate: v.exchangeRate,
    expectedOn: v.expectedOn,
    overdue: v.overdue,
    createdAt: v.createdAt,
    orderedAt: v.orderedAt,
    updatedAt: v.updatedAt,
    lines: v.totals.lines,
    quantityOrdered: v.totals.quantityOrdered,
    quantityReceived: v.totals.quantityReceived,
    total: v.totals.total,
    receivedFraction: v.totals.receivedFraction,
  };
}

function onOrderOf(state, itemId) {
  return state.purchasing.orders
    .filter((o) => OPEN.includes(o.status))
    .flatMap((o) => o.lines)
    .filter((l) => l.itemId === itemId)
    .reduce((a, l) => a + remainingOf(l), 0);
}

function reorderRows(state) {
  const p = state.purchasing;
  const settings = state.settings;
  return state.items
    .filter((item) => item.syncEnabled)
    .map((item) => {
      const info = p.itemInfo[item.id];
      const supplier = p.suppliers.find((s) => s.id === info.supplierId && !s.archivedAt) ?? null;
      const si = supplier
        ? p.supplierItems.find((x) => x.supplierId === supplier.id && x.itemId === item.id)
        : null;
      const leadTimeSource =
        info.leadTimeDays !== null
          ? 'item'
          : supplier && supplier.leadTimeDays !== null
            ? 'supplier'
            : 'default';
      const leadTimeDays =
        info.leadTimeDays ?? supplier?.leadTimeDays ?? settings.reorderDefaultLeadTimeDays;
      const coverDays = info.reorderCoverDays ?? settings.reorderCoverDays;
      const stockKnown = item.quantity !== null;
      const available = item.quantity ?? 0;
      const velocity = velocityOf(item);
      const onOrder = onOrderOf(state, item.id);
      const figures = computeReorder({
        velocity,
        available,
        onOrder,
        leadTimeDays,
        coverDays,
        safetyDays: settings.reorderSafetyDays,
        minOrderQty: si?.minOrderQty ?? null,
        packSize: si?.packSize ?? null,
      });
      const counts = stockKnown && info.reorderEnabled;
      return {
        ...figures,
        needsReorder: counts && figures.needsReorder,
        suggested: counts ? figures.suggested : 0,
        itemId: item.id,
        sku: item.sku,
        title: item.title,
        reorderEnabled: info.reorderEnabled,
        stockKnown,
        available,
        unitsSold: Math.round(velocity * settings.reorderLookbackDays),
        windowDays: settings.reorderLookbackDays,
        onOrder,
        leadTimeDays,
        leadTimeSource,
        coverDays,
        stockoutOn:
          stockKnown && figures.daysLeft !== null
            ? daysFromNow(Math.floor(figures.daysLeft))
            : null,
        supplier: supplier
          ? { id: supplier.id, name: supplier.name, currencyCode: supplier.currencyCode }
          : null,
        supplierSku: si?.supplierSku ?? null,
        supplierUnitCost: si?.unitCost ?? null,
        minOrderQty: si?.minOrderQty ?? null,
        packSize: si?.packSize ?? null,
        cost: info.cost,
      };
    });
}

/** The same sentence as src/purchasing/reorder.ts (reorderMessage). */
function reorderMessage(row) {
  const pace = `${Number(row.velocity.toFixed(1))} a day`;
  const days = Math.floor(row.daysLeft ?? 0);
  const units = (n) => `${n} ${n === 1 ? 'unit' : 'units'}`;
  const start =
    row.available <= 0
      ? `${row.sku} is out of stock and sells about ${pace}.`
      : row.daysLeft < 1
        ? `${row.sku} will run out in less than a day at the current pace (${pace}).`
        : `${row.sku} will run out in about ${days} ${days === 1 ? 'day' : 'days'} at the current pace (${pace}).`;
  const onOrder =
    row.onOrder > 0
      ? ` ${units(row.onOrder)} ${row.onOrder === 1 ? 'is' : 'are'} already on order.`
      : '';
  const order = row.supplier
    ? `Suggested order: ${units(row.suggested)} from ${row.supplier.name}.`
    : `Suggested order: ${units(row.suggested)} (choose a supplier for it).`;
  return `${start}${onOrder} Lead time is ${row.leadTimeDays} ${row.leadTimeDays === 1 ? 'day' : 'days'}. ${order}`;
}

function itemPurchasing(state, itemId) {
  const p = state.purchasing;
  const item = state.items.find((i) => i.id === itemId);
  const info = p.itemInfo[itemId];
  const supplier = p.suppliers.find((s) => s.id === info.supplierId) ?? null;
  return {
    itemId,
    sku: item.sku,
    title: item.title,
    baseCurrency: state.settings.baseCurrency,
    cost: info.cost,
    costUpdatedAt: info.costUpdatedAt,
    costMethod: state.settings.costMethod,
    supplier: supplier ? { id: supplier.id, name: supplier.name } : null,
    leadTimeDays: info.leadTimeDays,
    reorderCoverDays: info.reorderCoverDays,
    reorderEnabled: info.reorderEnabled,
    syncEnabled: item.syncEnabled,
    defaults: {
      leadTimeDays: state.settings.reorderDefaultLeadTimeDays,
      coverDays: state.settings.reorderCoverDays,
      safetyDays: state.settings.reorderSafetyDays,
      lookbackDays: state.settings.reorderLookbackDays,
    },
    reorder: reorderRows(state).find((r) => r.itemId === itemId) ?? null,
    suppliers: p.supplierItems
      .filter((si) => si.itemId === itemId)
      .map((si) => {
        const s = p.suppliers.find((x) => x.id === si.supplierId);
        return {
          supplierId: s.id,
          name: s.name,
          currencyCode: s.currencyCode,
          leadTimeDays: s.leadTimeDays,
          supplierSku: si.supplierSku,
          unitCost: si.unitCost,
          minOrderQty: si.minOrderQty,
          packSize: si.packSize,
          preferred: s.id === info.supplierId,
        };
      }),
    orders: p.orders
      .filter((o) => UNFINISHED.includes(o.status))
      .flatMap((o) =>
        o.lines
          .filter((l) => l.itemId === itemId)
          .map((l) => ({
            id: o.id,
            number: o.number,
            status: o.status,
            supplierName: p.suppliers.find((s) => s.id === o.supplierId).name,
            expectedOn: o.expectedOn,
            quantityOrdered: l.quantityOrdered,
            quantityReceived: l.quantityReceived,
            remaining: remainingOf(l),
          })),
      ),
  };
}

// ---------- writes ----------

function defaultCost(state, order, itemId) {
  const p = state.purchasing;
  const si = p.supplierItems.find((x) => x.supplierId === order.supplierId && x.itemId === itemId);
  const supplier = p.suppliers.find((s) => s.id === order.supplierId);
  if (si && si.unitCost !== null && supplier.currencyCode === order.currencyCode)
    return si.unitCost;
  const cost = p.itemInfo[itemId]?.cost;
  return cost !== null && cost !== undefined ? round4(cost * order.exchangeRate) : 0;
}

function replaceLines(state, order, input, HttpError) {
  const seen = new Set();
  const next = [];
  for (const l of input) {
    const item = state.items.find((i) => i.id === l.itemId);
    if (!item) throw new HttpError(400, 'A product on the order no longer exists.');
    if (seen.has(l.itemId)) {
      throw new HttpError(400, `${item.sku} is on the order twice. Keep one line for it.`);
    }
    seen.add(l.itemId);
    if (!Number.isInteger(l.quantityOrdered) || l.quantityOrdered < 1) {
      throw new HttpError(400, 'lines.quantityOrdered: Too small: expected number to be >=1');
    }
    const match = l.id
      ? order.lines.find((x) => x.id === l.id)
      : order.lines.find((x) => x.itemId === l.itemId);
    if (match) {
      if (l.quantityOrdered < match.quantityReceived) {
        throw new HttpError(
          400,
          `${item.sku}: ${match.quantityReceived} were already received, so at least ${match.quantityReceived} must stay on the order.`,
        );
      }
      next.push({
        ...match,
        quantityOrdered: l.quantityOrdered,
        unitCost: l.unitCost ?? match.unitCost,
      });
    } else {
      next.push({
        id: state.purchasing.nextIds.line++,
        itemId: l.itemId,
        quantityOrdered: l.quantityOrdered,
        quantityReceived: 0,
        unitCost: l.unitCost ?? defaultCost(state, order, l.itemId),
      });
    }
  }
  for (const old of order.lines) {
    if (!next.some((l) => l.id === old.id) && old.quantityReceived > 0) {
      const sku = state.items.find((i) => i.id === old.itemId).sku;
      throw new HttpError(400, `${sku} can’t be removed: units of it were already received.`);
    }
  }
  order.lines = next;
}

function statusAfterReceiving(order) {
  const any = order.lines.some((l) => l.quantityReceived > 0);
  const all = order.lines.every((l) => l.quantityReceived >= l.quantityOrdered);
  return !any ? 'ordered' : all ? 'received' : 'partial';
}

/** What the engine does with the adjustment: the shared stock moves, the activity log says so. */
function logEvent(state, kind, item, delta, message, details) {
  const before = item.quantity;
  if (item.quantity !== null && item.syncEnabled) item.quantity += delta;
  state.events.push({
    id: (state.events.at(-1)?.id ?? 0) + 1,
    kind,
    itemId: item.id,
    sku: item.sku,
    storeId: null,
    storeName: null,
    delta,
    quantityBefore: before,
    quantityAfter: item.quantity,
    message,
    details,
    createdAt: new Date().toISOString(),
  });
}

function createOrder(state, body, HttpError) {
  const p = state.purchasing;
  const supplier = p.suppliers.find((s) => s.id === body.supplierId);
  if (!supplier) throw new HttpError(400, 'Choose a supplier from the list');
  if (supplier.archivedAt) {
    throw new HttpError(
      409,
      `“${supplier.name}” is archived. Restore it on the Suppliers tab first.`,
    );
  }
  const currencyCode = body.currencyCode ?? supplier.currencyCode;
  const base = state.settings.baseCurrency;
  const exchangeRate = currencyCode === base ? 1 : body.exchangeRate;
  if (!exchangeRate) {
    throw new HttpError(400, `Enter the exchange rate: how many ${currencyCode} make 1 ${base}.`);
  }
  const id = p.nextIds.order++;
  const now = new Date().toISOString();
  const order = {
    id,
    number: `PO-${String(id).padStart(4, '0')}`,
    supplierId: supplier.id,
    warehouseId: body.warehouseId ?? state.warehouses[0].id,
    status: 'draft',
    currencyCode,
    exchangeRate,
    expectedOn: body.expectedOn ?? null,
    notes: body.notes || null,
    orderedAt: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
    lines: [],
    receipts: [],
  };
  replaceLines(state, order, body.lines ?? [], HttpError);
  p.orders.push(order);
  return order;
}

function orderCsv(order) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    const text = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [
    ['Order', 'Supplier', 'Status', 'Currency', 'SKU', 'Supplier SKU', 'Product', 'Ordered'],
    ...order.lines.map((l) => [
      order.number,
      order.supplier.name,
      order.status,
      order.currencyCode,
      l.sku,
      l.supplierSku,
      l.title,
      l.quantityOrdered,
    ]),
  ];
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ---------- routes ----------

export function handle(req, { reply, HttpError, paginate, matches, findOr404 }) {
  const { method, route, parts, id, subId, query, body, state } = req;
  if (parts[0] !== 'purchasing') return undefined;
  const p = state.purchasing;
  const findOrder = (orderId) => findOr404(p.orders, orderId, 'Purchase order');
  const findSupplier = (supplierId) => findOr404(p.suppliers, supplierId, 'Supplier');
  const touch = (o) => (o.updatedAt = new Date().toISOString());

  // GET /purchasing/orders/7.csv
  if (method === 'GET' && parts[1] === 'orders' && /^\d+\.csv$/.test(parts[2] ?? '')) {
    const order = orderView(state, findOrder(Number(parts[2].slice(0, -4))));
    return reply(200, orderCsv(order), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${order.number}.csv"`,
    });
  }

  switch (route) {
    // ---- suppliers
    case 'GET /purchasing/suppliers': {
      const archived = query.get('archived') === 'true';
      return p.suppliers
        .filter((s) => archived || !s.archivedAt)
        .sort(
          (a, b) =>
            Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) ||
            a.name.localeCompare(b.name),
        )
        .map((s) => supplierView(state, s));
    }
    case 'POST /purchasing/suppliers': {
      if (!body.name?.trim()) throw new HttpError(400, 'name: Too small: expected string');
      const taken = p.suppliers.some(
        (s) => !s.archivedAt && s.name.toLowerCase() === body.name.trim().toLowerCase(),
      );
      if (taken) throw new HttpError(409, `A supplier called “${body.name}” already exists`);
      const supplier = {
        id: p.nextIds.supplier++,
        name: body.name.trim(),
        contactName: body.contactName || null,
        email: body.email || null,
        phone: body.phone || null,
        currencyCode: body.currencyCode ?? state.settings.baseCurrency,
        leadTimeDays: body.leadTimeDays ?? null,
        notes: body.notes || null,
        archivedAt: null,
        createdAt: new Date().toISOString(),
      };
      p.suppliers.push(supplier);
      return reply(201, fullSupplier(state, supplier));
    }
    case 'GET /purchasing/suppliers/:id':
      return fullSupplier(state, findSupplier(id));
    case 'PATCH /purchasing/suppliers/:id': {
      const supplier = findSupplier(id);
      const taken =
        body.name &&
        p.suppliers.some(
          (s) =>
            s.id !== supplier.id &&
            !s.archivedAt &&
            s.name.toLowerCase() === body.name.toLowerCase(),
        );
      if (taken) throw new HttpError(409, `A supplier called “${body.name}” already exists`);
      const keys = [
        'name',
        'contactName',
        'email',
        'phone',
        'currencyCode',
        'leadTimeDays',
        'notes',
      ];
      for (const key of keys) {
        if (body[key] !== undefined) supplier[key] = body[key] === '' ? null : body[key];
      }
      return fullSupplier(state, supplier);
    }
    case 'POST /purchasing/suppliers/:id/archive': {
      const supplier = findSupplier(id);
      const open = p.orders.filter(
        (o) => o.supplierId === supplier.id && UNFINISHED.includes(o.status),
      ).length;
      if (open) {
        throw new HttpError(
          409,
          `“${supplier.name}” has ${open} open ${open === 1 ? 'order' : 'orders'}. Receive, close or cancel ${open === 1 ? 'it' : 'them'} first.`,
        );
      }
      supplier.archivedAt ??= new Date().toISOString();
      for (const info of Object.values(p.itemInfo)) {
        if (info.supplierId === supplier.id) info.supplierId = null;
      }
      return fullSupplier(state, supplier);
    }
    case 'POST /purchasing/suppliers/:id/restore': {
      const supplier = findSupplier(id);
      supplier.archivedAt = null;
      return fullSupplier(state, supplier);
    }
    case 'DELETE /purchasing/suppliers/:id': {
      const supplier = findSupplier(id);
      if (p.orders.some((o) => o.supplierId === supplier.id)) {
        throw new HttpError(
          409,
          `“${supplier.name}” has purchase orders, so it can’t be deleted. Archive it instead.`,
        );
      }
      p.suppliers = p.suppliers.filter((s) => s.id !== supplier.id);
      p.supplierItems = p.supplierItems.filter((si) => si.supplierId !== supplier.id);
      return reply(204);
    }
    case 'GET /purchasing/suppliers/:id/items':
      return supplierItemsView(state, findSupplier(id).id);
    case 'PUT /purchasing/suppliers/:id/items/:id': {
      const supplier = findSupplier(id);
      const item = findOr404(state.items, subId, 'Product');
      let si = p.supplierItems.find((x) => x.supplierId === supplier.id && x.itemId === item.id);
      if (!si) {
        si = {
          supplierId: supplier.id,
          itemId: item.id,
          supplierSku: null,
          unitCost: null,
          minOrderQty: null,
          packSize: null,
        };
        p.supplierItems.push(si);
      }
      for (const key of ['supplierSku', 'unitCost', 'minOrderQty', 'packSize']) {
        if (body[key] !== undefined) si[key] = body[key] === '' ? null : body[key];
      }
      si.updatedAt = new Date().toISOString();
      const info = p.itemInfo[item.id];
      if (body.preferred === true || (body.preferred === undefined && info.supplierId === null)) {
        info.supplierId = supplier.id;
      } else if (body.preferred === false && info.supplierId === supplier.id) {
        info.supplierId = null;
      }
      return supplierItemsView(state, supplier.id).find((x) => x.itemId === item.id);
    }
    case 'GET /purchasing/suppliers/:id/items/:id': {
      const item = supplierItemsView(state, findSupplier(id).id).find(
        (x) => x.itemId === Number(subId),
      );
      if (!item) throw new HttpError(404, 'Supplier product not found');
      return item;
    }
    case 'DELETE /purchasing/suppliers/:id/items/:id': {
      const before = p.supplierItems.length;
      p.supplierItems = p.supplierItems.filter(
        (x) => !(x.supplierId === Number(id) && x.itemId === Number(subId)),
      );
      if (p.supplierItems.length === before) throw new HttpError(404, 'Supplier product not found');
      const info = p.itemInfo[Number(subId)];
      if (info?.supplierId === Number(id)) info.supplierId = null;
      return reply(204);
    }

    // ---- items
    case 'GET /purchasing/items/:id':
      findOr404(state.items, id, 'Product');
      return itemPurchasing(state, Number(id));
    case 'PATCH /purchasing/items/:id': {
      findOr404(state.items, id, 'Product');
      const info = p.itemInfo[Number(id)];
      for (const key of ['supplierId', 'leadTimeDays', 'reorderCoverDays', 'reorderEnabled']) {
        if (body[key] !== undefined) info[key] = body[key];
      }
      return itemPurchasing(state, Number(id));
    }
    case 'GET /purchasing/item-search': {
      const search = query.get('search') ?? '';
      const supplierId = Number(query.get('supplierId') ?? 0);
      return state.items
        .map((item) => ({
          item,
          si: p.supplierItems.find((x) => x.supplierId === supplierId && x.itemId === item.id),
        }))
        .filter(({ item, si }) => matches(search, item.sku, item.title, si?.supplierSku))
        .sort((a, b) => Number(!a.si) - Number(!b.si) || a.item.sku.localeCompare(b.item.sku))
        .slice(0, Number(query.get('limit') ?? 20))
        .map(({ item, si }) => ({
          itemId: item.id,
          sku: item.sku,
          title: item.title,
          cost: p.itemInfo[item.id]?.cost ?? null,
          preferredSupplierId: p.itemInfo[item.id]?.supplierId ?? null,
          available: item.quantity,
          supplierSku: si?.supplierSku ?? null,
          supplierUnitCost: si?.unitCost ?? null,
          soldBySupplier: Boolean(si),
        }));
    }

    // ---- purchase orders
    case 'GET /purchasing/orders': {
      const status = query.get('status') ?? 'open';
      const supplierId = Number(query.get('supplierId') ?? 0);
      const search = query.get('search') ?? '';
      const scoped = p.orders.filter(
        (o) =>
          (!supplierId || o.supplierId === supplierId) &&
          (matches(search, o.number, findSupplier(o.supplierId).name) ||
            o.lines.some((l) => {
              const item = state.items.find((i) => i.id === l.itemId);
              return matches(search, item.sku, item.title);
            })),
      );
      const counts = { draft: 0, ordered: 0, partial: 0, received: 0, closed: 0, cancelled: 0 };
      for (const o of scoped) counts[o.status]++;
      const statuses = status === 'all' ? null : status === 'open' ? UNFINISHED : [status];
      const list = scoped
        .filter((o) => !statuses || statuses.includes(o.status))
        .sort((a, b) => b.id - a.id);
      const { page, pageSize, slice } = paginate(list, query);
      return {
        total: list.length,
        page,
        pageSize,
        counts: {
          ...counts,
          open: counts.draft + counts.ordered + counts.partial,
          all: scoped.length,
        },
        orders: slice.map((o) => listRow(state, o)),
      };
    }
    case 'POST /purchasing/orders':
      return reply(201, orderView(state, createOrder(state, body, HttpError)));
    case 'GET /purchasing/orders/:id':
      return orderView(state, findOrder(id));
    case 'PATCH /purchasing/orders/:id': {
      const order = findOrder(id);
      const draft = order.status === 'draft';
      const open = OPEN.includes(order.status);
      const draftOnly = ['supplierId', 'warehouseId', 'currencyCode', 'exchangeRate'];
      if (!draft && draftOnly.some((k) => body[k] !== undefined)) {
        throw new HttpError(
          409,
          `${order.number}: its supplier, warehouse and currency can’t change anymore.`,
        );
      }
      if (!draft && !open && (body.lines !== undefined || body.expectedOn !== undefined)) {
        throw new HttpError(409, `${order.number}: only its notes can change.`);
      }
      for (const key of [...draftOnly, 'expectedOn']) {
        if (body[key] !== undefined) order[key] = body[key];
      }
      if (body.notes !== undefined) order.notes = body.notes || null;
      if (order.currencyCode === state.settings.baseCurrency) order.exchangeRate = 1;
      if (body.lines !== undefined) {
        replaceLines(state, order, body.lines, HttpError);
        if (open) order.status = statusAfterReceiving(order);
      }
      touch(order);
      return orderView(state, order);
    }
    case 'DELETE /purchasing/orders/:id': {
      const order = findOrder(id);
      if (order.status !== 'draft') {
        throw new HttpError(
          409,
          `Only drafts can be deleted. Cancel or close ${order.number} instead.`,
        );
      }
      p.orders = p.orders.filter((o) => o.id !== order.id);
      return reply(204);
    }
    case 'POST /purchasing/orders/:id/order': {
      const order = findOrder(id);
      if (order.status === 'draft') {
        if (order.lines.length === 0) {
          throw new HttpError(400, 'Add at least one product to the order first');
        }
        order.status = 'ordered';
        order.orderedAt = new Date().toISOString();
        touch(order);
      }
      return orderView(state, order);
    }
    case 'POST /purchasing/orders/:id/close': {
      const order = findOrder(id);
      if (order.status !== 'closed') {
        if (!OPEN.includes(order.status)) {
          throw new HttpError(409, `${order.number} can’t be closed.`);
        }
        order.status = 'closed';
        order.closedAt = new Date().toISOString();
        touch(order);
      }
      return orderView(state, order);
    }
    case 'POST /purchasing/orders/:id/cancel': {
      const order = findOrder(id);
      const received = order.lines.reduce((a, l) => a + l.quantityReceived, 0);
      if (order.status !== 'cancelled') {
        if (!['draft', 'ordered'].includes(order.status) || received > 0) {
          throw new HttpError(
            409,
            `Units were already received on ${order.number}, so it can’t be cancelled. Close it instead: the rest is then no longer expected.`,
          );
        }
        order.status = 'cancelled';
        order.closedAt = new Date().toISOString();
        touch(order);
      }
      return orderView(state, order);
    }
    case 'POST /purchasing/orders/:id/receive': {
      const order = findOrder(id);
      // A retried request (same id) books nothing new, like the real server.
      const earlier = p.orders
        .flatMap((o) => o.receipts.map((r) => ({ o, r })))
        .find(({ r }) => r.requestId === body.requestId);
      if (earlier) {
        if (earlier.o.id !== order.id) {
          throw new HttpError(409, 'This delivery was already recorded on another purchase order.');
        }
        const view = orderView(state, order);
        return {
          receipt: view.receipts.find((r) => r.id === earlier.r.id),
          order: view,
          waiting: [],
          duplicate: true,
        };
      }
      if (!UNFINISHED.includes(order.status)) {
        throw new HttpError(409, `${order.number} can’t take deliveries any more.`);
      }
      const lines = body.lines ?? [];
      if (lines.length === 0) throw new HttpError(400, 'lines: Too small');
      const over = lines
        .map((rl) => ({ rl, l: order.lines.find((x) => x.id === rl.lineId) }))
        .filter(({ rl, l }) => l && l.quantityReceived + rl.quantity > l.quantityOrdered);
      if (over.length && !body.allowOver) {
        throw new HttpError(409, 'More than ordered. Check the numbers, or confirm it.', {
          overReceipt: over.map(({ rl, l }) => ({
            lineId: l.id,
            sku: state.items.find((i) => i.id === l.itemId).sku,
            remaining: remainingOf(l),
            quantity: rl.quantity,
          })),
        });
      }
      const receipt = {
        id: p.nextIds.receipt++,
        requestId: body.requestId,
        note: body.note || null,
        createdAt: new Date().toISOString(),
        reversedAt: null,
        lines: [],
      };
      const supplier = findSupplier(order.supplierId);
      const details = {
        purchaseOrderId: order.id,
        number: order.number,
        supplierName: supplier.name,
        receiptId: receipt.id,
      };
      const waiting = [];
      for (const rl of lines) {
        const l = order.lines.find((x) => x.id === rl.lineId);
        if (!l) throw new HttpError(400, 'A line of this delivery isn’t on the order anymore.');
        l.quantityReceived += rl.quantity;
        receipt.lines.push({ lineId: l.id, quantity: rl.quantity });
        const item = state.items.find((i) => i.id === l.itemId);
        if (item.quantity === null) {
          waiting.push({ itemId: item.id, sku: item.sku, reason: 'not_started' });
        } else if (!item.syncEnabled) {
          waiting.push({ itemId: item.id, sku: item.sku, reason: 'paused' });
        }
        const message = `Received ${rl.quantity} on ${order.number} from ${supplier.name}`;
        logEvent(state, 'po_received', item, rl.quantity, message, details);
      }
      order.receipts.push(receipt);
      order.orderedAt ??= new Date().toISOString();
      order.status = statusAfterReceiving(order);
      touch(order);
      const view = orderView(state, order);
      return reply(201, {
        receipt: view.receipts.find((r) => r.id === receipt.id),
        order: view,
        waiting,
        duplicate: false,
      });
    }
    case 'POST /purchasing/orders/:id/receipts/:id/reverse': {
      const order = findOrder(id);
      const receipt = findOr404(order.receipts, subId, 'Delivery');
      const already = Boolean(receipt.reversedAt);
      if (!already) {
        const supplier = findSupplier(order.supplierId);
        const details = {
          purchaseOrderId: order.id,
          number: order.number,
          supplierName: supplier.name,
          receiptId: receipt.id,
        };
        for (const rl of receipt.lines) {
          const l = order.lines.find((x) => x.id === rl.lineId);
          l.quantityReceived -= rl.quantity;
          const item = state.items.find((i) => i.id === l.itemId);
          const message = `Undid the delivery of ${rl.quantity} on ${order.number} from ${supplier.name}`;
          logEvent(state, 'po_receipt_reversed', item, -rl.quantity, message, details);
        }
        receipt.reversedAt = new Date().toISOString();
        if (order.status !== 'closed') order.status = statusAfterReceiving(order);
        touch(order);
      }
      return { ...orderView(state, order), alreadyReversed: already };
    }

    // ---- reorder
    case 'GET /purchasing/reorder': {
      const filter = query.get('filter') ?? 'needed';
      const supplierParam = query.get('supplierId');
      const search = query.get('search') ?? '';
      const inScope = reorderRows(state).filter(
        (r) =>
          (!supplierParam ||
            (supplierParam === 'none'
              ? r.supplier === null
              : r.supplier?.id === Number(supplierParam))) &&
          matches(search, r.sku, r.title, r.supplierSku),
      );
      const rows = (filter === 'needed' ? inScope.filter((r) => r.needsReorder) : inScope).sort(
        (a, b) =>
          Number(b.needsReorder) - Number(a.needsReorder) ||
          (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) ||
          a.sku.localeCompare(b.sku),
      );
      const { page, pageSize, slice } = paginate(rows, query);
      return {
        total: rows.length,
        page,
        pageSize,
        counts: { needed: inScope.filter((r) => r.needsReorder).length, all: inScope.length },
        baseCurrency: state.settings.baseCurrency,
        settings: {
          alertsEnabled: state.settings.reorderAlertsEnabled,
          lookbackDays: state.settings.reorderLookbackDays,
          safetyDays: state.settings.reorderSafetyDays,
          coverDays: state.settings.reorderCoverDays,
          defaultLeadTimeDays: state.settings.reorderDefaultLeadTimeDays,
        },
        sales: {
          recorded: !p.noSales,
          storesWithPermission: state.stores.filter((s) => s.features?.sales?.available).length,
          stores: state.stores.filter((s) => ['active', 'error'].includes(s.status)).length,
        },
        rows: slice,
      };
    }
    case 'POST /purchasing/reorder/draft-orders': {
      const lines = body.lines ?? [];
      if (lines.length === 0) throw new HttpError(400, 'lines: Too small');
      const without = lines
        .filter((l) => !p.itemInfo[l.itemId]?.supplierId)
        .map((l) => state.items.find((i) => i.id === l.itemId));
      if (without.length) {
        throw new HttpError(
          400,
          `Choose a supplier for ${without.map((i) => i.sku).join(', ')} first, or leave ${without.length === 1 ? 'it' : 'them'} out.`,
          { itemsWithoutSupplier: without.map((i) => i.id) },
        );
      }
      const groups = new Map();
      for (const l of lines) {
        const supplierId = p.itemInfo[l.itemId].supplierId;
        groups.set(supplierId, [...(groups.get(supplierId) ?? []), l]);
      }
      const orderIds = [];
      const rateUnknown = [];
      for (const [supplierId, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
        const supplier = findSupplier(supplierId);
        const rate = suggestedRate(state, supplier.currencyCode);
        if (rate === null) rateUnknown.push(supplier.currencyCode);
        const created = createOrder(
          state,
          {
            supplierId,
            exchangeRate: rate ?? 1,
            lines: group.map((l) => ({ itemId: l.itemId, quantityOrdered: l.quantity })),
          },
          HttpError,
        );
        orderIds.push(created.id);
      }
      return reply(201, { orderIds, rateUnknown });
    }
    default:
      return undefined;
  }
}
