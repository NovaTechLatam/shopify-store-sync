// Mock API for Prices (/api/prices/...), plugged into ../dashboard-mock-api.mjs. Same routes and
// response shapes as src/http/api/prices.ts, with the dashboard's own copy of the price maths
// (public/js/pricing-compute.js, checked against the server's in test/pricing-vectors.test.ts).
import {
  computeTargetPrice,
  currencyDecimals,
  roundMoney,
  roundPrice,
} from '../../public/js/pricing-compute.js';

const DAY = 24 * 60;

/** Base prices (USD) and compare-at prices of the seeded products, by SKU prefix. */
const BASES = {
  'TEE-ORG': [24.99, null],
  'HOOD-CLS': [59.99, 69.99],
  'CAP-WAX': [19.99, null],
  'SOCK-MER': [12.99, null],
  'TOTE-CNV': [15.99, 19.99],
  'BEANIE-WOL': [26, null],
  // JKT-RAIN has no base price yet ("No base price" filter).
};

const RULE_DEFAULTS = {
  enabled: false,
  multiplier: 1,
  addAmount: 0,
  roundMode: 'none',
  roundStep: 1,
  roundEnding: 0,
  roundDirection: 'nearest',
  compareAtMode: 'from_base',
  compareAtMarkup: 1,
};

const COMPARE_AT_ABOVE =
  'The compare-at price must be higher than the price (it’s shown crossed out). Leave it empty for none.';

const inMinutes = (n) => new Date(Date.now() + n * 60_000).toISOString();
const prefix = (sku) => sku.split('-').slice(0, 2).join('-');

/**
 * Adds this feature's data to a fresh mock state (called at the end of createMockState()):
 * base prices and costs, the stores' prices, a rule per store (USD ending in .99, COP ending in
 * 900, CLP off), fixed prices, sales and price changes in every state, and a history with errors.
 */
