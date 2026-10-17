// A stand-in for the admin API (same routes and response shapes as src/http/api) with realistic,
// deterministic in-memory data, so the dashboard can be developed and checked without Postgres or
// Shopify. Run it on its own with `node scripts/dashboard-mock-api.mjs [port]`.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as catalogMock from './mock/catalog.mjs';
import * as pricingMock from './mock/pricing.mjs';
import * as purchasingMock from './mock/purchasing.mjs';
import * as salesMock from './mock/sales.mjs';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
// Same headers as src/http/server.ts, so a CSP violation shows up here too.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://cdn.shopify.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Small deterministic PRNG so every run (and screenshot) shows the same data. */
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * A response with a status other than 200 (handlers return plain bodies for 200). With `headers`
 * (e.g. { 'Content-Type': 'image/png' }), `body` is sent as is (a Buffer or a string) instead of
 * as JSON: images, CSV downloads.
 */
const REPLY = Symbol('reply');
const reply = (status, body, headers) => ({ [REPLY]: true, status, body, headers });

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

/**
 * Each feature's mock (scripts/mock/*.mjs): `seed(state, tools)` adds its data at the end of
 * createMockState(), and `handle(req, tools)` answers its routes (undefined = not mine). See
 * handle() below for `req`.
 */
const FEATURES = [catalogMock, pricingMock, salesMock, purchasingMock];

/** `store.features` as the API returns it; `missing` = { feature: [scopes] } not granted. */
function features(missing = {}) {
  return Object.fromEntries(
    ['catalog', 'publishing', 'pricing', 'sales'].map((f) => [
      f,
      { available: !missing[f], missingScopes: missing[f] ?? [] },
    ]),
  );
}

