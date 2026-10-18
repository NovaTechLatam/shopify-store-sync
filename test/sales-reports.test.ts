import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import { ingestOrders } from '../src/sales/ingest.js';
import { updateSettings } from '../src/settings.js';
import type { ShopifyOrder, ShopifyOrderLine } from '../src/shopify/types.js';
import { SecretBox } from '../src/util/crypto.js';
import { FakeRegistry, TEST_DATABASE_URL, resetDatabase, silentLogger } from './helpers/harness.js';

const AUTH = `Basic ${Buffer.from('admin:correct-horse-battery').toString('base64')}`;
const ALL_SCOPES = ['read_products', 'read_inventory', 'write_inventory', 'read_locations'];

let db: Db;
let app: FastifyInstance;
let woken = 0;

beforeEach(async () => {
  db = createDb(TEST_DATABASE_URL, 5);
  await resetDatabase(db);
  const registry = new FakeRegistry();
  woken = 0;
  app = await buildServer({
    db,
    secrets: new SecretBox(Buffer.alloc(32, 7).toString('base64')),
    shopify: Object.assign(registry, { invalidate: () => {} }),
    createAdmin: () => {
      throw new Error('not used');
    },
    logger: silentLogger,
    publicUrl: 'https://sync.example.com',
    adminUsername: 'admin',
    adminPassword: 'correct-horse-battery',
    onWork: () => woken++,
  });
});

afterEach(async () => {
  await app.close();
  await db.end();
});

async function get(url: string) {
  const res = await app.inject({ method: 'GET', url, headers: { authorization: AUTH } });
  return {
    status: res.statusCode,
    headers: res.headers,
    text: res.body,
    body: res.headers['content-type']?.toString().startsWith('application/json')
      ? (JSON.parse(res.body) as any)
      : undefined,
  };
}

async function post(url: string) {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: AUTH, 'x-requested-with': 'store-sync' },
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : undefined };
}

async function addStore(
  name: string,
  opts: { currency?: string; rate?: number; tz?: string; scopes?: string[] | null } = {},
) {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO stores (name, shop_domain, auth_mode, access_token_enc, currency_code,
                         iana_timezone, exchange_rate, granted_scopes, scopes_checked_at)
     VALUES ($1, $2, 'access_token', 'unused', $3, $4, $5, $6, now()) RETURNING id`,
    [
      name,
      `${name.toLowerCase().replace(/\W+/g, '-')}.myshopify.com`,
      opts.currency ?? 'USD',
      opts.tz ?? 'America/Bogota',
      opts.rate ?? 1,
      opts.scopes === undefined ? [...ALL_SCOPES, 'read_orders'] : opts.scopes,
    ],
  );
  return rows[0]!.id;
}

async function addItem(
  sku: string,
  opts: { cost?: number; stock?: number | null; title?: string } = {},
) {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO items (sku, title, cost, created_at) VALUES ($1, $2, $3, now() - interval '400 days')
     RETURNING id`,
    [sku, opts.title ?? `${sku} title`, opts.cost ?? null],
  );
  const id = rows[0]!.id;
  await db.query('INSERT INTO pool_levels (item_id, warehouse_id, quantity) VALUES ($1, 1, $2)', [
    id,
    opts.stock === undefined ? null : opts.stock,
  ]);
  return id;
}

let seq = 0;
function line(
  sku: string | null,
  units: number,
  net: number,
  more: Partial<ShopifyOrderLine> = {},
) {
  seq++;
  return {
    id: `gid://shopify/LineItem/${seq}`,
    sku,
    quantity: units,
    currentQuantity: units,
    isGiftCard: false,
    variantId: null,
    inventoryItemId: null,
    unitPrice: units ? net / units : net,
    discounts: 0,
    net,
    ...more,
  } satisfies ShopifyOrderLine;
}