export function seed(state, { minutesAgo }) {
  for (const item of state.items) {
    const [base, compareAt] = BASES[prefix(item.sku)] ?? [null, null];
    // The stray SKU (a typo in one store) has no prices.
    const stray = item.sku === 'TEE-ORG-BLKK-M';
    item.basePrice = stray ? null : base;
    item.baseCompareAtPrice = stray ? null : compareAt;
    item.cost =
      base === null || stray || prefix(item.sku) === 'SOCK-MER'
        ? null
        : roundMoney(base * (prefix(item.sku) === 'CAP-WAX' ? 0.62 : 0.38), 2);
  }

  const rules = {
    // Northwind (USD): prices end in .99.
    1: {
      ...RULE_DEFAULTS,
      enabled: true,
      roundMode: 'ending',
      roundStep: 1,
      roundEnding: 0.99,
      roundDirection: 'up',
      updatedAt: minutesAgo(12 * DAY),
    },
    // Harbor & Pine (COP): 10% above the converted price, ending in 900.
    2: {
      ...RULE_DEFAULTS,
      enabled: true,
      multiplier: 1.1,
      roundMode: 'ending',
      roundStep: 1000,
      roundEnding: 900,
      roundDirection: 'nearest',
      updatedAt: minutesAgo(12 * DAY),
    },
    // Little Fox Kids (CLP) sets its own prices in Shopify.
    3: { ...RULE_DEFAULTS, roundMode: 'multiple', roundStep: 10, updatedAt: minutesAgo(30 * DAY) },
  };
  const pricing = {
    rules,
    overrides: [],
    schedules: [],
    runs: [],
    nextIds: { schedule: 1, run: 1 },
  };
  state.pricing = pricing;

  const itemsOf = (p) =>
    state.items.filter((i) => prefix(i.sku) === p && i.sku !== 'TEE-ORG-BLKK-M').map((i) => i.id);
  const hoodies = itemsOf('HOOD-CLS');
  const caps = itemsOf('CAP-WAX');

  // Sales and price changes in every state.
  const addSchedule = (s) => {
    const schedule = {
      id: pricing.nextIds.schedule++,
      storeIds: null,
      itemIds: [],
      percentOff: null,
      showCompareAt: true,
      changes: [],
      previous: null,
      error: null,
      startedAt: null,
      endedAt: null,
      createdAt: minutesAgo(20 * DAY),
      ...s,
    };
    pricing.schedules.push(schedule);
    return schedule;
  };
  const autumn = addSchedule({
    name: 'Autumn hoodie weekend',
    kind: 'sale',
    status: 'active',
    startsAt: minutesAgo(DAY),
    endsAt: inMinutes(2 * DAY + 180),
    storeIds: [1],
    itemIds: hoodies,
    percentOff: 20,
    startedAt: minutesAgo(DAY),
  });
  addSchedule({
    name: 'Black Friday',
    kind: 'sale',
    status: 'scheduled',
    startsAt: inMinutes(34 * DAY),
    endsAt: inMinutes(37 * DAY),
    itemIds: itemsOf('TEE-ORG'),
    percentOff: 25,
  });
  addSchedule({
    name: 'January prices',
    kind: 'base_change',
    status: 'scheduled',
    startsAt: inMinutes(75 * DAY),
    endsAt: null,
    itemIds: caps,
    changes: caps.map((itemId) => ({ itemId, basePrice: 21.99, baseCompareAtPrice: null })),
  });
  addSchedule({
    name: 'Summer clearance',
    kind: 'sale',
    status: 'ended',
    startsAt: minutesAgo(45 * DAY),
    endsAt: minutesAgo(40 * DAY),
    itemIds: itemsOf('TOTE-CNV'),
    percentOff: 30,
    previous: itemsOf('TOTE-CNV').map((itemId) => ({ storeId: 1, itemId })),
    startedAt: minutesAgo(45 * DAY),
    endedAt: minutesAgo(40 * DAY),
  });
  addSchedule({
    name: 'Kids week',
    kind: 'sale',
    status: 'failed',
    startsAt: minutesAgo(8 * DAY),
    endsAt: minutesAgo(DAY),
    storeIds: [3],
    itemIds: itemsOf('JKT-RAIN'),
    percentOff: 15,
    error:
      'none of its products is sold in its stores with a known price, so nothing went on sale.',
  });
  addSchedule({
    name: 'Flash sale',
    kind: 'sale',
    status: 'cancelled',
    startsAt: minutesAgo(3 * DAY),
    endsAt: minutesAgo(2 * DAY),
    itemIds: itemsOf('SOCK-MER'),
    percentOff: 10,
    endedAt: minutesAgo(4 * DAY),
  });

  // Fixed prices: the running sale's, and two set by hand.
  for (const itemId of hoodies) {
    pricing.overrides.push({
      storeId: 1,
      itemId,
      price: 47.99,
      compareAtPrice: 59.99,
      note: `Sale: ${autumn.name}`,
      scheduleId: autumn.id,
      updatedAt: minutesAgo(DAY),
    });
  }
  autumn.previous = hoodies.map((itemId) => ({ storeId: 1, itemId }));
  pricing.overrides.push(
    {
      storeId: 2,
      itemId: 1,
      price: 99900,
      compareAtPrice: null,
      note: 'Matches the price at our Bogotá shop',
      scheduleId: null,
      updatedAt: minutesAgo(9 * DAY),
    },
    {
      storeId: 3,
      itemId: itemsOf('SOCK-MER')[0],
      price: 9990,
      compareAtPrice: 12990,
      note: null,
      scheduleId: null,
      updatedAt: minutesAgo(15 * DAY),
    },
  );

  // What the stores charge now: mostly their targets, with a few that will change.
  for (const v of state.variants) {
    const item = state.items.find((i) => i.id === v.itemId);
    const store = state.stores.find((s) => s.id === v.storeId);
    v.price = null;
    v.compareAtPrice = null;
    if (!item || !store) continue;
    const c = cell(state, item, store);
    if (c.target.status === 'ok') {
      v.price = c.target.price;
      v.compareAtPrice = c.target.compareAtPrice === 'keep' ? null : c.target.compareAtPrice;
    }
    const p = prefix(item.sku);
    if (store.id === 1 && p === 'SOCK-MER') v.price = 11.99; // goes up
    if (store.id === 1 && p === 'CAP-WAX' && item.sku.endsWith('-M')) v.price = 34.99; // big drop
    if (store.id === 2 && p === 'TEE-ORG' && c.source === 'rule') v.price = 99900; // goes up
    if (store.id === 1 && p === 'JKT-RAIN') v.price = 129;
    if (store.id === 2 && p === 'JKT-RAIN') v.price = 529900;
    if (store.id === 3) {
      v.price = { 'TEE-ORG': 22990, 'SOCK-MER': 11990 }[p] ?? 19990;
      if (c.source === 'override') v.price = c.target.price;
    }
  }

  // The history: a failed one, one with refusals, a sale's start, the latest manual one.
  const storeResult = (storeId, s) => ({
    storeId,
    status: 'done',
    checked: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    error: null,
    errors: [],
    ...s,
  });
  const addRun = (r) => {
    const run = { id: pricing.nextIds.run++, itemIds: null, scheduleId: null, polls: 0, ...r };
    for (const s of run.stores) {
      s.startedAt = run.createdAt;
      s.finishedAt = run.finishedAt;
    }
    pricing.runs.unshift(run);
  };
  addRun({
    reason: 'manual',
    status: 'failed',
    createdAt: minutesAgo(5 * DAY),
    finishedAt: minutesAgo(5 * DAY - 2),
    stores: [
      storeResult(1, { checked: 57, updated: 12, skipped: 6 }),
      storeResult(3, {
        status: 'failed',
        error:
          'We can’t connect to “Little Fox Kids” right now. Fix the connection on its page, then update prices again.',
      }),
    ],
  });
  addRun({
    reason: 'manual',
    status: 'done',
    createdAt: minutesAgo(DAY + 300),
    finishedAt: minutesAgo(DAY + 296),
    stores: [
      storeResult(1, { checked: 57, updated: 3, skipped: 6 }),
      storeResult(2, {
        checked: 51,
        updated: 9,
        failed: 2,
        skipped: 6,
        errors: [
          { sku: 'JKT-RAIN-YEL-M', message: 'Product variant does not exist' },
          { sku: 'JKT-RAIN-BLA-L', message: 'Price must be greater than or equal to 0' },
        ],
      }),
    ],
  });
  addRun({
    reason: 'sale_start',
    scheduleId: autumn.id,
    itemIds: hoodies,
    status: 'done',
    createdAt: minutesAgo(DAY),
    finishedAt: minutesAgo(DAY - 1),
    stores: [storeResult(1, { checked: 6, updated: 6 })],
  });
  addRun({
    reason: 'manual',
    status: 'done',
    createdAt: minutesAgo(190),
    finishedAt: minutesAgo(187),
    stores: [
      storeResult(1, { checked: 57, updated: 4, skipped: 6 }),
      storeResult(2, { checked: 51, skipped: 6 }),
    ],
  });
}