export function createMockState() {
  const rand = random(42);
  const stores = [
    {
      id: 1,
      name: 'Northwind Apparel',
      shopDomain: 'northwind-apparel.myshopify.com',
      authMode: 'client_credentials',
      status: 'active',
      lastError: null,
      safetyBuffer: 0,
      hasWebhookSecret: true,
      clientId: '4f1c9e2b7a0d4c55b1e3',
      lastWebhookAt: minutesAgo(2),
      webhooksRegisteredAt: minutesAgo(60 * 50),
      catalogSyncedAt: minutesAgo(130),
      lastDriftScanAt: minutesAgo(6),
      lastDriftCount: 0,
      createdAt: minutesAgo(60 * 24 * 40),
      variantCount: 0,
      linkedCount: 0,
      currencyCode: 'USD',
      timezone: 'America/New_York',
      exchangeRate: 1,
      features: features(),
      scopesCheckedAt: minutesAgo(60 * 24 * 2),
      locations: [
        {
          id: 1,
          shopifyLocationId: 'gid://shopify/Location/1001',
          name: 'Leeds warehouse',
          isActive: true,
          warehouseId: 1,
        },
        {
          id: 2,
          shopifyLocationId: 'gid://shopify/Location/1002',
          name: 'Pop-up shop',
          isActive: true,
          warehouseId: null,
        },
      ],
    },
    {
      id: 2,
      name: 'Harbor & Pine',
      shopDomain: 'harbor-and-pine.myshopify.com',
      authMode: 'access_token',
      status: 'active',
      lastError: null,
      safetyBuffer: 2,
      hasWebhookSecret: true,
      clientId: null,
      lastWebhookAt: minutesAgo(4),
      webhooksRegisteredAt: minutesAgo(60 * 50),
      catalogSyncedAt: minutesAgo(125),
      lastDriftScanAt: minutesAgo(9),
      lastDriftCount: 2,
      createdAt: minutesAgo(60 * 24 * 38),
      variantCount: 0,
      linkedCount: 0,
      currencyCode: 'COP',
      timezone: 'America/Bogota',
      exchangeRate: 4100,
      features: features({ sales: ['read_orders'] }),
      scopesCheckedAt: minutesAgo(60 * 24 * 2),
      locations: [
        {
          id: 3,
          shopifyLocationId: 'gid://shopify/Location/2001',
          name: 'Main warehouse',
          isActive: true,
          warehouseId: 1,
        },
        {
          id: 4,
          shopifyLocationId: 'gid://shopify/Location/2002',
          name: 'Old studio',
          isActive: false,
          warehouseId: null,
        },
      ],
    },
    {
      id: 3,
      name: 'Little Fox Kids',
      shopDomain: 'little-fox-kids.myshopify.com',
      authMode: 'client_credentials',
      status: 'error',
      lastError: 'Shopify rejected the credentials (HTTP 401).',
      safetyBuffer: 0,
      hasWebhookSecret: true,
      clientId: '9a0e11c2d3b44f6687aa',
      lastWebhookAt: minutesAgo(190),
      webhooksRegisteredAt: minutesAgo(60 * 24 * 3),
      catalogSyncedAt: minutesAgo(60 * 6),
      lastDriftScanAt: minutesAgo(200),
      lastDriftCount: 0,
      createdAt: minutesAgo(60 * 24 * 12),
      variantCount: 0,
      linkedCount: 0,
      currencyCode: 'CLP',
      timezone: 'America/Santiago',
      exchangeRate: 950,
      // Never checked: the API reports every feature as available (Shopify decides).
      features: features(),
      scopesCheckedAt: null,
      locations: [
        {
          id: 5,
          shopifyLocationId: 'gid://shopify/Location/3001',
          name: 'Shared warehouse',
          isActive: true,
          warehouseId: 1,
        },
      ],
    },
  ];
  const warehouses = [{ id: 1, name: 'Main warehouse' }];

  const products = [
    ['TEE-ORG', 'Organic Tee', ['Black', 'White', 'Sage']],
    ['HOOD-CLS', 'Classic Hoodie', ['Navy', 'Oat']],
    ['CAP-WAX', 'Waxed Cap', ['Olive']],
    ['SOCK-MER', 'Merino Socks', ['Grey', 'Rust']],
    ['TOTE-CNV', 'Canvas Tote', ['Natural']],
    ['JKT-RAIN', 'Rain Jacket', ['Yellow', 'Black']],
  ];
  const sizes = ['S', 'M', 'L'];
  const items = [];
  const variants = [];
  let itemId = 1;
  let variantId = 1;
  for (const [base, title, colors] of products) {
    for (const color of colors) {
      for (const size of sizes) {
        const id = itemId++;
        const sku = `${base}-${color.slice(0, 3).toUpperCase()}-${size}`;
        const roll = rand();
        let quantity = Math.floor(rand() * 60);
        if (roll < 0.1) quantity = null;
        else if (roll < 0.14) quantity = -Math.ceil(rand() * 3);
        else if (roll < 0.26) quantity = Math.floor(rand() * 5);
        items.push({
          id,
          sku,
          title: `${title} · ${color} / ${size}`,
          syncEnabled: !(id === 7),
          lowStockThreshold: id === 3 ? 10 : null,
          quantity,
          updatedAt: minutesAgo(Math.floor(rand() * 600)),
        });
        for (const store of stores) {
          // Little Fox Kids only sells tees and socks.
          if (store.id === 3 && !['TEE-ORG', 'SOCK-MER'].includes(base)) continue;
          // Harbor & Pine has this one under a mistyped SKU (see below).
          if (store.id === 2 && sku === 'TEE-ORG-BLA-M') continue;
          variants.push({
            id: variantId++,
            storeId: store.id,
            sku,
            barcode: `50${String(id).padStart(6, '0')}${store.id}`,
            productTitle: store.id === 2 ? `${title} (Harbor)` : title,
            variantTitle: `${color} / ${size}`,
            tracked: !(store.id === 2 && id === 11),
            isBundle: false,
            itemId: id,
            linkSource: 'auto',
            deleted: false,
            lastKnownOffset: id === 5 && store.id === 2 ? 3 : 0,
            pendingWrite: (id === 9 && store.id === 1) || (id === 5 && store.id === 2),
          });
        }
      }
    }
  }
  // Matching problems: a SKU typo (only in one store), duplicates, bundles and blank SKUs.
  const extra = (v) =>
    variants.push({
      id: variantId++,
      barcode: null,
      tracked: true,
      isBundle: false,
      linkSource: 'auto',
      deleted: false,
      lastKnownOffset: 0,
      pendingWrite: false,
      ...v,
    });
  items.push({
    id: itemId,
    sku: 'TEE-ORG-BLKK-M',
    title: 'Organic Tee · Black / M',
    syncEnabled: true,
    lowStockThreshold: null,
    quantity: 14,
    updatedAt: minutesAgo(300),
  });
  extra({
    storeId: 2,
    sku: 'TEE-ORG-BLKK-M',
    productTitle: 'Organic Tee (Harbor)',
    variantTitle: 'Black / M',
    itemId: itemId++,
  });
  extra({
    storeId: 1,
    sku: 'GIFT-WRAP',
    productTitle: 'Gift wrapping',
    variantTitle: 'Default Title',
    itemId: null,
  });
  extra({
    storeId: 1,
    sku: 'MUG-ENM-WHT',
    productTitle: 'Enamel Mug',
    variantTitle: 'White',
    itemId: null,
  });
  extra({
    storeId: 1,
    sku: 'MUG-ENM-WHT',
    productTitle: 'Enamel Mug (old listing)',
    variantTitle: 'White',
    itemId: null,
  });
  extra({
    storeId: 2,
    sku: 'BAG-WKD',
    productTitle: 'Weekender Bag',
    variantTitle: 'Tan',
    itemId: null,
  });
  extra({
    storeId: 2,
    sku: 'BAG-WKD',
    productTitle: 'Weekender Bag',
    variantTitle: 'Tan (sample)',
    itemId: null,
  });
  extra({
    storeId: 2,
    sku: 'BAG-WKD',
    productTitle: 'Weekender Bag',
    variantTitle: 'Tan (B-grade)',
    itemId: null,
  });
  extra({
    storeId: 1,
    sku: 'BNDL-TEE-3',
    productTitle: 'Tee 3-pack',
    variantTitle: 'Mixed',
    itemId: null,
    isBundle: true,
  });
  extra({ storeId: 2, sku: null, productTitle: 'Gift card', variantTitle: '£25', itemId: null });
  extra({
    storeId: 1,
    sku: 'SAMPLE-SWATCH',
    productTitle: 'Fabric swatch',
    variantTitle: 'Default Title',
    itemId: null,
    linkSource: 'manual',
  });

  const alerts = [];
  let alertId = 1;
  const addAlert = (a) =>
    alerts.push({
      id: alertId++,
      itemId: null,
      storeId: null,
      notifiedAt: null,
      resolvedAt: null,
      ...a,
    });
  for (const item of items) {
    if (item.quantity !== null && item.quantity < 0) {
      addAlert({
        kind: 'oversold',
        itemId: item.id,
        message: `${item.sku} is oversold: shared quantity is ${item.quantity}.`,
        createdAt: minutesAgo(35),
        notifiedAt: minutesAgo(34),
      });
    } else if (item.quantity !== null && item.quantity <= (item.lowStockThreshold ?? 5)) {
      addAlert({
        kind: 'low_stock',
        itemId: item.id,
        message: `${item.sku} is low on stock: ${item.quantity} left (threshold ${item.lowStockThreshold ?? 5}).`,
        createdAt: minutesAgo(80 + item.id),
        notifiedAt: minutesAgo(79),
      });
    }
  }
  addAlert({
    kind: 'store_error',
    storeId: 3,
    message: 'Little Fox Kids: Shopify rejected the credentials (HTTP 401).',
    createdAt: minutesAgo(185),
  });
  addAlert({
    kind: 'possible_double_count',
    itemId: 4,
    storeId: 2,
    message:
      'Northwind Apparel and Harbor & Pine each added 24 units of TEE-ORG-WHI-S within 10 minutes. If this was the same delivery entered in each store, the shared stock now counts it twice: remove 24 units from the product page.',
    createdAt: minutesAgo(15),
  });
  addAlert({
    kind: 'webhook_gap',
    storeId: 2,
    message: 'Harbor & Pine: 3 stock changes reached us only through the regular check, not live.',
    createdAt: minutesAgo(60 * 30),
    resolvedAt: minutesAgo(60 * 29),
  });

  const events = [];
  let eventId = 1;
  const kinds = [
    'external_change',
    'propagated',
    'external_change',
    'manual_adjust',
    'store_joined',
    'manual_set',
    'drift_detected',
    'initialized',
  ];
  for (let i = 0; i < 130; i++) {
    const item = items[Math.floor(rand() * items.length)];
    const store = stores[Math.floor(rand() * 2)];
    const kind = kinds[Math.floor(rand() * kinds.length)];
    const before = Math.floor(rand() * 40) + 2;
    const delta = kind === 'manual_adjust' ? 24 : -Math.ceil(rand() * 2);
    const base = {
      id: eventId++,
      kind,
      itemId: item.id,
      sku: item.sku,
      storeId: null,
      storeName: null,
      delta: null,
      quantityBefore: null,
      quantityAfter: null,
      message: null,
      details: null,
      createdAt: minutesAgo((130 - i) * 23),
    };
    if (kind === 'external_change')
      Object.assign(base, {
        storeId: store.id,
        storeName: store.name,
        delta,
        quantityBefore: before,
        quantityAfter: before + delta,
        message: `${store.name}: ${before} → ${before + delta}`,
      });
    if (kind === 'propagated')
      Object.assign(base, {
        quantityAfter: before,
        message: `Shared stock ${before}: updated 2 of 2 stores`,
      });
    if (kind === 'manual_adjust')
      Object.assign(base, {
        delta,
        quantityBefore: before,
        quantityAfter: before + delta,
        message: 'Delivery from supplier',
      });
    if (kind === 'manual_set')
      Object.assign(base, {
        delta: 40 - before,
        quantityBefore: before,
        quantityAfter: 40,
        message: 'Stock count',
      });
    if (kind === 'store_joined')
      Object.assign(base, {
        storeId: store.id,
        storeName: store.name,
        message: `${store.name} started syncing this item (it showed ${before})`,
      });
    if (kind === 'drift_detected')
      Object.assign(base, {
        itemId: null,
        sku: null,
        storeId: 2,
        storeName: 'Harbor & Pine',
        message: 'Found 2 stock levels that changed without a webhook; they were synced.',
      });
    if (kind === 'initialized')
      Object.assign(base, {
        quantityAfter: before,
        message: `Started syncing at ${before} (copied from Northwind Apparel)`,
      });
    events.push(base);
  }

  const state = {
    stores,
    warehouses,
    items,
    variants,
    alerts,
    events,
    nextIds: { store: 4, warehouse: 2, item: itemId, alert: alertId },
    settings: {
      syncPaused: false,
      pausedReason: null,
      lowStockThreshold: 5,
      alertSlackWebhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX',
      alertWebhookUrl: null,
      onboardingCompleted: true,
      autoInitializeNewItems: true,
      autoInitializeStrategy: 'max',
      massZeroLimit: 15,
      eventRetentionDays: 180,
      breakerResetAt: null,
      baseCurrency: 'USD',
      reorderAlertsEnabled: true,
      reorderLookbackDays: 30,
      reorderSafetyDays: 7,
      reorderCoverDays: 30,
      reorderDefaultLeadTimeDays: 14,
      salesHistoryDays: 60,
      costMethod: 'average',
      pushCostsToShopify: false,
      reportTimezone: '',
    },
  };
  for (const feature of FEATURES) feature.seed(state, TOOLS);
  return state;
}