async function sell(
  storeId: number,
  processedAt: string,
  lines: ShopifyOrderLine[],
  more: Partial<ShopifyOrder> = {},
) {
  seq++;
  const order: ShopifyOrder = {
    id: `gid://shopify/Order/9${String(seq).padStart(17, '0')}`,
    name: `#${seq}`,
    processedAt,
    updatedAt: processedAt,
    cancelledAt: null,
    test: false,
    currencyCode: 'USD',
    sourceName: 'web',
    taxesIncluded: false,
    lines,
    ...more,
  };
  await ingestOrders(db, storeId, [order]);
  return order;
}

/** Two brands: a USD one and a COP one at 4,000 COP per USD; both in Bogotá (UTC−5). */
async function twoBrands() {
  const a = await addStore('Brand A');
  const b = await addStore('Brand B', { currency: 'COP', rate: 4000 });
  const tee = await addItem('TEE-1', { cost: 20, stock: 30 });
  const cap = await addItem('CAP-1', { stock: 0 });
  // 22:30 on Oct 9 in Bogotá (03:30 UTC on Oct 10).
  await sell(a, '2026-10-10T03:30:00Z', [line('TEE-1', 2, 100)]);
  await sell(a, '2026-10-10T12:00:00Z', [
    line('CAP-1', 1, 50),
    line(null, 1, 25, { isGiftCard: true }),
  ]);
  await sell(a, '2026-10-10T13:00:00Z', [line('TEE-1', 5, 250)], { test: true });
  await sell(a, '2026-10-10T14:00:00Z', [line('TEE-1', 0, 0, { quantity: 3 })], {
    cancelledAt: '2026-10-10T15:00:00Z',
  });
  await sell(b, '2026-10-10T15:00:00Z', [line('tee-1', 4, 400_000)], { currencyCode: 'COP' });
  // Outside the period.
  await sell(b, '2026-10-12T15:00:00Z', [line('TEE-1', 9, 900_000)], { currencyCode: 'COP' });
  return { a, b, tee, cap };
}

describe('GET /api/reports/summary', () => {
  it('adds up every brand in the base currency, by day in the report’s time zone', async () => {
    const { a, b } = await twoBrands();
    const res = await get('/api/reports/summary?from=2026-10-09&to=2026-10-10');
    expect(res.status).toBe(200);
    const s = res.body;
    expect(s).toMatchObject({
      baseCurrency: 'USD',
      timezone: 'America/Bogota',
      from: '2026-10-09',
      to: '2026-10-10',
    });
    // Test orders, cancelled orders and gift cards are left out.
    expect(s.totals).toEqual({
      orders: 3,
      units: 7,
      revenue: 250,
      cost: 120,
      margin: 0.4,
      revenueWithoutCost: 50,
    });
    expect(s.byStore).toEqual([
      {
        storeId: a,
        name: 'Brand A',
        currencyCode: 'USD',
        exchangeRate: 1,
        orders: 2,
        units: 3,
        revenue: 150,
        revenueBase: 150,
        cost: 40,
        margin: 0.6,
        revenueWithoutCost: 50,
      },
      {
        storeId: b,
        name: 'Brand B',
        currencyCode: 'COP',
        exchangeRate: 4000,
        orders: 1,
        units: 4,
        revenue: 400_000,
        revenueBase: 100,
        cost: 80,
        margin: 0.2,
        revenueWithoutCost: 0,
      },
    ]);
    expect(s.daily).toEqual([
      { date: '2026-10-09', revenue: 100, byStore: { [a]: 100 } },
      { date: '2026-10-10', revenue: 150, byStore: { [a]: 50, [b]: 100 } },
    ]);
    expect(s.coverage.stores.map((c: any) => c.storeId)).toEqual([a, b]);
  });

  it('follows the report time zone setting and the store filter', async () => {
    const { a, b } = await twoBrands();
    await updateSettings(db, { reportTimezone: 'UTC' });
    let s = (await get('/api/reports/summary?from=2026-10-09&to=2026-10-10')).body;
    expect(s.timezone).toBe('UTC');
    expect(s.daily).toEqual([
      { date: '2026-10-09', revenue: 0, byStore: {} },
      { date: '2026-10-10', revenue: 250, byStore: { [a]: 150, [b]: 100 } },
    ]);

    s = (await get(`/api/reports/summary?from=2026-10-01&to=2026-10-31&storeIds=${b}`)).body;
    expect(s.byStore.map((x: any) => x.storeId)).toEqual([b]);
    expect(s.totals).toMatchObject({ orders: 2, units: 13, revenue: 325 });
    expect(s.daily).toHaveLength(31);
    expect(s.coverage.stores.map((c: any) => c.storeId)).toEqual([b]);
  });

  it('defaults to the last 30 days, today included', async () => {
    await addStore('Brand A', { tz: 'Asia/Tokyo' });
    const s = (await get('/api/reports/summary')).body;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    expect(s.to).toBe(today);
    expect(s.daily).toHaveLength(30);
    expect(s.totals).toEqual({
      orders: 0,
      units: 0,
      revenue: 0,
      cost: 0,
      margin: null,
      revenueWithoutCost: 0,
    });
  });

  it('refuses periods that don’t make sense', async () => {
    await addStore('Brand A');
    const backwards = await get('/api/reports/summary?from=2026-10-10&to=2026-10-09');
    expect(backwards.status).toBe(400);
    expect(backwards.body.error).toBe('The start date must be on or before the end date.');
    expect((await get('/api/reports/summary?from=2026-02-30')).status).toBe(400);
    expect((await get('/api/reports/summary?from=10/09/2026')).status).toBe(400);
    expect((await get('/api/reports/summary?storeIds=1;DROP')).status).toBe(400);
    const long = await get('/api/reports/summary?from=2000-01-01&to=2026-01-01');
    expect(long.body.error).toBe('Choose a period of at most 10 years.');
    // Empty values (an untouched form) mean "not given".
    expect((await get('/api/reports/summary?from=&to=&storeIds=')).status).toBe(200);
  });
});