// ---------- the price maths, as the server does it ----------

const storeOf = (state, id) => state.stores.find((s) => s.id === id);

function variantOf(state, itemId, storeId) {
  return state.variants.find(
    (v) => v.itemId === itemId && v.storeId === storeId && !v.deleted && !v.isBundle,
  );
}

function overrideOf(state, itemId, storeId) {
  return state.pricing.overrides.find((o) => o.itemId === itemId && o.storeId === storeId);
}

function differs(current, target, currencyCode) {
  if (!current || target.status !== 'ok') return false;
  const d = currencyDecimals(currencyCode);
  if (roundMoney(current.price, d) !== target.price) return true;
  if (target.compareAtPrice === 'keep') return false;
  const compareAt =
    current.compareAtPrice === null || current.compareAtPrice <= 0
      ? null
      : roundMoney(current.compareAtPrice, d);
  return compareAt !== target.compareAtPrice;
}

function cell(state, item, store) {
  const variant = variantOf(state, item.id, store.id);
  const override = overrideOf(state, item.id, store.id);
  const rule = state.pricing.rules[store.id] ?? null;
  const target = computeTargetPrice({
    basePrice: item.basePrice ?? null,
    baseCompareAtPrice: item.baseCompareAtPrice ?? null,
    exchangeRate: store.exchangeRate,
    rule,
    currencyCode: store.currencyCode,
    override: override ? { price: override.price, compareAtPrice: override.compareAtPrice } : null,
  });
  const current =
    variant && variant.price !== null && variant.price !== undefined
      ? { price: variant.price, compareAtPrice: variant.compareAtPrice ?? null }
      : null;
  let source = null;
  if (target.status === 'ok') {
    if (target.source === 'rule') source = 'rule';
    else source = override.scheduleId ? 'sale' : 'override';
  }
  const shown = target.status === 'ok' ? target.price : (current?.price ?? null);
  const cost = item.cost ?? null;
  return {
    storeId: store.id,
    sold: Boolean(variant),
    current,
    target,
    source,
    override: override
      ? {
          price: override.price,
          compareAtPrice: override.compareAtPrice,
          note: override.note,
          scheduleId: override.scheduleId,
          scheduleName:
            state.pricing.schedules.find((s) => s.id === override.scheduleId)?.name ?? null,
        }
      : null,
    differs: Boolean(variant) && differs(current, target, store.currencyCode),
    margin:
      shown === null || cost === null || !(shown > 0)
        ? null
        : (shown - cost * store.exchangeRate) / shown,
  };
}

function priceStoreView(state, store) {
  return {
    id: store.id,
    name: store.name,
    status: store.status,
    currencyCode: store.currencyCode,
    currencyKnown: true,
    exchangeRate: store.exchangeRate,
    ruleEnabled: Boolean(state.pricing.rules[store.id]?.enabled),
    canUpdate: store.features.pricing.available,
    missingScopes: store.features.pricing.missingScopes,
  };
}

function itemView(state, item, stores) {
  return {
    itemId: item.id,
    sku: item.sku,
    title: item.title,
    basePrice: item.basePrice ?? null,
    baseCompareAtPrice: item.baseCompareAtPrice ?? null,
    cost: item.cost ?? null,
    stores: stores.map((s) => cell(state, item, s)),
  };
}

function matchingItems(state, { search, filter, storeId }, matches) {
  const stores = storeId ? state.stores.filter((s) => s.id === storeId) : state.stores;
  return state.items
    .filter((i) => matches(search, i.sku, i.title))
    .filter((i) => {
      switch (filter) {
        case 'missing_base':
          return i.basePrice === null || i.basePrice === undefined;
        case 'overrides':
          return state.pricing.overrides.some(
            (o) => o.itemId === i.id && (!storeId || o.storeId === storeId),
          );
        case 'changes':
          return stores.some((s) => cell(state, i, s).differs);
        default:
          return true;
      }
    })
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

function ruleView(state, store) {
  const saved = state.pricing.rules[store.id];
  const { updatedAt, ...rule } = saved ?? { ...RULE_DEFAULTS, updatedAt: null };
  return {
    storeId: store.id,
    storeName: store.name,
    status: store.status,
    currencyCode: store.currencyCode,
    currencyKnown: true,
    exchangeRate: store.exchangeRate,
    canUpdate: store.features.pricing.available,
    missingScopes: store.features.pricing.missingScopes,
    saved: Boolean(saved),
    updatedAt,
    rule,
  };
}

/** A few items with different base prices (cheap, middle, dear), as the server picks them. */
function samples(state) {
  const byPrice = new Map();
  for (const i of [...state.items].sort((a, b) => a.sku.localeCompare(b.sku))) {
    if (i.basePrice !== null && i.basePrice !== undefined && !byPrice.has(i.basePrice)) {
      byPrice.set(i.basePrice, i);
    }
  }
  const rows = [...byPrice.values()].sort((a, b) => a.basePrice - b.basePrice);
  if (rows.length === 0) return [];
  return [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])]
    .filter((n) => n >= 0)
    .map((n) => rows[n])
    .map((i) => ({
      itemId: i.id,
      sku: i.sku,
      title: i.title,
      basePrice: i.basePrice,
      baseCompareAtPrice: i.baseCompareAtPrice ?? null,
    }));
}