// ---------- read models (mirror src/http/api) ----------

const displayQuantity = (q, buffer) => Math.max(0, q - buffer);

function storeView(state, store) {
  const own = state.variants.filter((v) => v.storeId === store.id && !v.deleted);
  return {
    ...store,
    variantCount: own.length,
    linkedCount: own.filter((v) => v.itemId !== null).length,
    locations: store.locations.map((l) => ({ ...l })),
  };
}

function itemSummary(state, item) {
  const linked = state.variants.filter((v) => v.itemId === item.id && !v.deleted && !v.isBundle);
  const issues = [];
  for (const v of linked)
    if (!v.tracked) issues.push(`Not tracked in ${storeName(state, v.storeId)}`);
  for (const s of state.stores) {
    if (s.status === 'active' && !linked.some((v) => v.storeId === s.id))
      issues.push(`Missing in ${s.name}`);
  }
  const levels = state.warehouses.map((w) => ({
    poolLevelId: item.id * 10 + w.id,
    warehouseId: w.id,
    warehouseName: w.name,
    quantity: w.id === 1 ? item.quantity : null,
    updatedAt: item.updatedAt,
    stores: linked.flatMap((v) => {
      const store = state.stores.find((s) => s.id === v.storeId);
      if (!store.locations.some((l) => l.warehouseId === w.id && l.isActive)) return [];
      const qty = w.id === 1 ? item.quantity : null;
      const shows =
        v.tracked && store.status === 'active' && qty !== null
          ? displayQuantity(qty, store.safetyBuffer)
          : null;
      return [
        {
          storeId: v.storeId,
          storeName: store.name,
          variantId: v.id,
          productTitle: v.productTitle,
          variantTitle: v.variantTitle,
          tracked: v.tracked,
          lastKnown: shows === null ? (qty === null ? null : qty) : shows + v.lastKnownOffset,
          shows,
          pendingWrite: v.pendingWrite,
        },
      ];
    }),
  }));
  if (levels.some((l) => l.stores.some((s) => s.pendingWrite)))
    issues.push('An update to a store is waiting to be confirmed');
  return {
    id: item.id,
    sku: item.sku,
    title: item.title,
    syncEnabled: item.syncEnabled,
    lowStockThreshold: item.lowStockThreshold,
    levels,
    issues,
  };
}

