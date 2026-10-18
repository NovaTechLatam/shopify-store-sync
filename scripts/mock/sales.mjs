// Mock API for Reports (/api/reports/...), plugged into ../dashboard-mock-api.mjs. Same routes and
// response shapes as src/http/api/reports.ts, computed from synthetic order lines:
// - Northwind Apparel (USD): 90 days of history, busier at weekends, slowly growing;
// - Harbor & Pine (COP): no permission to read orders, so no sales;
// - Little Fox Kids (CLP): history import still running; live orders of the last 11 days.
// Test orders, cancellations, refunds, gift cards and a SKU that isn't a product are mixed in.

const DAY_MS = 24 * 60 * 60_000;
/** USD price and cost of each product family (null: no cost entered). */
const FAMILIES = {
  'TEE-ORG': { price: 28, cost: 9.5 },
  'HOOD-CLS': { price: 64, cost: 24 },
  'CAP-WAX': { price: 24, cost: 8 },
  'SOCK-MER': { price: 14, cost: 4.2 },
  'TOTE-CNV': { price: 19, cost: 6 },
  'JKT-RAIN': { price: 120, cost: null },
};
/** Monday first: weekends sell more. */
const WEEKDAY_FACTOR = [0.8, 0.85, 0.9, 1, 1.15, 1.45, 1.3];

/**
 * Adds this feature's data to a fresh mock state (called at the end of createMockState()).
 * `tools` = { reply, HttpError, paginate, matches, findOr404, minutesAgo, random }.
 */
export function seed(state, tools) {
  const rand = tools.random(7);
  const now = Date.now();
  const tz = reportTimezone(state);
  const lines = [];
  let orderId = 1;
  const pick = (list) => list[Math.floor(rand() * list.length)];

  const addOrders = (store, daysBack, perDay) => {
    const variants = state.variants.filter(
      (v) => v.storeId === store.id && v.itemId !== null && !v.deleted && familyOf(v.sku),
    );
    for (let d = daysBack - 1; d >= 0; d--) {
      const dayStart = now - d * DAY_MS;
      const weekday = (new Date(dayStart).getUTCDay() + 6) % 7;
      const trend = 0.8 + 0.4 * ((daysBack - d) / daysBack);
      const count = Math.round(perDay * WEEKDAY_FACTOR[weekday] * trend * (0.75 + rand() * 0.5));
      for (let o = 0; o < count; o++) {
        // Today only has the hours gone by.
        const at = d === 0 ? now - rand() * 6 * 3_600_000 : dayStart - rand() * DAY_MS;
        const roll = rand();
        const order = {
          orderId: orderId++,
          storeId: store.id,
          processedAt: new Date(at).toISOString(),
          date: dateIn(tz, at),
          test: roll < 0.01,
          cancelled: roll >= 0.01 && roll < 0.025,
        };
        const lineCount = 1 + Math.floor(rand() * rand() * 3);
        for (let l = 0; l < lineCount; l++) {
          const variant = pick(variants);
          const family = familyOf(variant.sku);
          const qty = rand() < 0.8 ? 1 : 2;
          const unitPrice = priceIn(store, family.price);
          const discount = rand() < 0.15 ? 0.1 : 0;
          const refunded = rand() < 0.04;
          const units = order.cancelled || refunded ? 0 : qty;
          lines.push({
            ...order,
            itemId: variant.itemId,
            sku: variant.sku,
            units,
            net: round(units * unitPrice * (1 - discount), store.currencyCode === 'CLP' ? 0 : 2),
            unitCost: family.cost,
            giftCard: false,
          });
        }
        // Now and then a gift card, or gift wrap (a SKU that isn't one of the products).
        if (store.id === 1 && rand() < 0.04) {
          lines.push({
            ...order,
            itemId: null,
            sku: null,
            units: 1,
            net: 50,
            unitCost: null,
            giftCard: true,
          });
        }
        if (store.id === 1 && rand() < 0.06) {
          lines.push({
            ...order,
            itemId: null,
            sku: 'GIFT-WRAP',
            units: 1,
            net: 4,
            unitCost: null,
            giftCard: false,
          });
        }
      }
    }
  };
  const byId = new Map(state.stores.map((s) => [s.id, s]));
  addOrders(byId.get(1), 90, 9);
  addOrders(byId.get(3), 11, 4);

  const none = () => ({
    backfill: { status: 'none', startedAt: null, finishedAt: null, objects: null, error: null },
    historyFrom: null,
    historyCapped: false,
    allOrders: false,
    lastSyncedAt: null,
    syncError: null,
  });
  state.sales = {
    lines,
    stores: {
      1: {
        backfill: {
          status: 'done',
          startedAt: tools.minutesAgo(60 * 24 * 39),
          finishedAt: tools.minutesAgo(60 * 24 * 39 - 6),
          objects: 4210,
          error: null,
        },
        historyFrom: dateIn(tz, now - 89 * DAY_MS),
        historyCapped: false,
        allOrders: true,
        lastSyncedAt: tools.minutesAgo(6),
        syncError: null,
      },
      2: none(),
      3: {
        backfill: {
          status: 'running',
          startedAt: tools.minutesAgo(8),
          finishedAt: null,
          objects: 1840,
          error: null,
        },
        historyFrom: dateIn(tz, now - 60 * DAY_MS),
        historyCapped: true,
        allOrders: false,
        lastSyncedAt: null,
        syncError: null,
      },
    },
    none,
  };
}