const busyStoreIds = (state) =>
  new Set(
    state.pricing.runs.flatMap((r) =>
      r.stores.filter((s) => ['queued', 'running'].includes(s.status)).map((s) => s.storeId),
    ),
  );

function unavailable(store) {
  if (store.status === 'active') return null;
  if (store.status === 'paused')
    return `“${store.name}” is paused. Resume it on its page, then update prices again.`;
  return `We can’t connect to “${store.name}” right now. Fix the connection on its page, then update prices again.`;
}

function managed(state, store) {
  return (
    Boolean(state.pricing.rules[store.id]?.enabled) ||
    state.pricing.overrides.some((o) => o.storeId === store.id)
  );
}

function preview(state, storeIds, itemIds) {
  const busy = busyStoreIds(state);
  return {
    baseCurrency: state.settings.baseCurrency,
    stores: state.stores
      .filter((s) => !storeIds || storeIds.includes(s.id))
      .map((store) => {
        const counts = {
          checked: 0,
          changes: 0,
          increases: 0,
          decreases: 0,
          missingBase: 0,
          unknown: 0,
        };
        const drops = [];
        for (const item of state.items) {
          if (itemIds && !itemIds.includes(item.id)) continue;
          if (!variantOf(state, item.id, store.id)) continue;
          const c = cell(state, item, store);
          if (c.target.status !== 'ok') {
            if (c.target.reason === 'no_base_price') counts.missingBase++;
            continue;
          }
          counts.checked++;
          if (!c.current) {
            counts.unknown++;
            continue;
          }
          if (!c.differs) continue;
          counts.changes++;
          const from = c.current.price;
          const to = c.target.price;
          if (to > from) counts.increases++;
          if (to < from) {
            counts.decreases++;
            const change = from > 0 ? (to - from) / from : 0;
            if (change <= -0.2)
              drops.push({ itemId: item.id, sku: item.sku, title: item.title, from, to, change });
          }
        }
        const reason = !managed(state, store)
          ? 'Store Sync doesn’t manage prices in this store: its price rule is off and it has no fixed prices.'
          : (unavailable(store) ??
            (busy.has(store.id)
              ? `Prices are already being updated in “${store.name}”. Wait until that finishes.`
              : null));
        drops.sort((a, b) => a.change - b.change);
        return {
          storeId: store.id,
          storeName: store.name,
          currencyCode: store.currencyCode,
          status: store.status,
          ruleEnabled: Boolean(state.pricing.rules[store.id]?.enabled),
          overrides: state.pricing.overrides.filter((o) => o.storeId === store.id).length,
          canUpdate: reason === null,
          busy: busy.has(store.id),
          reason,
          ...counts,
          bigDrops: drops.slice(0, 10),
          bigDropCount: drops.length,
        };
      }),
  };
}

// ---------- runs ----------

/** Each look at a run moves it on: queued → running → done (writing the prices then). */
function advance(state, run) {
  if (!['queued', 'running'].includes(run.status)) return;
  run.polls++;
  if (run.polls === 1) {
    run.status = 'running';
    for (const s of run.stores) {
      if (s.status !== 'queued') continue;
      s.status = 'running';
      s.startedAt = new Date().toISOString();
    }
    return;
  }
  for (const s of run.stores) {
    if (s.status !== 'running') continue;
    const store = storeOf(state, s.storeId);
    for (const item of state.items) {
      if (run.itemIds && !run.itemIds.includes(item.id)) continue;
      const v = variantOf(state, item.id, store.id);
      if (!v) continue;
      const c = cell(state, item, store);
      if (c.target.status !== 'ok') {
        if (c.target.reason === 'no_base_price') {
          s.checked++;
          s.skipped++;
        }
        continue;
      }
      s.checked++;
      if (!c.differs) continue;
      v.price = c.target.price;
      if (c.target.compareAtPrice !== 'keep') v.compareAtPrice = c.target.compareAtPrice;
      s.updated++;
    }
    s.status = 'done';
    s.finishedAt = new Date().toISOString();
  }
  run.status = run.stores.some((s) => s.status === 'failed') ? 'failed' : 'done';
  run.finishedAt = new Date().toISOString();
}