const storeName = (state, id) => state.stores.find((s) => s.id === id)?.name ?? null;

function alertView(state, a) {
  return {
    ...a,
    sku: state.items.find((i) => i.id === a.itemId)?.sku ?? null,
    storeName: storeName(state, a.storeId),
  };
}

function hasOpenAlert(state, itemId, kind) {
  return state.alerts.some(
    (a) => a.itemId === itemId && !a.resolvedAt && (!kind || a.kind === kind),
  );
}

const ITEM_FILTERS = {
  all: () => true,
  issues: (state, item) =>
    hasOpenAlert(state, item.id) || itemSummary(state, item).issues.length > 0,
  uninitialized: (_state, item) => item.quantity === null,
  low: (state, item) => hasOpenAlert(state, item.id, 'low_stock'),
  oversold: (_state, item) => item.quantity !== null && item.quantity < 0,
  disabled: (_state, item) => !item.syncEnabled,
};

function variantCategory(state, v) {
  if (v.isBundle || v.sku === null || (v.linkSource === 'manual' && v.itemId === null))
    return 'ignored';
  const duplicate = state.variants.some(
    (o) => o !== v && o.storeId === v.storeId && o.sku === v.sku && !o.deleted && !o.isBundle,
  );
  if (v.itemId === null && duplicate) return 'conflicts';
  if (v.itemId === null) return 'unmatched';
  const shared = state.variants.some(
    (o) => o.itemId === v.itemId && o.storeId !== v.storeId && !o.deleted,
  );
  return shared ? 'matched' : 'unmatched';
}

