import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncStoreCatalog } from '../src/catalog/catalog.js';
import { buildServer } from '../src/http/server.js';
import type { ShopifyProductVariant } from '../src/shopify/types.js';
import { runTasksOnce } from '../src/tasks/runner.js';
import { SecretBox } from '../src/util/crypto.js';
import { Harness, silentLogger, type TestStore } from './helpers/harness.js';
import { PNG_1X1 } from './helpers/images.js';

const AUTH = `Basic ${Buffer.from('admin:correct-horse-battery').toString('base64')}`;

let h: Harness;
let app: FastifyInstance;

beforeEach(async () => {
  h = await Harness.create(3);
  for (const s of h.stores) {
    s.shop.scopes.push('write_products', 'write_publications');
    await h.db.query(`UPDATE stores SET currency_code = 'USD' WHERE id = $1`, [s.id]);
  }
  app = await buildServer({
    db: h.db,
    secrets: new SecretBox(Buffer.alloc(32, 7).toString('base64')),
    shopify: Object.assign(h.registry, { invalidate: () => {} }),
    createAdmin: () => {
      throw new Error('not used');
    },
    logger: silentLogger,
    publicUrl: 'https://sync.test',
    adminUsername: 'admin',
    adminPassword: 'correct-horse-battery',
  });
});

afterEach(async () => {
  await app.close();
  await h.close();
});

const api = async (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) => {
  const res = await app.inject({
    method,
    url,
    payload: payload as object,
    headers: { authorization: AUTH, 'x-requested-with': 'store-sync' },
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : undefined };
};

const upload = (data: Buffer, contentType = 'image/png', headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/catalog/media?filename=front.png',
    payload: data,
    headers: {
      authorization: AUTH,
      'x-requested-with': 'store-sync',
      'content-type': contentType,
      ...headers,
    },
  });

async function settle() {
  const deps = { db: h.db, shopify: h.registry, logger: silentLogger, publicUrl: 'x' };
  for (let i = 0; i < 20; i++) {
    await h.db.query('UPDATE tasks SET run_after = now() WHERE lease_token IS NULL');
    const n = await runTasksOnce(h.db, deps, silentLogger, 10);
    await h.drain();
    if (n === 0) return;
  }
  throw new Error('did not settle');
}

const tee = (overrides: Record<string, unknown> = {}) => ({
  title: 'Linen tee',
  status: 'ACTIVE',
  options: [{ name: 'Size', values: ['S', 'M'] }],
  variants: [
    { sku: 'TEE-S', optionValues: ['S'], basePrice: 10 },
    { sku: 'TEE-M', optionValues: ['M'], basePrice: 12 },
  ],
  ...overrides,
});

async function readCatalog(s: TestStore) {
  await syncStoreCatalog({ db: h.db, shopify: h.registry, logger: silentLogger }, s.id);
}

/** A two-size product as a store already sells it. */
function sizedProduct(
  s: TestStore,
  title: string,
  variants: { sku: string | null; size: string; price?: string }[],
  extra: Record<string, unknown> = {},
) {
  return s.shop.addProduct({
    title,
    productOptions: [{ name: 'Size', values: variants.map((v) => ({ name: v.size })) }],
    variants: variants.map((v) => ({
      ...(v.sku === null ? {} : { sku: v.sku }),
      price: v.price ?? '10.00',
      optionValues: [{ optionName: 'Size', name: v.size }],
    })),
    ...extra,
  });
}