describe('GET /api/reports/products', () => {
  it('lists sold and stocked products with their figures, sorted and paged', async () => {
    const { a, b, tee, cap } = await twoBrands();
    const socks = await addItem('SOCK-1', { stock: 12 }); // in stock, never sold
    await addItem('GONE-1', { stock: 0 }); // neither: not listed
    await sell(a, '2026-10-10T16:00:00Z', [line('NOT-OURS', 2, 30)]);
    const q = '/api/reports/products?from=2026-10-09&to=2026-10-10';
    const res = await get(q);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 4, page: 1, pageSize: 50, lookbackDays: 30 });
    const rows = res.body.products;
    expect(rows.map((r: any) => r.sku)).toEqual(['TEE-1', 'CAP-1', 'NOT-OURS', 'SOCK-1']);
    expect(rows[0]).toMatchObject({
      itemId: tee,
      title: 'TEE-1 title',
      units: 6,
      revenue: 200,
      cost: 120,
      margin: 0.4,
      stock: 30,
      sellThrough: 0.1667,
      byStore: [
        { storeId: a, units: 2, revenue: 100, revenueBase: 100 },
        { storeId: b, units: 4, revenue: 400_000, revenueBase: 100 },
      ],
    });
    // Out of stock and still selling: no days left.
    expect(rows[1]).toMatchObject({
      itemId: cap,
      stock: 0,
      margin: null,
      daysLeft: 0,
      sellThrough: 1,
    });
    expect(rows[2]).toMatchObject({ itemId: null, sku: 'NOT-OURS', units: 2, stock: null });
    expect(rows[3]).toMatchObject({
      itemId: socks,
      units: 0,
      revenue: 0,
      sellThrough: 0,
      velocity: 0,
      daysLeft: null,
    });

    const sorted = async (params: string) =>
      (await get(`${q}&${params}`)).body.products.map((r: any) => r.sku);
    expect(await sorted('sort=units&dir=asc')).toEqual(['SOCK-1', 'CAP-1', 'NOT-OURS', 'TEE-1']);
    // Rows without the figure (no cost) go last both ways.
    expect(await sorted('sort=margin&dir=asc')).toEqual(['TEE-1', 'CAP-1', 'NOT-OURS', 'SOCK-1']);
    expect(await sorted('sort=sellThrough')).toEqual(['CAP-1', 'TEE-1', 'SOCK-1', 'NOT-OURS']);
    expect(rows[2].sellThrough).toBeNull();
    expect(await sorted('search=tee')).toEqual(['TEE-1']);
    expect(await sorted('search=title&sort=units')).toEqual(['TEE-1', 'CAP-1', 'SOCK-1']);
    const page2 = (await get(`${q}&pageSize=3&page=2`)).body;
    expect(page2).toMatchObject({ total: 4, page: 2 });
    expect(page2.products.map((r: any) => r.sku)).toEqual(['SOCK-1']);
    expect((await get(`${q}&sort=price`)).status).toBe(400);
  });

  it('measures the pace over the last 30 days of every store, whatever the period', async () => {
    const a = await addStore('Brand A');
    const b = await addStore('Brand B');
    await addItem('TEE-1', { stock: 45 });
    const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60_000).toISOString();
    // The oldest order is 40 days old, so the window is the full 30 days: 60 units → 2 a day.
    await sell(a, days(40), [line('TEE-1', 100, 100)]);
    await sell(a, days(20), [line('TEE-1', 30, 300)]);
    await sell(b, days(5), [line('TEE-1', 30, 300)]);
    const res = await get(`/api/reports/products?storeIds=${a}`);
    const [row] = res.body.products;
    expect(row).toMatchObject({ sku: 'TEE-1', units: 30, velocity: 2, daysLeft: 22.5 });
  });

  it('downloads every row as a CSV that spreadsheets can’t be tricked by', async () => {
    const a = await addStore('Brand A');
    const b = await addStore('Marca, “Ñ”', { currency: 'CLP', rate: 950 });
    await addItem('=HYPERLINK("http://evil.example","x")', { title: '+SUM(1,2)', stock: 4 });
    await addItem('TEE-1', { title: 'Tee, "classic"', cost: 2, stock: -2 });
    await sell(a, '2026-10-10T15:00:00Z', [line('TEE-1', 2, 21.5)]);
    await sell(b, '2026-10-10T15:00:00Z', [line('TEE-1', 1, 9990.4)], { currencyCode: 'CLP' });
    await sell(a, '2026-10-10T16:00:00Z', [line('@cmd', 1, 1)]);
    const res = await get(
      `/api/reports/products.csv?from=2026-10-01&to=2026-10-31&sort=units&dir=desc`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="sales-by-product-2026-10-01-to-2026-10-31.csv"',
    );
    expect(res.text.startsWith('\uFEFF')).toBe(true);
    const lines = res.text.slice(1).split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines[0]).toBe(
      'SKU,Product,Brand A: units,Brand A: revenue (USD),"Marca, “Ñ”: units","Marca, “Ñ”: revenue (CLP)",' +
        'Units,Revenue (USD),Cost (USD),Margin (%),Shared stock,Units a day,Days of stock left,Sell-through (%)',
    );
    expect(lines).toHaveLength(4);
    // Money in each currency's decimals (CLP has none); a negative stock stays a number.
    expect(lines[1]).toMatch(
      /^TEE-1,"Tee, ""classic""",2,21.5,1,9990,3,32.02,6,81.3,-2,[\d.]+,0,100$/,
    );
    // Text that starts like a formula can't run as one.
    expect(lines[2]).toBe(`'@CMD,Not one of your products,1,1,0,0,1,1,0,,,0,,`);
    expect(lines[3]).toBe(
      `"'=HYPERLINK(""http://evil.example"",""x"")","'+SUM(1,2)",0,0,0,0,0,0,0,,4,0,,0`,
    );
  });
});