function status(state) {
  const live = state.items.filter((i) =>
    state.variants.some((v) => v.itemId === i.id && !v.deleted),
  );
  const unmatched = state.variants.filter(
    (v) => !v.deleted && variantCategory(state, v) === 'unmatched' && v.itemId !== null,
  ).length;
  const conflicts = state.variants.filter(
    (v) => !v.deleted && variantCategory(state, v) === 'conflicts',
  ).length;
  const open = state.alerts.filter((a) => !a.resolvedAt);
  const queued = state.pendingInit ?? 0;
  return {
    syncPaused: state.settings.syncPaused,
    pausedReason: state.settings.pausedReason,
    onboardingCompleted: state.settings.onboardingCompleted,
    queue: { ready: queued, delayed: 1, running: queued > 0 ? 1 : 0, failing: 0 },
    tasks: { ready: 0, running: 0, failing: 0 },
    items: {
      total: live.length,
      initialized: live.filter((i) => i.quantity !== null).length,
      uninitialized: live.filter((i) => i.quantity === null).length,
      disabled: live.filter((i) => !i.syncEnabled).length,
      lowStock: open.filter((a) => a.kind === 'low_stock').length,
      oversold: live.filter((i) => i.quantity !== null && i.quantity < 0).length,
    },
    stores: state.stores.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      lastWebhookAt: s.lastWebhookAt,
      lastDriftScanAt: s.lastDriftScanAt,
      lastDriftCount: s.lastDriftCount,
    })),
    openAlerts: open.length,
    unmatchedVariants: unmatched,
    conflicts,
  };
}

function preview(state, strategy, sourceStoreId) {
  const rows = [];
  for (const item of state.items.filter((i) => i.quantity === null && i.syncEnabled)) {
    const summary = itemSummary(state, item);
    const level = summary.levels[0];
    const members = level.stores.filter(
      (s) => s.tracked && state.stores.find((x) => x.id === s.storeId).status === 'active',
    );
    if (members.length === 0) continue;
    const stores = members.map((s, i) => ({
      storeId: s.storeId,
      storeName: s.storeName,
      live: i === 0 ? (item.id % 4) * 4 : item.id % 3 === 0 ? null : 7 + (item.id % 5),
    }));
    const values = stores.map((s) => s.live ?? 0);
    let proposed;
    if (strategy === 'store') {
      const source = stores.find((s) => s.storeId === sourceStoreId);
      proposed = source ? (source.live ?? 0) : null;
    } else if (strategy === 'min') proposed = Math.min(...values);
    else if (strategy === 'max') proposed = Math.max(...values);
    else proposed = values.reduce((a, b) => a + b, 0);
    const changes = [];
    if (proposed !== null) {
      for (const s of stores) {
        const buffer = state.stores.find((x) => x.id === s.storeId).safetyBuffer;
        const to = displayQuantity(proposed, buffer);
        if (s.live !== to) changes.push({ storeId: s.storeId, from: s.live, to });
      }
    }
    rows.push({
      poolLevelId: level.poolLevelId,
      itemId: item.id,
      sku: item.sku,
      title: item.title,
      warehouseId: 1,
      stores,
      proposed,
      changes,
    });
  }
  const summary = {
    items: rows.length,
    itemsChanging: 0,
    storesWrites: 0,
    unitsAdded: 0,
    unitsRemoved: 0,
    zeroedInSomeStore: 0,
    skipped: 0,
  };
  for (const row of rows) {
    if (row.proposed === null) summary.skipped++;
    if (row.changes.length) summary.itemsChanging++;
    let zeroed = false;
    for (const c of row.changes) {
      summary.storesWrites++;
      const delta = c.to - (c.from ?? 0);
      if (delta > 0) summary.unitsAdded += delta;
      else summary.unitsRemoved -= delta;
      if (c.to === 0 && (c.from ?? 0) > 0) zeroed = true;
    }
    if (zeroed) summary.zeroedInSomeStore++;
  }
  const excludedStores = state.stores
    .filter((s) => s.status !== 'active')
    .map((s) => ({
      storeId: s.id,
      storeName: s.name,
      reason: s.status === 'paused' ? 'paused' : 'can’t connect',
    }));
  return { rows, excludedStores, summary };
}

// ---------- routes ----------

function paginate(list, query) {
  const page = Math.max(1, Number(query.get('page') ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(query.get('pageSize') ?? 50)));
  return { page, pageSize, slice: list.slice((page - 1) * pageSize, page * pageSize) };
}

function matches(search, ...values) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return values.some((v) => v && String(v).toLowerCase().includes(needle));
}

function findOr404(list, id, what) {
  const found = list.find((x) => x.id === Number(id));
  if (!found) throw new HttpError(404, `${what} not found`);
  return found;
}

/** Helpers for the feature mocks (scripts/mock/*.mjs). */
const TOOLS = { reply, HttpError, paginate, matches, findOr404, minutesAgo, random };