function runView(state, run) {
  const schedule = run.scheduleId
    ? state.pricing.schedules.find((s) => s.id === run.scheduleId)
    : null;
  return {
    id: run.id,
    reason: run.reason,
    schedule: schedule ? { id: schedule.id, name: schedule.name, kind: schedule.kind } : null,
    itemCount: run.itemIds ? run.itemIds.length : null,
    status: run.status,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt ?? null,
    stores: run.stores.map((s) => ({
      storeId: s.storeId,
      storeName: storeOf(state, s.storeId)?.name ?? 'Removed store',
      status: s.status,
      checked: s.checked,
      updated: s.updated,
      failed: s.failed,
      skipped: s.skipped,
      error: s.error,
      errors: s.errors,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
    })),
  };
}

function createRun(state, { reason, scheduleId = null, itemIds = null, storeIds = null }) {
  const stores = state.stores.filter(
    (store) => (!storeIds || storeIds.includes(store.id)) && managed(state, store),
  );
  if (stores.length === 0) return null;
  const plans = stores.map((store) => {
    const error = unavailable(store);
    return {
      storeId: store.id,
      status: error ? 'failed' : 'queued',
      checked: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
      error,
      errors: [],
      startedAt: null,
      finishedAt: error ? new Date().toISOString() : null,
    };
  });
  const run = {
    id: state.pricing.nextIds.run++,
    reason,
    scheduleId,
    itemIds,
    status: plans.every((p) => p.status === 'failed') ? 'failed' : 'queued',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    polls: 0,
    stores: plans,
  };
  state.pricing.runs.unshift(run);
  return run;
}

// ---------- schedules ----------

function scheduleView(state, s) {
  const item = (id) => state.items.find((i) => i.id === id);
  const runs = state.pricing.runs.filter((r) => r.scheduleId === s.id);
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    status: s.status,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    storeIds: s.storeIds,
    stores: state.stores
      .filter((st) => s.storeIds === null || s.storeIds.includes(st.id))
      .map((st) => ({ id: st.id, name: st.name })),
    itemIds: s.itemIds,
    items: s.itemIds.flatMap((id) =>
      item(id) ? [{ itemId: id, sku: item(id).sku, title: item(id).title }] : [],
    ),
    percentOff: s.percentOff,
    showCompareAt: s.showCompareAt,
    changes: s.changes.map((c) => ({
      ...c,
      sku: item(c.itemId)?.sku ?? null,
      title: item(c.itemId)?.title ?? null,
      currentBasePrice: item(c.itemId)?.basePrice ?? null,
      previousBasePrice: null,
    })),
    pricesChanged: s.kind === 'sale' && s.previous ? s.previous.length : null,
    error: s.error,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    lastRun: runs[0] ? { id: runs[0].id, status: runs[0].status } : null,
  };
}

const STATUS_ORDER = { active: 0, scheduled: 1, failed: 2 };

function listSchedules(state) {
  return [...state.pricing.schedules]
    .sort(
      (a, b) =>
        (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) ||
        (['active', 'scheduled'].includes(a.status)
          ? a.startsAt.localeCompare(b.startsAt)
          : (b.endedAt ?? b.startsAt).localeCompare(a.endedAt ?? a.startsAt)),
    )
    .map((s) => scheduleView(state, s));
}

/** The server's checks (zod first, then src/pricing/schedules.ts), with its messages. */
function validateSchedule(state, input, id, HttpError) {
  const itemIds = input.kind === 'sale' ? input.itemIds : input.changes.map((c) => c.itemId);
  if (!input.name?.trim()) throw new HttpError(400, 'name: Too small');
  if (!itemIds?.length) throw new HttpError(400, 'itemIds: Too small');
  if (Number.isNaN(Date.parse(input.startsAt))) throw new HttpError(400, 'startsAt: Invalid');
  if (input.kind === 'base_change') {
    const bad = input.changes.some(
      (c) => c.baseCompareAtPrice !== null && c.baseCompareAtPrice <= c.basePrice,
    );
    if (bad) {
      throw new HttpError(
        400,
        'A compare-at price must be higher than the price (it’s shown crossed out). Leave it empty for none.',
      );
    }
    return;
  }
  if (!(input.percentOff >= 1 && input.percentOff <= 99))
    throw new HttpError(400, 'percentOff: Too big or too small');
  if (Date.parse(input.endsAt) <= Date.parse(input.startsAt))
    throw new HttpError(400, 'The sale must end after it starts.');
  if (Date.parse(input.endsAt) <= Date.now())
    throw new HttpError(400, 'The end of the sale is in the past. Choose a later end.');
  const other = state.pricing.schedules.find(
    (s) =>
      s.id !== id &&
      s.kind === 'sale' &&
      ['scheduled', 'active'].includes(s.status) &&
      s.startsAt < input.endsAt &&
      s.endsAt > input.startsAt &&
      (s.storeIds === null ||
        input.storeIds === null ||
        s.storeIds.some((x) => input.storeIds.includes(x))) &&
      s.itemIds.some((x) => input.itemIds.includes(x)),
  );
  if (other) {
    throw new HttpError(
      409,
      `This sale overlaps “${other.name}”, which puts some of the same products on sale in the ` +
        'same stores at the same time. Change the dates, the products or the stores.',
    );
  }
}