describe('catalog products', () => {
  it('creates, lists, edits and deletes a product', async () => {
    const created = await api('POST', '/api/catalog/products', tee());
    expect(created.status).toBe(201);
    const product = created.body;
    expect(product).toMatchObject({ title: 'Linen tee', status: 'ACTIVE', baseCurrency: 'USD' });
    expect(product.variants.map((v: any) => [v.sku, v.basePrice, v.stockStarted])).toEqual([
      ['TEE-S', 10, false],
      ['TEE-M', 12, false],
    ]);
    expect(product.stores).toHaveLength(3);
    expect(product.stores[0]).toMatchObject({ enabled: true, state: 'never', problems: [] });

    const list = await api('GET', '/api/catalog/products?search=tee-m');
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 50 });
    expect(list.body.products[0]).toMatchObject({ id: product.id, variants: 2, image: null });
    expect(list.body.products[0].stores.map((s: any) => s.state)).toEqual([
      'never',
      'never',
      'never',
    ]);
    expect((await api('GET', '/api/catalog/products?status=DRAFT')).body.total).toBe(0);

    const edited = await api('PATCH', `/api/catalog/products/${product.id}`, {
      version: product.version,
      title: 'Linen T-shirt',
      stores: [{ storeId: h.stores[1]!.id, title: 'Harbor linen tee', enabled: false }],
      variants: [
        { id: product.variants[0].id, sku: 'TEE-S', optionValues: ['S'], basePrice: null },
        { id: product.variants[1].id, sku: 'TEE-M', optionValues: ['M'] },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.title).toBe('Linen T-shirt');
    expect(edited.body.variants.map((v: any) => v.basePrice)).toEqual([null, 12]);
    expect(edited.body.stores[1]).toMatchObject({
      enabled: false,
      overlay: expect.objectContaining({ title: 'Harbor linen tee' }),
      effective: expect.objectContaining({ title: 'Harbor linen tee' }),
    });

    // Someone else's editor still has the old version.
    const stale = await api('PATCH', `/api/catalog/products/${product.id}`, {
      version: product.version,
      title: 'Mine',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/^Someone saved this product after you opened it/);

    expect((await api('DELETE', `/api/catalog/products/${product.id}`)).status).toBe(204);
    expect((await api('GET', `/api/catalog/products/${product.id}`)).status).toBe(404);
    // The items (and their stock) stay.
    const items = await h.db.query(`SELECT 1 FROM items WHERE sku IN ('TEE-S', 'TEE-M')`);
    expect(items.rowCount).toBe(2);
  });

  it('refuses inconsistent products with a message saying what to fix', async () => {
    const dup = await api(
      'POST',
      '/api/catalog/products',
      tee({
        variants: [
          { sku: 'TEE-S', optionValues: ['S'] },
          { sku: 'tee-s ', optionValues: ['M'] },
        ],
      }),
    );
    expect(dup).toEqual({
      status: 400,
      body: { error: 'SKU tee-s is used by two variants. Each variant needs its own SKU.' },
    });
    const bad = await api(
      'POST',
      '/api/catalog/products',
      tee({ variants: [{ sku: 'X', optionValues: ['XL'] }] }),
    );
    expect(bad.body.error).toBe('Variant X uses “XL”, which isn’t one of the Size values.');
    const noTitle = await api('POST', '/api/catalog/products', tee({ title: '  ' }));
    expect(noTitle.status).toBe(400);
    const handle = await api('POST', '/api/catalog/products', tee({ handle: 'Not a handle!' }));
    expect(handle.body.error).toContain('lowercase letters, numbers and hyphens');
    expect((await h.db.query('SELECT 1 FROM items')).rowCount).toBe(0);
  });

  it('keeps each SKU in one catalog product', async () => {
    await api('POST', '/api/catalog/products', tee());
    const other = await api(
      'POST',
      '/api/catalog/products',
      tee({ title: 'Other tee', variants: [{ sku: 'tee-m', optionValues: ['M'] }] }),
    );
    expect(other).toEqual({
      status: 409,
      body: {
        error:
          'SKU TEE-M is already in “Linen tee” in the catalog. A SKU can only be in one catalog product.',
      },
    });
  });

  it('starts new items at 0 but leaves an existing item’s stock alone', async () => {
    const existing = await h.addItem('TEE-M', [4, 4, 4]);
    await h.initialize(existing, 'max');
    await h.drain();
    await api('POST', '/api/catalog/products', tee());
    const inits = await h.db.query<{ sku: string; strategy: string; value: number }>(
      `SELECT i.sku, a.strategy, a.value FROM pool_adjustments a
         JOIN pool_levels pl ON pl.id = a.pool_level_id JOIN items i ON i.id = pl.item_id
        WHERE a.applied_at IS NULL`,
    );
    expect(inits.rows).toEqual([{ sku: 'TEE-S', strategy: 'value', value: 0 }]);
    expect(await h.shared(existing)).toBe(4);
  });

  it('deletes an item made for a mistyped SKU when the SKU is corrected', async () => {
    const created = (await api('POST', '/api/catalog/products', tee())).body;
    await api('PATCH', `/api/catalog/products/${created.id}`, {
      variants: [
        { id: created.variants[0].id, sku: 'TEE-SM', optionValues: ['S'] },
        { id: created.variants[1].id, sku: 'TEE-M', optionValues: ['M'] },
      ],
    });
    const skus = await h.db.query<{ sku: string }>('SELECT sku FROM items ORDER BY sku');
    expect(skus.rows.map((r) => r.sku)).toEqual(['TEE-M', 'TEE-SM']);
  });

  it('won’t change a SKU once the product is in a store', async () => {
    const created = (await api('POST', '/api/catalog/products', tee())).body;
    await api('POST', `/api/catalog/products/${created.id}/publish`, {
      storeIds: [h.stores[0]!.id],
    });
    await settle();
    const res = await api('PATCH', `/api/catalog/products/${created.id}`, {
      variants: [
        { id: created.variants[0].id, sku: 'TEE-SM', optionValues: ['S'] },
        { id: created.variants[1].id, sku: 'TEE-M', optionValues: ['M'] },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(
      /^The SKU of TEE-S can’t change now that the product is in a store/,
    );
  });
});

describe('images', () => {
  it('stores an upload checked by its bytes, once per content', async () => {
    const res = await upload(PNG_1X1);
    expect(res.statusCode).toBe(201);
    const image = JSON.parse(res.body);
    expect(image).toEqual({
      id: expect.any(Number),
      url: `/api/catalog/media/${image.id}`,
      width: 1,
      height: 1,
    });
    // Same bytes, whatever the type claimed: the same image.
    expect(JSON.parse((await upload(PNG_1X1, 'image/jpeg')).body).id).toBe(image.id);

    const served = await app.inject({
      method: 'GET',
      url: image.url,
      headers: { authorization: AUTH },
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.rawPayload.equals(PNG_1X1)).toBe(true);
    const stored = await h.db.query<{ filename: string; mime_type: string }>(
      'SELECT filename, mime_type FROM media_files',
    );
    expect(stored.rows).toEqual([{ filename: 'front.png', mime_type: 'image/png' }]);
  });

  it('refuses what isn’t an image, whatever its content type says', async () => {
    const html = await upload(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png');
    expect(html.statusCode).toBe(400);
    expect(JSON.parse(html.body).error).toMatch(/isn’t a JPEG, PNG, WebP or GIF image/);
    const svg = await upload(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'image/svg+xml',
    );
    expect(svg.statusCode).toBe(400);
    const json = await api('POST', '/api/catalog/media', { not: 'an image' });
    expect(json.body.error).toBe('Send the image file itself, with an image content type.');
    const big = await upload(Buffer.concat([PNG_1X1, Buffer.alloc(21 * 1024 * 1024)]));
    expect(big.statusCode).toBe(413);
    expect((await api('GET', '/api/catalog/media/999')).status).toBe(404);
  });

  it('needs the dashboard’s header, like every change', async () => {
    const res = await upload(PNG_1X1, 'image/png', { 'x-requested-with': '' });
    expect(res.statusCode).toBe(403);
  });

  it('keeps product images in order, per brand, and drops removed ones', async () => {
    const image = JSON.parse((await upload(PNG_1X1)).body);
    const created = (
      await api(
        'POST',
        '/api/catalog/products',
        tee({
          media: [
            { fileId: image.id, alt: 'Front', optionValue: 'S' },
            { sourceUrl: 'https://cdn.shopify.com/back.jpg', alt: 'Back' },
            { storeId: h.stores[1]!.id, sourceUrl: 'https://cdn.shopify.com/harbor.jpg' },
          ],
        }),
      )
    ).body;
    expect(created.media.map((m: any) => [m.alt, m.storeId, m.position, m.url])).toEqual([
      ['Front', null, 0, image.url],
      ['', h.stores[1]!.id, 0, 'https://cdn.shopify.com/harbor.jpg'],
      ['Back', null, 1, 'https://cdn.shopify.com/back.jpg'],
    ]);
    const front = created.media.find((m: any) => m.alt === 'Front');
    const back = created.media.find((m: any) => m.alt === 'Back');
    const edited = await api('PATCH', `/api/catalog/products/${created.id}`, {
      media: [
        { id: back.id, alt: 'Back view' },
        { id: front.id, alt: 'Front', optionValue: null },
      ],
    });
    expect(edited.body.media.map((m: any) => [m.alt, m.position, m.optionValue])).toEqual([
      ['Back view', 0, null],
      ['Front', 1, null],
    ]);
    const bad = await api('PATCH', `/api/catalog/products/${created.id}`, {
      media: [{ id: front.id, optionValue: 'XXL' }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('“XXL”, which isn’t an option value');
  });
});

describe('preview and publish', () => {
  it('says what each brand gets, and why some can’t', async () => {
    const [a, b, c] = h.stores;
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [b!.id]);
    await h.db.query(`UPDATE stores SET granted_scopes = $2 WHERE id = $1`, [
      c!.id,
      ['read_products', 'write_inventory'],
    ]);
    const created = (await api('POST', '/api/catalog/products', tee())).body;
    const preview = await api('GET', `/api/catalog/products/${created.id}/preview`);
    expect(preview.status).toBe(200);
    const [pa, pb, pc] = preview.body.stores;
    expect(pa).toMatchObject({ storeId: a!.id, action: 'create', reasons: [], imagesAdded: 0 });
    expect(pa.prices.map((p: any) => [p.sku, p.from, p.to.price])).toEqual([
      ['TEE-S', null, 10],
      ['TEE-M', null, 12],
    ]);
    expect(pb).toMatchObject({
      action: 'blocked',
      reasons: ['brand1 is paused. Resume it on its page, then publish again.'],
    });
    expect(pc.action).toBe('blocked');
    expect(pc.reasons[0]).toContain('(write_products)');

    // Only some stores.
    const one = await api('GET', `/api/catalog/products/${created.id}/preview?storeIds=${a!.id}`);
    expect(one.body.stores).toHaveLength(1);
    expect(
      (await api('GET', `/api/catalog/products/${created.id}/preview?storeIds=x`)).status,
    ).toBe(400);
  });

  it('lists exactly what an update deletes in the store', async () => {
    const [a] = h.stores;
    const created = (await api('POST', '/api/catalog/products', tee())).body;
    await api('POST', `/api/catalog/products/${created.id}/publish`, { storeIds: [a!.id] });
    await settle();
    const productId = (await api('GET', `/api/catalog/products/${created.id}`)).body.stores[0]
      .shopifyProductId;
    // A variant and an image added in the Shopify admin.
    const live = (await a!.shop.getProduct(productId))!;
    await a!.shop.productSet({
      identifier: { id: productId },
      input: {
        productOptions: [{ name: 'Size', values: [{ name: 'S' }, { name: 'M' }, { name: 'XL' }] }],
        variants: [
          ...live.variants.map((v: ShopifyProductVariant) => ({
            id: v.id,
            optionValues: [{ optionName: 'Size', name: v.selectedOptions[0]!.value }],
          })),
          { sku: 'TEE-XL', optionValues: [{ optionName: 'Size', name: 'XL' }], price: '15' },
        ],
        files: [{ originalSource: 'https://cdn.shopify.com/extra.jpg', alt: 'Lifestyle' }],
      },
    });
    const preview = (
      await api('GET', `/api/catalog/products/${created.id}/preview?storeIds=${a!.id}`)
    ).body.stores[0];
    expect(preview.action).toBe('update');
    expect(preview.variantsRemoved).toEqual([{ sku: 'TEE-XL', title: 'XL' }]);
    expect(preview.imagesRemoved).toEqual([
      { alt: 'Lifestyle', url: expect.stringContaining('https://cdn.shopify.com/') },
    ]);
    expect(preview.upToDate).toBe(false);

    await api('PATCH', `/api/catalog/products/${created.id}`, { title: 'Linen T-shirt' });
    const renamed = (
      await api('GET', `/api/catalog/products/${created.id}/preview?storeIds=${a!.id}`)
    ).body.stores[0];
    expect(renamed.fields).toEqual([
      { field: 'title', label: 'Title', from: 'Linen tee', to: 'Linen T-shirt' },
    ]);
  });

  it('says when the store is up to date, and when Shopify can’t be asked', async () => {
    const [a] = h.stores;
    const created = (await api('POST', '/api/catalog/products', tee())).body;
    await api('POST', `/api/catalog/products/${created.id}/publish`, { storeIds: [a!.id] });
    await settle();
    const preview = (
      await api('GET', `/api/catalog/products/${created.id}/preview?storeIds=${a!.id}`)
    ).body.stores[0];
    expect(preview).toMatchObject({ action: 'update', upToDate: true, fields: [], prices: [] });
    a!.shop.failNext('getProduct', 'throw_before');
    const blind = (
      await api('GET', `/api/catalog/products/${created.id}/preview?storeIds=${a!.id}`)
    ).body.stores[0];
    expect(blind.action).toBe('update');
    expect(blind.imagesRemoved).toBeNull();
    expect(blind.warnings[0]).toMatch(/^We couldn’t read the product from brand0 just now/);
  });

  it('queues the brands that sell it, and shows the result', async () => {
    const [a, b] = h.stores;
    const created = (
      await api(
        'POST',
        '/api/catalog/products',
        tee({ stores: [{ storeId: b!.id, enabled: false }] }),
      )
    ).body;
    const res = await api('POST', `/api/catalog/products/${created.id}/publish`, {
      storeIds: [a!.id, b!.id],
    });
    expect(res).toEqual({
      status: 202,
      body: { queued: [a!.id], skipped: [{ storeId: b!.id, reason: 'Not sold in brand1.' }] },
    });
    expect((await api('GET', `/api/catalog/products/${created.id}`)).body.stores[0].state).toBe(
      'queued',
    );
    await settle();
    const after = (await api('GET', `/api/catalog/products/${created.id}`)).body;
    expect(after.stores[0]).toMatchObject({
      state: 'published',
      adminUrl: expect.stringMatching(/^https:\/\/brand0\.myshopify\.com\/admin\/products\/\d+$/),
    });
    expect(after.variants.map((v: any) => v.stock)).toEqual([0, 0]);
    expect(
      (await api('POST', '/api/catalog/products/999/publish', { storeIds: [a!.id] })).status,
    ).toBe(404);
  });
});

describe('import', () => {
  it('imports a store’s product and links the same product in the other brands', async () => {
    const [a, b, c] = h.stores;
    await h.db.query(`UPDATE stores SET exchange_rate = 2, currency_code = 'EUR' WHERE id = $1`, [
      b!.id,
    ]);
    const source = sizedProduct(
      a!,
      'Linen tee',
      [
        { sku: 'TEE-S', size: 'S', price: '10.00' },
        { sku: 'TEE-M', size: 'M', price: '12.00' },
      ],
      {
        tags: ['linen'],
        files: [{ originalSource: 'https://cdn.shopify.com/front.jpg', alt: 'Front' }],
      },
    );
    sizedProduct(
      b!,
      'Harbor linen tee',
      [
        { sku: 'TEE-S', size: 'S', price: '20.00' },
        { sku: 'TEE-M', size: 'M', price: '24.00' },
        { sku: 'TEE-L', size: 'L', price: '28.00' },
      ],
      { tags: ['linen', 'harbor'] },
    );
    for (const s of h.stores) await readCatalog(s);

    const search = await api('GET', `/api/catalog/import/search?storeId=${a!.id}&search=linen`);
    expect(search.body.products).toEqual([
      {
        productId: source.productId,
        title: 'Linen tee',
        variants: 2,
        skus: ['TEE-S', 'TEE-M'],
        inCatalog: null,
      },
    ]);

    const res = await api('POST', '/api/catalog/import', {
      storeId: a!.id,
      productId: source.productId,
    });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([]);
    const product = (await api('GET', `/api/catalog/products/${res.body.id}`)).body;
    expect(product).toMatchObject({ title: 'Linen tee', tags: ['linen'] });
    expect(product.options).toEqual([{ name: 'Size', values: ['S', 'M', 'L'] }]);
    // Harbor's extra size fits the options: it joins the catalog product.
    expect(product.variants.map((v: any) => [v.sku, v.basePrice])).toEqual([
      ['TEE-S', 10],
      ['TEE-M', 12],
      ['TEE-L', 14],
    ]);
    const [sa, sb, sc] = product.stores;
    expect(sa).toMatchObject({ enabled: true, shopifyProductId: source.productId });
    expect(sb).toMatchObject({
      enabled: true,
      overlay: expect.objectContaining({ title: 'Harbor linen tee', extraTags: ['harbor'] }),
    });
    expect(sc).toMatchObject({ enabled: false, shopifyProductId: null, state: 'never' });
    // Harbor has exactly what we'd send: published. The source lacks size L now: changed.
    expect(sb.state).toBe('published');
    expect(sa).toMatchObject({ state: 'changed', changedReason: 'content' });
    // Each brand's images are its own, already linked.
    expect(product.media).toEqual([
      expect.objectContaining({
        storeId: a!.id,
        alt: 'Front',
        sourceUrl: expect.stringContaining('cdn.shopify.com'),
      }),
    ]);
    expect(c).toBeDefined();

    expect(
      (await api('POST', '/api/catalog/import', { storeId: a!.id, productId: source.productId }))
        .status,
    ).toBe(409);
    const again = await api('GET', `/api/catalog/import/search?storeId=${b!.id}`);
    expect(again.body.products[0].inCatalog).toEqual({ id: res.body.id, title: 'Linen tee' });

    // Publishing the source store adds size L there, and nothing else changes.
    const preview = (
      await api('GET', `/api/catalog/products/${res.body.id}/preview?storeIds=${a!.id}`)
    ).body.stores[0];
    expect(preview).toMatchObject({
      action: 'update',
      variantsAdded: ['TEE-L'],
      variantsRemoved: [],
      imagesAdded: 0,
      imagesRemoved: [],
    });
  });

  it('shows an imported product as published when the brands match', async () => {
    const [a, b] = h.stores;
    const source = sizedProduct(a!, 'Wool socks', [{ sku: 'SOCK-1', size: 'One' }]);
    sizedProduct(b!, 'Wool socks', [{ sku: 'SOCK-1', size: 'One' }]);
    for (const s of h.stores) await readCatalog(s);
    const res = await api('POST', '/api/catalog/import', {
      storeId: a!.id,
      productId: source.productId,
    });
    const product = (await api('GET', `/api/catalog/products/${res.body.id}`)).body;
    expect(product.stores.map((s: any) => s.state)).toEqual(['published', 'published', 'never']);
  });

  it('refuses a product whose variants don’t all have their own SKU', async () => {
    const [a] = h.stores;
    const source = sizedProduct(a!, 'Gift box', [
      { sku: 'BOX-1', size: 'Small' },
      { sku: null, size: 'Large' },
    ]);
    await readCatalog(a!);
    const res = await api('POST', '/api/catalog/import', {
      storeId: a!.id,
      productId: source.productId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'Some variants of “Gift box” have no SKU (Large). Give every variant a SKU in Shopify, then import it.',
    );
    const gone = await api('POST', '/api/catalog/import', {
      storeId: a!.id,
      productId: 'gid://shopify/Product/1',
    });
    expect(gone).toEqual({
      status: 404,
      body: { error: 'This product isn’t in brand0 any more.' },
    });
  });

  it('reports a brand whose variants are spread over several products', async () => {
    const [a, b] = h.stores;
    const source = sizedProduct(a!, 'Cap', [
      { sku: 'CAP-1', size: 'S' },
      { sku: 'CAP-2', size: 'M' },
    ]);
    sizedProduct(b!, 'Cap small', [{ sku: 'CAP-1', size: 'S' }]);
    sizedProduct(b!, 'Cap medium', [{ sku: 'CAP-2', size: 'M' }]);
    for (const s of h.stores) await readCatalog(s);
    const res = await api('POST', '/api/catalog/import', {
      storeId: a!.id,
      productId: source.productId,
    });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([
      'In brand1 these SKUs are in several products (“Cap medium”, “Cap small”), so none was linked. Put them in one product in brand1, or publish to replace them.',
    ]);
  });
});

describe('the product page', () => {
  it('shows an item’s catalog product, or where it could be imported from', async () => {
    const [a] = h.stores;
    const item = await h.addItem('LOOSE-1', [1, 1, 1], [a!]);
    const section = await api('GET', `/api/catalog/items/${item.itemId}`);
    expect(section.body).toEqual({
      product: null,
      importable: [
        {
          storeId: a!.id,
          storeName: 'brand0',
          productId: expect.stringMatching(/^gid:\/\/shopify\/Product\//),
          productTitle: expect.any(String),
        },
      ],
    });
    const created = (await api('POST', '/api/catalog/products', tee())).body;
    const s = await h.db.query<{ id: number }>(`SELECT id FROM items WHERE sku = 'TEE-S'`);
    const inCatalog = await api('GET', `/api/catalog/items/${s.rows[0]!.id}`);
    expect(inCatalog.body.product).toMatchObject({ id: created.id, title: 'Linen tee' });
    expect((await api('GET', '/api/catalog/items/99999')).status).toBe(404);
  });

  it('says “not published yet” instead of “missing” for brands the product is meant for', async () => {
    const [, b] = h.stores;
    await api(
      'POST',
      '/api/catalog/products',
      tee({ stores: [{ storeId: b!.id, enabled: false }] }),
    );
    const s = await h.db.query<{ id: number }>(`SELECT id FROM items WHERE sku = 'TEE-S'`);
    const item = (await api('GET', `/api/items/${s.rows[0]!.id}`)).body;
    expect(item.issues).toEqual(['Not published in brand0 yet', 'Not published in brand2 yet']);
    const attention = (await api('GET', '/api/items?filter=issues')).body;
    expect(attention.total).toBe(0);
  });
});