function handle(state, method, pathname, query, body, contentType) {
  const parts = pathname.split('/').filter(Boolean).slice(1); // drop "api"
  // Numeric segments, wherever they are, become ":id": /purchasing/orders/:id/receipts/:id/reverse.
  const route = `${method} /${parts.map((p) => (/^\d+$/.test(p) ? ':id' : p)).join('/')}`;
  const ids = parts.filter((p) => /^\d+$/.test(p));
  const [id, subId] = ids;

  switch (route) {
    case 'GET /status':
      return status(state);

    case 'GET /stores':
      return state.stores.map((s) => storeView(state, s));
    case 'POST /stores': {
      const creds = body.authMode === 'access_token' ? body.accessToken : body.clientSecret;
      if (body.clientId === 'scopes') {
        throw new HttpError(
          400,
          `Could not connect to ${body.shopDomain}: the app is missing permissions.`,
          { missingScopes: ['write_inventory', 'read_locations'] },
        );
      }
      if (creds !== 'good-secret' && creds !== 'good-token') {
        throw new HttpError(
          400,
          `Could not connect to ${body.shopDomain}: Shopify rejected the credentials (HTTP 401).`,
          { missingScopes: [] },
        );
      }
      const store = {
        id: state.nextIds.store++,
        name: body.name,
        shopDomain: body.shopDomain,
        authMode: body.authMode,
        status: 'active',
        lastError: null,
        safetyBuffer: body.safetyBuffer ?? 0,
        hasWebhookSecret: true,
        clientId: body.clientId ?? null,
        lastWebhookAt: null,
        webhooksRegisteredAt: null,
        catalogSyncedAt: null,
        lastDriftScanAt: null,
        lastDriftCount: null,
        createdAt: new Date().toISOString(),
        currencyCode: 'USD',
        timezone: 'America/New_York',
        exchangeRate: 1,
        features: features(),
        scopesCheckedAt: new Date().toISOString(),
        locations: [],
      };
      state.stores.push(store);
      return reply(201, storeView(state, store));
    }
    case 'PATCH /stores/:id': {
      const store = findOr404(state.stores, id, 'Store');
      if (body.clientSecret === 'bad' || body.accessToken === 'bad') {
        throw new HttpError(
          400,
          `Could not connect to ${store.shopDomain}: Shopify rejected the credentials (HTTP 401).`,
          { missingScopes: [] },
        );
      }
      if (
        body.exchangeRate !== undefined &&
        !(typeof body.exchangeRate === 'number' && body.exchangeRate > 0)
      ) {
        throw new HttpError(400, 'exchangeRate: Too small: expected number to be >0');
      }
      for (const key of ['name', 'safetyBuffer', 'status', 'exchangeRate'])
        if (body[key] !== undefined) store[key] = body[key];
      if (body.status === 'active') store.lastError = null;
      return storeView(state, store);
    }
    case 'DELETE /stores/:id':
      findOr404(state.stores, id, 'Store');
      state.stores = state.stores.filter((s) => s.id !== Number(id));
      return reply(204);
    case 'POST /stores/:id/test': {
      const store = findOr404(state.stores, id, 'Store');
      return store.status === 'error'
        ? { ok: false, missingScopes: [], error: 'Shopify rejected the credentials (HTTP 401).' }
        : { ok: true, shopName: store.name, missingScopes: [] };
    }
    case 'POST /stores/:id/sync-catalog':
      findOr404(state.stores, id, 'Store');
      return reply(202, { queued: true });
    case 'POST /stores/:id/register-webhooks':
      findOr404(state.stores, id, 'Store');
      return { created: ['INVENTORY_LEVELS_UPDATE'], deleted: [] };
    case 'PUT /stores/:id/locations/:id': {
      const store = findOr404(state.stores, id, 'Store');
      const loc = findOr404(store.locations, subId, 'Location');
      const taken = store.locations.find(
        (l) => l.id !== loc.id && body.warehouseId !== null && l.warehouseId === body.warehouseId,
      );
      if (taken)
        throw new HttpError(
          409,
          `“${taken.name}” already holds this warehouse’s stock for this store. Unmap it first.`,
        );
      loc.warehouseId = body.warehouseId;
      return storeView(state, store);
    }

    case 'GET /warehouses':
      return state.warehouses.map((w) => ({
        ...w,
        mappedStores: state.stores.flatMap((s) => s.locations).filter((l) => l.warehouseId === w.id)
          .length,
      }));
    case 'POST /warehouses': {
      if (state.warehouses.some((w) => w.name === body.name))
        throw new HttpError(409, `A warehouse called “${body.name}” already exists`);
      const warehouse = { id: state.nextIds.warehouse++, name: body.name };
      state.warehouses.push(warehouse);
      return reply(201, { ...warehouse, mappedStores: 0 });
    }
    case 'PATCH /warehouses/:id': {
      const warehouse = findOr404(state.warehouses, id, 'Warehouse');
      warehouse.name = body.name;
      return { ...warehouse, mappedStores: 0 };
    }
    case 'DELETE /warehouses/:id':
      findOr404(state.warehouses, id, 'Warehouse');
      state.warehouses = state.warehouses.filter((w) => w.id !== Number(id));
      return reply(204);

    case 'GET /items': {
      const filter = ITEM_FILTERS[query.get('filter') ?? 'all'];
      const search = query.get('search') ?? '';
      const list = state.items
        .filter((i) => filter(state, i))
        .filter((i) => matches(search, i.sku, i.title))
        .sort((a, b) => a.sku.localeCompare(b.sku));
      const { page, pageSize, slice } = paginate(list, query);
      return { total: list.length, page, pageSize, items: slice.map((i) => itemSummary(state, i)) };
    }
    case 'GET /items/:id': {
      const item = findOr404(state.items, id, 'Item');
      return {
        ...itemSummary(state, item),
        events: state.events
          .filter((e) => e.itemId === item.id)
          .reverse()
          .slice(0, 100),
        alerts: state.alerts.filter((a) => a.itemId === item.id).map((a) => alertView(state, a)),
      };
    }
    case 'POST /items': {
      if (state.items.some((i) => i.sku === body.sku))
        throw new HttpError(409, `An item with SKU ${body.sku} already exists`);
      const item = {
        id: state.nextIds.item++,
        sku: body.sku,
        title: body.title ?? '',
        syncEnabled: true,
        lowStockThreshold: null,
        quantity: null,
        updatedAt: new Date().toISOString(),
      };
      state.items.push(item);
      return reply(201, itemSummary(state, item));
    }
    case 'PATCH /items/:id': {
      const item = findOr404(state.items, id, 'Item');
      for (const key of ['title', 'syncEnabled', 'lowStockThreshold'])
        if (body[key] !== undefined) item[key] = body[key];
      return itemSummary(state, item);
    }
    case 'POST /items/:id/adjust': {
      const item = findOr404(state.items, id, 'Item');
      if (item.quantity === null)
        throw new HttpError(
          400,
          'This item has not started syncing yet. Start it from the onboarding screen first.',
        );
      const before = item.quantity;
      // A shelf count: pretend 3 units are sold and waiting to ship across the stores.
      const AFTER = { set: body.value, count: body.value - 3, adjust: before + body.value };
      const EVENT = { set: 'manual_set', count: 'stock_count', adjust: 'manual_adjust' };
      item.quantity = AFTER[body.kind];
      item.updatedAt = new Date().toISOString();
      state.events.push({
        id: state.events.length + 1,
        kind: EVENT[body.kind],
        itemId: item.id,
        sku: item.sku,
        storeId: null,
        storeName: null,
        delta: item.quantity - before,
        quantityBefore: before,
        quantityAfter: item.quantity,
        message: body.note ?? null,
        details: null,
        createdAt: new Date().toISOString(),
      });
      return reply(202, { queued: true });
    }
    case 'POST /items/:id/resync':
      findOr404(state.items, id, 'Item');
      return reply(202, { queued: true });

    case 'GET /variants': {
      const filter = query.get('filter') ?? 'unmatched';
      const storeId = Number(query.get('storeId') ?? 0);
      const search = query.get('search') ?? '';
      const list = state.variants
        .filter((v) => !v.deleted && (filter === 'all' || variantCategory(state, v) === filter))
        .filter((v) => !storeId || v.storeId === storeId)
        .filter((v) => matches(search, v.sku, v.productTitle, v.barcode));
      const { slice } = paginate(list, query);
      return {
        total: list.length,
        variants: slice.map((v) => ({
          id: v.id,
          storeId: v.storeId,
          storeName: storeName(state, v.storeId),
          sku: v.sku,
          barcode: v.barcode,
          productTitle: v.productTitle,
          variantTitle: v.variantTitle,
          tracked: v.tracked,
          isBundle: v.isBundle,
          itemId: v.itemId,
          itemSku: state.items.find((i) => i.id === v.itemId)?.sku ?? null,
          linkSource: v.linkSource,
          deleted: v.deleted,
        })),
      };
    }
    case 'PUT /variants/:id/link': {
      const variant = findOr404(state.variants, id, 'Variant');
      if (
        body.itemId !== null &&
        state.variants.some(
          (o) =>
            o !== variant &&
            o.storeId === variant.storeId &&
            o.itemId === body.itemId &&
            !o.deleted,
        )
      ) {
        throw new HttpError(400, 'This store already has another variant linked to that item');
      }
      variant.itemId = body.itemId;
      variant.linkSource = 'manual';
      return { ok: true };
    }
    case 'DELETE /variants/:id/link': {
      const variant = findOr404(state.variants, id, 'Variant');
      variant.linkSource = 'auto';
      return { ok: true };
    }

    case 'GET /onboarding/preview':
      return preview(state, query.get('strategy'), Number(query.get('sourceStoreId') ?? 0));
    case 'POST /onboarding/apply': {
      const ids = new Set(body.poolLevelIds ?? []);
      const rows = preview(state, body.strategy, body.sourceStoreId).rows.filter(
        (r) => r.proposed !== null && (!body.poolLevelIds || ids.has(r.poolLevelId)),
      );
      for (const row of rows) state.items.find((i) => i.id === row.itemId).quantity = row.proposed;
      state.settings.onboardingCompleted = true;
      return { queued: rows.length };
    }

    case 'GET /events': {
      const itemId = Number(query.get('itemId') ?? 0);
      const storeId = Number(query.get('storeId') ?? 0);
      const kind = query.get('kind');
      const before = Number(query.get('before') ?? 0);
      const limit = Number(query.get('limit') ?? 50);
      const list = [...state.events]
        .reverse()
        .filter(
          (e) =>
            (!itemId || e.itemId === itemId) &&
            (!storeId || e.storeId === storeId) &&
            (!kind || e.kind === kind) &&
            (!before || e.id < before),
        );
      const page = list.slice(0, limit);
      return { events: page, nextBefore: list.length > limit ? page.at(-1).id : null };
    }

    case 'GET /alerts': {
      const all = query.get('status') === 'all';
      return state.alerts
        .filter((a) => all || !a.resolvedAt)
        .sort(
          (a, b) =>
            Number(Boolean(a.resolvedAt)) - Number(Boolean(b.resolvedAt)) ||
            b.createdAt.localeCompare(a.createdAt),
        )
        .map((a) => alertView(state, a));
    }
    case 'POST /alerts/:id/resolve': {
      const alert = findOr404(state.alerts, id, 'Alert');
      alert.resolvedAt ??= new Date().toISOString();
      return { ok: true };
    }

    case 'GET /settings':
      return state.settings;
    case 'PATCH /settings':
      Object.assign(state.settings, body);
      return state.settings;
    case 'POST /settings/pause':
      Object.assign(state.settings, {
        syncPaused: true,
        pausedReason: body.reason || 'Paused from the dashboard',
      });
      return state.settings;
    case 'POST /settings/resume':
      Object.assign(state.settings, { syncPaused: false, pausedReason: null });
      return state.settings;
    case 'POST /settings/test-alert':
      return { ok: true };

    default: {
      // req: the request, for the feature mocks. `body` is the parsed JSON, or a Buffer for an
      // upload (image/* content types); `ids` are all numeric segments in order.
      const req = { method, route, parts, id, subId, ids, query, body, contentType, state };
      for (const feature of FEATURES) {
        const result = feature.handle(req, TOOLS);
        if (result !== undefined) return result;
      }
      throw new HttpError(404, `No mock for ${route}`);
    }
  }
}