function bulkChange(state, body, list, HttpError) {
  const base = state.settings.baseCurrency;
  const field = body.field;
  const rounding = body.rounding
    ? {
        roundMode: body.rounding.mode,
        roundStep: body.rounding.step,
        roundEnding: body.rounding.ending ?? 0,
        roundDirection: body.rounding.direction ?? 'nearest',
      }
    : null;
  const results = [];
  let skipped = 0;
  for (const item of list) {
    const old = item[field] ?? null;
    let next;
    if (body.op === 'set') next = body.value;
    else if (old === null) {
      skipped++;
      continue;
    } else if (body.op === 'percent') next = old * (1 + body.value / 100);
    else if (body.op === 'add') next = old + body.value;
    else next = old;
    if (next !== null && next < 0) {
      throw new HttpError(
        400,
        `This would make the ${field === 'cost' ? 'cost' : 'price'} negative for ${item.sku}. Nothing was changed.`,
      );
    }
    if (next !== null) {
      next = rounding ? roundPrice(next, rounding, base) : roundMoney(next, currencyDecimals(base));
    }
    results.push([item, next]);
  }
  // Like the API: what the confirmation warns about (values removed, compare-at prices that end up
  // at or below the base price).
  let updated = 0;
  let cleared = 0;
  let compareAtLost = 0;
  for (const [item, next] of results) {
    const old = item[field] ?? null;
    if (old === next) continue;
    updated++;
    if (next === null) cleared++;
    const price = field === 'basePrice' ? next : (item.basePrice ?? null);
    const compareAt = field === 'baseCompareAtPrice' ? next : (item.baseCompareAtPrice ?? null);
    const before = [item.basePrice ?? null, item.baseCompareAtPrice ?? null];
    const wasAbove = before[0] === null || before[1] === null || before[1] > before[0];
    if (field !== 'cost' && wasAbove && price !== null && compareAt !== null && compareAt <= price)
      compareAtLost++;
    if (!body.dryRun) item[field] = next;
  }
  const counts = { updated, skipped, unchanged: list.length - updated - skipped };
  return { ...counts, cleared, compareAtLost, ...(body.dryRun ? { dryRun: true } : {}) };
}

/**
 * Answers this feature's routes, or returns undefined to let the mock answer 404. `req` =
 * { method, route ('GET /catalog/products/:id'), parts, id, subId, ids, query (URLSearchParams),
 * body (parsed JSON, or a Buffer for image uploads), contentType, state }. Return a body (200),
 * `tools.reply(status, body)`, or throw `new tools.HttpError(status, message, details)`.
 */