/**
 * Answers this feature's routes, or returns undefined to let the mock answer 404. `req` =
 * { method, route ('GET /catalog/products/:id'), parts, id, subId, ids, query (URLSearchParams),
 * body (parsed JSON, or a Buffer for image uploads), contentType, state }. Return a body (200),
 * `tools.reply(status, body)`, or throw `new tools.HttpError(status, message, details)`.
 */
export function handle(req, tools) {
  const { state, query } = req;
  switch (req.route) {
    case 'GET /reports/status':
      return {
        baseCurrency: state.settings.baseCurrency,
        timezone: reportTimezone(state),
        salesHistoryDays: state.settings.salesHistoryDays,
        lookbackDays: state.settings.reorderLookbackDays,
        stores: coverage(state, state.stores),
      };
    case 'GET /reports/summary':
      return summary(state, context(state, query, tools));
    case 'GET /reports/products': {
      const ctx = context(state, query, tools);
      const rows = sortedRows(state, ctx, query, tools);
      const { page, pageSize, slice } = tools.paginate(rows, query);
      return {
        baseCurrency: state.settings.baseCurrency,
        timezone: ctx.tz,
        from: ctx.from,
        to: ctx.to,
        lookbackDays: state.settings.reorderLookbackDays,
        stores: ctx.stores.map((s) => ({
          storeId: s.id,
          name: s.name,
          currencyCode: s.currencyCode,
        })),
        total: rows.length,
        page,
        pageSize,
        products: slice,
      };
    }
    case 'GET /reports/products.csv': {
      const ctx = context(state, query, tools);
      return tools.reply(200, csv(state, ctx, sortedRows(state, ctx, query, tools)), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="sales-by-product-${ctx.from}-to-${ctx.to}.csv"`,
      });
    }
    case 'GET /reports/items/:id':
      return itemReport(state, context(state, query, tools), Number(req.id), tools);
    case 'POST /reports/stores/:id/resync': {
      const store = tools.findOr404(state.stores, req.id, 'Store');
      if (coverage(state, [store])[0].permission === 'missing') {
        throw new tools.HttpError(
          409,
          `“${store.name}” hasn’t given Store Sync permission to read its orders (read_orders). Add it to the app’s access scopes and approve the update in the store’s Shopify admin, then click “Test connection” on the store’s page.`,
          { feature: 'sales', missingScopes: ['read_orders'] },
        );
      }
      const own = salesOf(state, store.id);
      if (own.backfill.status === 'running') {
        throw new tools.HttpError(
          409,
          `The order history of “${store.name}” is being imported already.`,
        );
      }
      own.backfill = {
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        objects: 0,
        error: null,
      };
      return tools.reply(202, { queued: true });
    }
    default:
      return undefined;
  }
}

// ---- read models -----------------------------------------------------------------------------

function reportTimezone(state) {
  return state.settings.reportTimezone || state.stores.find((s) => s.timezone)?.timezone || 'UTC';
}

function salesOf(state, storeId) {
  state.sales.stores[storeId] ??= state.sales.none();
  return state.sales.stores[storeId];
}

function context(state, query, tools) {
  const tz = reportTimezone(state);
  const date = (name) => {
    const v = query.get(name);
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw new tools.HttpError(400, `${name}: Use a date like 2026-10-17`);
    }
    return v;
  };
  const to = date('to') ?? dateIn(tz, Date.now());
  const from = date('from') ?? addDays(to, -29);
  if (from > to) {
    throw new tools.HttpError(400, 'The start date must be on or before the end date.');
  }
  const ids = query.get('storeIds');
  const wanted = ids ? new Set(ids.split(',').map(Number)) : null;
  const stores = state.stores.filter((s) => !wanted || wanted.has(s.id));
  return { tz, from, to, stores };
}

const inPeriod = (ctx, l) =>
  ctx.stores.some((s) => s.id === l.storeId) && l.date >= ctx.from && l.date <= ctx.to;

/** Lines a report counts: in the period and stores; test, cancelled and gift cards left out. */
function counted(state, ctx) {
  return state.sales.lines.filter(
    (l) => inPeriod(ctx, l) && !l.test && !l.cancelled && !l.giftCard,
  );
}

function coverage(state, stores) {
  return stores.map((s) => {
    const own = salesOf(state, s.id);
    const missing = !(s.features?.sales?.available ?? true);
    const first =
      state.sales.lines
        .filter((l) => l.storeId === s.id)
        .map((l) => l.date)
        .sort()[0] ?? null;
    return {
      storeId: s.id,
      name: s.name,
      storeStatus: s.status,
      currencyCode: s.currencyCode,
      permission: s.scopesCheckedAt === null ? 'unknown' : missing ? 'missing' : 'granted',
      missingScopes: missing ? ['read_orders'] : [],
      allOrders: own.allOrders,
      backfill: { ...own.backfill },
      historyFrom: own.historyFrom,
      historyCapped: own.historyCapped,
      firstOrderOn: first,
      lastSyncedAt: own.lastSyncedAt,
      syncError: own.syncError,
    };
  });
}

function summary(state, ctx) {
  const lines = counted(state, ctx);
  const orders = state.sales.lines.filter((l) => inPeriod(ctx, l) && !l.test && !l.cancelled);
  const byStore = ctx.stores.map((s) => {
    const own = lines.filter((l) => l.storeId === s.id);
    const revenue = sum(own, (l) => l.net);
    const withCost = own.filter((l) => l.unitCost !== null);
    const cost = sum(withCost, (l) => l.unitCost * l.units);
    const withCostBase = sum(withCost, (l) => l.net) / s.exchangeRate;
    return {
      storeId: s.id,
      name: s.name,
      currencyCode: s.currencyCode,
      exchangeRate: s.exchangeRate,
      orders: new Set(orders.filter((l) => l.storeId === s.id).map((l) => l.orderId)).size,
      units: sum(own, (l) => l.units),
      revenue: round(revenue, 4),
      revenueBase: round(revenue / s.exchangeRate, 4),
      cost: round(cost, 4),
      margin: withCostBase > 0 ? round((withCostBase - cost) / withCostBase, 4) : null,
      revenueWithoutCost: round(revenue / s.exchangeRate - withCostBase, 4),
      withCostBase,
    };
  });
  const revenue = sum(byStore, (s) => s.revenueBase);
  const withCost = sum(byStore, (s) => s.withCostBase);
  const cost = sum(byStore, (s) => s.cost);
  const rate = new Map(ctx.stores.map((s) => [s.id, s.exchangeRate]));
  const daily = [];
  for (let d = ctx.from; d <= ctx.to; d = addDays(d, 1)) {
    const per = {};
    for (const l of lines) {
      if (l.date === d) per[l.storeId] = (per[l.storeId] ?? 0) + l.net / rate.get(l.storeId);
    }
    for (const k of Object.keys(per)) per[k] = round(per[k], 4);
    daily.push({
      date: d,
      revenue: round(
        sum(Object.values(per), (v) => v),
        4,
      ),
      byStore: per,
    });
  }
  return {
    baseCurrency: state.settings.baseCurrency,
    timezone: ctx.tz,
    from: ctx.from,
    to: ctx.to,
    totals: {
      orders: sum(byStore, (s) => s.orders),
      units: sum(byStore, (s) => s.units),
      revenue: round(revenue, 4),
      cost: round(cost, 4),
      margin: withCost > 0 ? round((withCost - cost) / withCost, 4) : null,
      revenueWithoutCost: round(revenue - withCost, 4),
    },
    byStore: byStore.map(({ withCostBase: _w, ...s }) => s),
    daily,
    coverage: { stores: coverage(state, ctx.stores) },
  };
}

/** Units a day over the pace window, every store, as the API works it out. */
function pace(state, itemId) {
  const since = Date.now() - state.settings.reorderLookbackDays * DAY_MS;
  const all = state.sales.lines.filter((l) => !l.test && !l.cancelled && !l.giftCard);
  const first = Math.min(...all.map((l) => Date.parse(l.processedAt)));
  const recent = all.filter((l) => l.itemId === itemId && Date.parse(l.processedAt) >= since);
  const span = Math.max(1, (Date.now() - Math.max(since, first)) / DAY_MS);
  return sum(recent, (l) => l.units) / span;
}

function productRows(state, ctx) {
  const rate = new Map(state.stores.map((s) => [s.id, s.exchangeRate]));
  const itemOf = new Map(state.items.map((i) => [i.id, i]));
  const rows = new Map();
  const rowFor = (key, item, sku) => {
    if (!rows.has(key)) {
      rows.set(key, {
        itemId: item?.id ?? null,
        sku: item?.sku ?? sku,
        title: item?.title ?? '',
        units: 0,
        revenue: 0,
        cost: 0,
        withCost: 0,
        stock: item ? item.quantity : null,
        byStore: new Map(),
      });
    }
    return rows.get(key);
  };
  for (const item of state.items) if ((item.quantity ?? 0) > 0) rowFor(`i${item.id}`, item);
  for (const l of counted(state, ctx)) {
    const row = l.itemId
      ? rowFor(`i${l.itemId}`, itemOf.get(l.itemId))
      : rowFor(`s${l.sku}`, null, l.sku);
    const revenueBase = l.net / rate.get(l.storeId);
    row.units += l.units;
    row.revenue += revenueBase;
    if (l.unitCost !== null) {
      row.cost += l.unitCost * l.units;
      row.withCost += revenueBase;
    }
    const s = row.byStore.get(l.storeId) ?? {
      storeId: l.storeId,
      units: 0,
      revenue: 0,
      revenueBase: 0,
    };
    s.units += l.units;
    s.revenue += l.net;
    s.revenueBase += revenueBase;
    row.byStore.set(l.storeId, s);
  }
  return [...rows.values()].map((r) => {
    const velocity = r.itemId ? pace(state, r.itemId) : 0;
    const onHand = r.stock === null ? null : Math.max(0, r.stock);
    return {
      itemId: r.itemId,
      sku: r.sku,
      title: r.title,
      units: r.units,
      revenue: round(r.revenue, 4),
      cost: round(r.cost, 4),
      margin: r.withCost > 0 ? round((r.withCost - r.cost) / r.withCost, 4) : null,
      stock: r.stock,
      velocity: round(velocity, 2),
      daysLeft: onHand !== null && velocity > 0 ? round(onHand / velocity, 1) : null,
      sellThrough:
        onHand !== null && r.units + onHand > 0 ? round(r.units / (r.units + onHand), 4) : null,
      byStore: [...r.byStore.values()]
        .sort((a, b) => a.storeId - b.storeId)
        .map((s) => ({ ...s, revenue: round(s.revenue, 4), revenueBase: round(s.revenueBase, 4) })),
    };
  });
}

function sortedRows(state, ctx, query, tools) {
  const sort = query.get('sort') || 'revenue';
  if (!['revenue', 'units', 'margin', 'daysLeft', 'sellThrough'].includes(sort)) {
    throw new tools.HttpError(400, 'sort: Invalid option');
  }
  const sign = query.get('dir') === 'asc' ? 1 : -1;
  const search = query.get('search') ?? '';
  return productRows(state, ctx)
    .filter((r) => tools.matches(search, r.sku, r.title))
    .sort((a, b) => {
      const x = a[sort];
      const y = b[sort];
      if (x === null || y === null) {
        if (x !== y) return x === null ? 1 : -1;
      } else if (x !== y) return (x - y) * sign;
      return (a.sku ?? '').localeCompare(b.sku ?? '');
    });
}

function itemReport(state, ctx, itemId, tools) {
  const item = tools.findOr404(state.items, itemId, 'Product');
  const lines = counted(state, ctx).filter((l) => l.itemId === itemId);
  const stores = ctx.stores.map((s) => {
    const own = lines.filter((l) => l.storeId === s.id);
    const revenue = sum(own, (l) => l.net);
    return {
      storeId: s.id,
      name: s.name,
      currencyCode: s.currencyCode,
      orders: new Set(own.map((l) => l.orderId)).size,
      units: sum(own, (l) => l.units),
      revenue: round(revenue, 4),
      revenueBase: round(revenue / s.exchangeRate, 4),
    };
  });
  const daily = [];
  for (let d = ctx.from; d <= ctx.to; d = addDays(d, 1)) {
    const per = {};
    for (const l of lines) if (l.date === d) per[l.storeId] = (per[l.storeId] ?? 0) + l.units;
    daily.push({ date: d, byStore: per });
  }
  const velocity = pace(state, itemId);
  const onHand = item.quantity === null ? null : Math.max(0, item.quantity);
  return {
    itemId,
    sku: item.sku,
    title: item.title,
    baseCurrency: state.settings.baseCurrency,
    timezone: ctx.tz,
    from: ctx.from,
    to: ctx.to,
    lookbackDays: state.settings.reorderLookbackDays,
    stores,
    totals: {
      orders: sum(stores, (s) => s.orders),
      units: sum(stores, (s) => s.units),
      revenue: round(
        sum(stores, (s) => s.revenueBase),
        4,
      ),
    },
    daily,
    stock: item.quantity,
    velocity: round(velocity, 2),
    daysLeft: onHand !== null && velocity > 0 ? round(onHand / velocity, 1) : null,
    readingStores: coverage(state, ctx.stores).filter((c) => c.permission !== 'missing').length,
  };
}

function csv(state, ctx, rows) {
  const base = state.settings.baseCurrency;
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    const text = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = [
    'SKU',
    'Product',
    ...ctx.stores.flatMap((s) => [`${s.name}: units`, `${s.name}: revenue (${s.currencyCode})`]),
    'Units',
    `Revenue (${base})`,
    `Cost (${base})`,
    'Margin (%)',
    'Shared stock',
    'Units a day',
    'Days of stock left',
    'Sell-through (%)',
  ];
  const body = rows.map((r) => [
    r.sku,
    r.itemId === null ? 'Not one of your products' : r.title,
    ...ctx.stores.flatMap((s) => {
      const own = r.byStore.find((x) => x.storeId === s.id);
      return [own?.units ?? 0, round(own?.revenue ?? 0, s.currencyCode === 'CLP' ? 0 : 2)];
    }),
    r.units,
    round(r.revenue, 2),
    round(r.cost, 2),
    r.margin === null ? null : round(r.margin * 100, 1),
    r.stock,
    r.velocity,
    r.daysLeft,
    r.sellThrough === null ? null : round(r.sellThrough * 100, 1),
  ]);
  return `\uFEFF${[header, ...body].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

// ---- helpers -----------------------------------------------------------------------------------

function familyOf(sku) {
  return FAMILIES[sku?.split('-').slice(0, 2).join('-')];
}

/** A USD price in the store's currency, with the endings shops there use. */
function priceIn(store, usd) {
  if (store.currencyCode === 'CLP')
    return Math.round((usd * store.exchangeRate) / 1000) * 1000 - 10;
  if (store.currencyCode === 'COP') {
    return Math.round((usd * store.exchangeRate) / 1000) * 1000 - 100;
  }
  return usd;
}

function dateIn(timeZone, ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

const sum = (list, pick) => list.reduce((total, x) => total + pick(x), 0);
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