/** Starts the mock on `port` (0 = any free port). `state` can be replaced between tests. */
export async function startMockServer({ port = 0, state = createMockState() } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (server.state.signedOut) throw new HttpError(401, 'Authentication required');
        // Same CSRF rule as the real server (src/http/auth.ts).
        if (
          !['GET', 'HEAD'].includes(req.method) &&
          req.headers['x-requested-with'] !== 'store-sync'
        ) {
          throw new HttpError(403, 'Changes must be made from the dashboard.');
        }
        if (server.state.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, server.state.delayMs));
        }
        const raw = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });
        const contentType = req.headers['content-type'] ?? '';
        const json = contentType.startsWith('application/json');
        // Uploads (images) come as the raw body, like the real server's image parser.
        const upload = contentType.startsWith('image/');
        if (raw.length && !json && !upload) throw new HttpError(415, 'Send JSON');
        if (!raw.length && json) {
          // Fastify rejects this too; the dashboard must not send it.
          throw new HttpError(
            400,
            "Body cannot be empty when content-type is set to 'application/json'",
          );
        }
        const body = upload ? raw : raw.length ? JSON.parse(raw.toString('utf8')) : {};
        const result = handle(
          server.state,
          req.method,
          url.pathname,
          url.searchParams,
          body,
          contentType,
        );
        const wrapped = result?.[REPLY] ? result : reply(200, result);
        if (wrapped.headers) {
          res.writeHead(wrapped.status, { ...SECURITY_HEADERS, ...wrapped.headers });
          res.end(wrapped.body);
          return;
        }
        res.writeHead(wrapped.status, {
          ...SECURITY_HEADERS,
          ...(wrapped.status === 204 ? {} : { 'Content-Type': 'application/json' }),
        });
        res.end(wrapped.status === 204 ? undefined : JSON.stringify(wrapped.body));
        return;
      }
      const file = path.join(
        PUBLIC_DIR,
        url.pathname === '/' ? 'index.html' : path.normalize(url.pathname),
      );
      if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, 'Not found');
      const content = await readFile(file).catch(() => {
        throw new HttpError(404, 'Not found');
      });
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      });
      res.end(content);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, ...(err.details ?? {}) }));
    }
  });
  server.state = state;
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startMockServer({ port: Number(process.argv[2] ?? 4321) });
  console.log(`Mock dashboard API running at ${url}`);
}