export function handle(req, { reply, HttpError, matches }) {
  const { method, route, ids, query, body, state } = req;
  if (!route.startsWith(`${method} /prices`)) return undefined;
  const pricing = state.pricing;
  const base = state.settings.baseCurrency;
  const findItem = (id) => {
    const item = state.items.find((i) => i.id === Number(id));
    if (!item) throw new HttpError(404, 'Item not found');
    return item;
  };
  const findStore = (id) => {
    const store = storeOf(state, Number(id));
    if (!store) throw new HttpError(404, 'Store not found');
    return store;
  };
  const findSchedule = (id) => {
    const s = pricing.schedules.find((x) => x.id === Number(id));
    if (!s) throw new HttpError(404, 'Schedule not found');
    return s;
  };

  switch (route) {
    case 'GET /prices': {
      const storeId = query.get('storeId') ? Number(query.get('storeId')) : undefined;
      const filter = query.get('filter') || 'all';
      const page = Math.max(1, Number(query.get('page') ?? 1));
      const pageSize = Math.min(200, Math.max(1, Number(query.get('pageSize') ?? 50)));
      const stores = storeId ? [findStore(storeId)] : state.stores;
      const list = matchingItems(state, { search: query.get('search'), filter, storeId }, matches);
      const last = pricing.runs[0];
      const active = pricing.runs.find((r) => ['queued', 'running'].includes(r.status));
      return {
        total: list.length,
        page,
        pageSize,
        baseCurrency: base,
        stores: stores.map((s) => priceStoreView(state, s)),
        items: list
          .slice((page - 1) * pageSize, page * pageSize)
          .map((i) => itemView(state, i, stores)),
        lastRun: last
          ? {
              id: last.id,
              status: last.status,
              createdAt: last.createdAt,
              finishedAt: last.finishedAt,
            }
          : null,
        activeRunId: active?.id ?? null,
      };
    }

    case 'GET /prices/items/:id': {
      const item = findItem(ids[0]);
      return {
        baseCurrency: base,
        stores: state.stores.map((s) => priceStoreView(state, s)),
        item: itemView(state, item, state.stores),
        schedules: pricing.schedules
          .filter((s) => ['scheduled', 'active'].includes(s.status) && s.itemIds.includes(item.id))
          .map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            status: s.status,
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            percentOff: s.percentOff,
            storeIds: s.storeIds,
          })),
      };
    }

    case 'PATCH /prices/items/:id': {
      const item = findItem(ids[0]);
      for (const key of ['basePrice', 'baseCompareAtPrice', 'cost']) {
        if (typeof body[key] === 'number' && body[key] < 0)
          throw new HttpError(400, `${key}: Too small: expected number to be >=0`);
      }
      const price = body.basePrice !== undefined ? body.basePrice : item.basePrice;
      const compareAt =
        body.baseCompareAtPrice !== undefined ? body.baseCompareAtPrice : item.baseCompareAtPrice;
      const touched = body.basePrice !== undefined || body.baseCompareAtPrice !== undefined;
      if (touched && compareAt !== null && compareAt !== undefined) {
        if (price === null || compareAt <= price) throw new HttpError(400, COMPARE_AT_ABOVE);
      }
      if (body.basePrice !== undefined) item.basePrice = body.basePrice;
      if (body.baseCompareAtPrice !== undefined) item.baseCompareAtPrice = body.baseCompareAtPrice;
      if (body.cost !== undefined) item.cost = body.cost;
      return itemView(state, item, state.stores);
    }

    case 'POST /prices/items/bulk': {
      const list = body.itemIds
        ? state.items.filter((i) => body.itemIds.includes(i.id))
        : matchingItems(state, body.filter ?? {}, matches);
      return bulkChange(state, body, list, HttpError);
    }

    case 'POST /prices/base-from-store': {
      const store = findStore(body.storeId);
      const onlyMissing = body.onlyMissing ?? true;
      const decimals = currencyDecimals(base);
      let updated = 0;
      let skipped = 0;
      for (const v of state.variants) {
        if (v.storeId !== store.id || v.itemId === null || v.deleted || v.isBundle) continue;
        const item = state.items.find((i) => i.id === v.itemId);
        if (!item) continue;
        if (onlyMissing && item.basePrice !== null && item.basePrice !== undefined) continue;
        if (v.price === null || v.price === undefined) {
          skipped++;
          continue;
        }
        item.basePrice = roundMoney(v.price / store.exchangeRate, decimals);
        item.baseCompareAtPrice =
          v.compareAtPrice > v.price
            ? roundMoney(v.compareAtPrice / store.exchangeRate, decimals)
            : null;
        updated++;
      }
      return { updated, skipped };
    }

    case 'GET /prices/rules':
      return {
        baseCurrency: base,
        samples: samples(state),
        rules: state.stores.map((s) => ruleView(state, s)),
      };

    case 'GET /prices/rules/:id':
      return { baseCurrency: base, samples: samples(state), ...ruleView(state, findStore(ids[0])) };

    case 'PUT /prices/rules/:id': {
      const store = findStore(ids[0]);
      if (body.roundMode === 'ending' && body.roundEnding >= body.roundStep) {
        throw new HttpError(
          400,
          'roundEnding: The ending must be smaller than the step (for prices ending in .90 with a step of 1, use 0.90)',
        );
      }
      pricing.rules[store.id] = {
        ...RULE_DEFAULTS,
        ...body,
        roundEnding:
          body.roundMode === 'ending' || body.roundEnding < body.roundStep ? body.roundEnding : 0,
        updatedAt: new Date().toISOString(),
      };
      return { baseCurrency: base, samples: samples(state), ...ruleView(state, store) };
    }

    case 'GET /prices/rules/:id/examples': {
      const store = findStore(ids[0]);
      const rule = { ...(pricing.rules[store.id] ?? RULE_DEFAULTS), enabled: true };
      const prices = query.get('prices')
        ? query.get('prices').split(',').map(Number)
        : samples(state).map((s) => s.basePrice);
      return {
        baseCurrency: base,
        currencyCode: store.currencyCode,
        examples: prices.map((basePrice) => {
          const target = computeTargetPrice({
            basePrice,
            baseCompareAtPrice: null,
            exchangeRate: store.exchangeRate,
            rule,
            currencyCode: store.currencyCode,
            override: null,
          });
          return { basePrice, price: target.status === 'ok' ? target.price : null };
        }),
      };
    }

    case 'PUT /prices/overrides/:id/:id': {
      const store = findStore(ids[0]);
      const item = findItem(ids[1]);
      const compareAtPrice = body.compareAtPrice ?? null;
      if (!(body.price >= 0)) throw new HttpError(400, 'price: Invalid input');
      if (compareAtPrice !== null && compareAtPrice <= body.price)
        throw new HttpError(400, COMPARE_AT_ABOVE);
      pricing.overrides = pricing.overrides.filter(
        (o) => !(o.storeId === store.id && o.itemId === item.id),
      );
      pricing.overrides.push({
        storeId: store.id,
        itemId: item.id,
        price: body.price,
        compareAtPrice,
        note: body.note ?? null,
        scheduleId: null,
        updatedAt: new Date().toISOString(),
      });
      return itemView(state, item, state.stores);
    }

    case 'DELETE /prices/overrides/:id/:id': {
      const store = findStore(ids[0]);
      const item = findItem(ids[1]);
      const before = pricing.overrides.length;
      pricing.overrides = pricing.overrides.filter(
        (o) => !(o.storeId === store.id && o.itemId === item.id),
      );
      if (pricing.overrides.length === before) throw new HttpError(404, 'Fixed price not found');
      return itemView(state, item, state.stores);
    }

    case 'GET /prices/apply/preview': {
      const list = (name) => (query.get(name) ? query.get(name).split(',').map(Number) : null);
      return preview(state, list('storeIds'), list('itemIds'));
    }

    case 'POST /prices/apply': {
      const busy = busyStoreIds(state);
      const requested = body.storeIds ?? null;
      const clash = state.stores.filter(
        (s) => busy.has(s.id) && (!requested || requested.includes(s.id)),
      );
      if (clash.length) {
        throw new HttpError(
          409,
          `Prices are already being updated in ${clash.map((s) => `“${s.name}”`).join(', ')}. ` +
            'Wait until that finishes, then try again.',
        );
      }
      const run = createRun(state, {
        reason: 'manual',
        itemIds: body.itemIds ?? null,
        storeIds: requested,
      });
      if (!run) {
        throw new HttpError(
          409,
          'Store Sync doesn’t manage prices in these stores yet. Turn on a store’s price rule on ' +
            'the Rules tab, or give a product a fixed price there.',
        );
      }
      if (!run.stores.some((s) => s.status === 'queued')) {
        pricing.runs.shift();
        throw new HttpError(409, run.stores.map((s) => s.error).join(' '));
      }
      return reply(202, {
        runId: run.id,
        stores: run.stores.map((s) => ({
          storeId: s.storeId,
          storeName: storeOf(state, s.storeId).name,
          status: s.status,
          error: s.error,
        })),
        skipped: [],
      });
    }

    case 'GET /prices/runs': {
      const limit = Number(query.get('limit') ?? 20);
      for (const run of pricing.runs) advance(state, run);
      return pricing.runs.slice(0, limit).map((r) => runView(state, r));
    }

    case 'GET /prices/runs/:id': {
      const run = pricing.runs.find((r) => r.id === Number(ids[0]));
      if (!run) throw new HttpError(404, 'Price update not found');
      advance(state, run);
      return runView(state, run);
    }

    case 'GET /prices/schedules':
      return listSchedules(state);

    case 'GET /prices/schedules/:id':
      return scheduleView(state, findSchedule(ids[0]));

    case 'POST /prices/schedules': {
      const sale = body.kind === 'sale';
      const input = {
        storeIds: null,
        showCompareAt: true,
        changes: [],
        ...body,
        startsAt: body.startsAt,
        endsAt: sale ? body.endsAt : null,
      };
      validateSchedule(state, input, null, HttpError);
      const s = {
        id: pricing.nextIds.schedule++,
        name: input.name.trim(),
        kind: input.kind,
        status: 'scheduled',
        startsAt: new Date(input.startsAt).toISOString(),
        endsAt: sale ? new Date(input.endsAt).toISOString() : null,
        storeIds: sale ? input.storeIds : null,
        itemIds: sale ? input.itemIds : input.changes.map((c) => c.itemId),
        percentOff: sale ? input.percentOff : null,
        showCompareAt: input.showCompareAt,
        changes: sale ? [] : input.changes.map((c) => ({ baseCompareAtPrice: null, ...c })),
        previous: null,
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        endedAt: null,
      };
      pricing.schedules.push(s);
      return reply(201, scheduleView(state, s));
    }

    case 'PATCH /prices/schedules/:id': {
      const s = findSchedule(ids[0]);
      if (s.status !== 'scheduled') {
        throw new HttpError(409, 'This has already started or ended, so it can’t be changed.');
      }
      const merged = {
        kind: s.kind,
        name: body.name ?? s.name,
        startsAt: body.startsAt ? new Date(body.startsAt).toISOString() : s.startsAt,
        endsAt: body.endsAt ? new Date(body.endsAt).toISOString() : s.endsAt,
        storeIds: body.storeIds !== undefined ? body.storeIds : s.storeIds,
        itemIds: body.itemIds ?? s.itemIds,
        percentOff: body.percentOff ?? s.percentOff,
        showCompareAt: body.showCompareAt ?? s.showCompareAt,
        changes: body.changes ?? s.changes,
      };
      validateSchedule(state, merged, s.id, HttpError);
      Object.assign(s, merged, {
        itemIds: s.kind === 'sale' ? merged.itemIds : merged.changes.map((c) => c.itemId),
      });
      return scheduleView(state, s);
    }

    case 'POST /prices/schedules/:id/cancel': {
      const s = findSchedule(ids[0]);
      let run = null;
      if (s.status === 'scheduled') {
        s.status = 'cancelled';
        s.endedAt = new Date().toISOString();
      } else if (s.status === 'active') {
        pricing.overrides = pricing.overrides.filter((o) => o.scheduleId !== s.id);
        s.status = 'ended';
        s.endedAt = new Date().toISOString();
        run = createRun(state, {
          reason: 'sale_end',
          scheduleId: s.id,
          itemIds: s.itemIds,
          storeIds: s.storeIds,
        });
      } else {
        throw new HttpError(409, 'This sale isn’t scheduled or running any more.');
      }
      return { schedule: scheduleView(state, s), runId: run?.id ?? null };
    }

    default:
      return undefined;
  }
}