describe('GET /api/reports/items/:itemId', () => {
  it('gives one product’s units per brand and per day', async () => {
    const { a, b, tee } = await twoBrands();
    const res = await get(`/api/reports/items/${tee}?from=2026-10-09&to=2026-10-11`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      itemId: tee,
      sku: 'TEE-1',
      stock: 30,
      totals: { orders: 2, units: 6, revenue: 200 },
      readingStores: 2,
    });
    expect(res.body.stores).toEqual([
      expect.objectContaining({ storeId: a, units: 2, revenue: 100, revenueBase: 100 }),
      expect.objectContaining({ storeId: b, units: 4, revenue: 400_000, revenueBase: 100 }),
    ]);
    expect(res.body.daily).toEqual([
      { date: '2026-10-09', byStore: { [a]: 2 } },
      { date: '2026-10-10', byStore: { [b]: 4 } },
      { date: '2026-10-11', byStore: {} },
    ]);
    expect((await get('/api/reports/items/999999')).status).toBe(404);
    expect((await get('/api/reports/items/abc')).status).toBe(400);
  });
});

describe('report status and history import', () => {
  it('says what each store’s history covers and why', async () => {
    const a = await addStore('Brand A', {
      scopes: [...ALL_SCOPES, 'read_orders', 'read_all_orders'],
    });
    const b = await addStore('Brand B', { scopes: ALL_SCOPES });
    const c = await addStore('Brand C', { scopes: null });
    await db.query(
      `UPDATE stores SET sales_backfill_status = 'done', sales_history_from = '2026-08-19T05:00:00Z',
                         sales_history_capped = false, orders_checked_at = '2026-10-17T10:00:00Z'
        WHERE id = $1`,
      [a],
    );
    await db.query(
      `UPDATE stores SET sales_backfill_status = 'running', sales_backfill_objects = 1200,
                         sales_backfill_started_at = now(), sales_history_capped = true
        WHERE id = $1`,
      [c],
    );
    await sell(a, '2026-09-01T12:00:00Z', [line('X', 1, 1)]);
    const res = await get('/api/reports/status');
    expect(res.status).toBe(200);
    expect(res.body.salesHistoryDays).toBe(60);
    const [ca, cb, cc] = res.body.stores;
    expect(ca).toMatchObject({
      storeId: a,
      permission: 'granted',
      allOrders: true,
      historyFrom: '2026-08-19',
      firstOrderOn: '2026-09-01',
      lastSyncedAt: '2026-10-17T10:00:00.000Z',
      backfill: { status: 'done', error: null },
    });
    expect(cb).toMatchObject({
      storeId: b,
      permission: 'missing',
      missingScopes: ['read_orders'],
      allOrders: false,
    });
    expect(cc).toMatchObject({
      storeId: c,
      permission: 'unknown',
      historyCapped: true,
      backfill: { status: 'running', objects: 1200 },
    });
  });

  it('starts the import again on request, but not twice, and not without permission', async () => {
    const a = await addStore('Brand A');
    const b = await addStore('Brand B', { scopes: ALL_SCOPES });
    await db.query(
      `UPDATE stores SET sales_backfill_status = 'failed', sales_backfill_error = 'The export failed.'
        WHERE id = $1`,
      [a],
    );
    const res = await post(`/api/reports/stores/${a}/resync`);
    expect(res.status).toBe(202);
    expect(woken).toBe(1);
    const { rows } = await db.query(
      `SELECT sales_backfill_status, sales_backfill_error FROM stores WHERE id = $1`,
      [a],
    );
    expect(rows[0]).toEqual({ sales_backfill_status: 'none', sales_backfill_error: null });
    const tasks = await db.query('SELECT dedupe_key FROM tasks');
    expect(tasks.rows).toEqual([{ dedupe_key: `sales_backfill:storeId=${a}` }]);

    await db.query(`UPDATE stores SET sales_backfill_status = 'running' WHERE id = $1`, [a]);
    const twice = await post(`/api/reports/stores/${a}/resync`);
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe('The order history of “Brand A” is being imported already.');

    const denied = await post(`/api/reports/stores/${b}/resync`);
    expect(denied.status).toBe(409);
    expect(denied.body.missingScopes).toEqual(['read_orders']);
    expect((await post('/api/reports/stores/999/resync')).status).toBe(404);
  });

  it('needs the dashboard header to restart an import', async () => {
    const a = await addStore('Brand A');
    const res = await app.inject({
      method: 'POST',
      url: `/api/reports/stores/${a}/resync`,
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(403);
  });
});
