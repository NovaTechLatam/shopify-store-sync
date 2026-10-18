import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshInventoryItem, syncStoreCatalog } from '../src/catalog/catalog.js';
import { createProduct, updateProduct } from '../src/products/editor.js';
import { saveImage } from '../src/products/media.js';
import { loadMasterProduct, loadStoreContexts } from '../src/products/model.js';
import { loadCurrentPrices, storeState } from '../src/products/views.js';
import type { ProductSetRequest } from '../src/shopify/types.js';
import { enqueuePoolLevels } from '../src/sync/queue.js';
import { enqueueTask } from '../src/tasks/queue.js';
import { runTasksOnce } from '../src/tasks/runner.js';
import type { TaskDeps } from '../src/tasks/types.js';
import { Harness, silentLogger, type TestStore } from './helpers/harness.js';
import { PNG_1X1 } from './helpers/images.js';

let h: Harness;
let deps: TaskDeps;

beforeEach(async () => {
  h = await Harness.create(2);
  deps = { db: h.db, shopify: h.registry, logger: silentLogger, publicUrl: 'https://sync.test' };
  for (const s of h.stores) {
    // What the catalog needs: the permission, and the store's currency read once.
    s.shop.scopes.push('write_products', 'write_publications');
    await h.db.query(`UPDATE stores SET currency_code = 'USD' WHERE id = $1`, [s.id]);
  }
});

afterEach(async () => {
  await h.close();
});

const tee = (overrides: Record<string, unknown> = {}) => ({
  title: 'Linen tee',
  descriptionHtml: '<p>Soft linen.</p>',
  vendor: 'Northwind',
  status: 'ACTIVE',
  options: [{ name: 'Size', values: ['S', 'M'] }],
  variants: [
    { sku: 'TEE-S', optionValues: ['S'], basePrice: 10, cost: 4 },
    { sku: 'TEE-M', optionValues: ['M'], basePrice: 12 },
  ],
  ...overrides,
});

/** Queues a publish like the API does. */
async function publish(productId: number, stores: TestStore[] = h.stores) {
  for (const s of stores) {
    await h.db.query(
      `UPDATE master_product_stores SET publish_state = 'queued'
        WHERE master_product_id = $1 AND store_id = $2`,
      [productId, s.id],
    );
    await enqueueTask(h.db, 'publish_product', { masterProductId: productId, storeId: s.id });
  }
}

/** Runs tasks (retries included) and stock reconciles until nothing is left. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await h.db.query('UPDATE tasks SET run_after = now() WHERE lease_token IS NULL');
    const n = await runTasksOnce(h.db, deps, silentLogger, 10);
    await h.drain();
    if (n === 0) return;
  }
  throw new Error('did not settle');
}

/** Runs the queued tasks once (failures stay queued for later). */
async function runOnce() {
  await runTasksOnce(h.db, deps, silentLogger, 10);
}

async function brandRow(productId: number, storeId: number) {
  const { rows } = await h.db.query<{
    publish_state: string;
    shopify_product_id: string | null;
    last_error: string | null;
    warnings: string[];
    published_hash: string | null;
  }>(
    `SELECT publish_state, shopify_product_id, last_error, warnings, published_hash
       FROM master_product_stores WHERE master_product_id = $1 AND store_id = $2`,
    [productId, storeId],
  );
  return rows[0]!;
}

const productSets = (s: TestStore) =>
  s.shop.calls.filter((c) => c.op === 'productSet').map((c) => c.args as ProductSetRequest);

/** Products in the shop holding this SKU. */
const productsWithSku = (s: TestStore, sku: string) =>
  new Set(s.shop.variants.filter((v) => v.sku === sku).map((v) => v.productId));

describe('publishing a new product', () => {
  it('creates it in every brand at 0, links its variants and lets stock sync', async () => {
    await h.db.query('UPDATE stores SET exchange_rate = 4100, currency_code = $2 WHERE id = $1', [
      h.stores[1]!.id,
      'COP',
    ]);
    const id = await createProduct(h.db, tee());
    await publish(id);
    await settle();

    for (const [i, s] of h.stores.entries()) {
      const row = await brandRow(id, s.id);
      expect(row.publish_state).toBe('published');
      expect(row.last_error).toBeNull();
      const [request] = productSets(s);
      // Created through our custom id, so a retried create finds the same product.
      expect(request!.identifier).toEqual({ customId: String(id) });
      expect(s.shop.customIdOf(row.shopify_product_id!)).toBe(String(id));
      expect(s.shop.productIdDefinition).toBe(true);
      const variants = s.shop.variants.filter((v) => v.productId === row.shopify_product_id);
      expect(variants.map((v) => v.sku)).toEqual(['TEE-S', 'TEE-M']);
      // No price rule: the base price at the store's exchange rate.
      expect(variants.map((v) => v.price)).toEqual(i === 0 ? [10, 12] : [41_000, 49_200]);
      expect(s.shop.isPublished(row.shopify_product_id!)).toBe(true);
      // Every variant is linked to its item right away (no wait for a catalog read).
      const linked = await h.db.query<{ sku: string; item_id: number | null }>(
        `SELECT sku, item_id FROM variants WHERE store_id = $1 AND deleted_at IS NULL ORDER BY sku`,
        [s.id],
      );
      expect(linked.rows.map((r) => [r.sku, r.item_id !== null])).toEqual([
        ['TEE-M', true],
        ['TEE-S', true],
      ]);
    }
    // The new items started at 0 when the stores first sold them.
    const levels = await h.db.query<{ sku: string; quantity: number | null }>(
      `SELECT i.sku, pl.quantity FROM pool_levels pl JOIN items i ON i.id = pl.item_id ORDER BY i.sku`,
    );
    expect(levels.rows).toEqual([
      { sku: 'TEE-M', quantity: 0 },
      { sku: 'TEE-S', quantity: 0 },
    ]);

    // Received stock reaches both brands.
    const level = await h.db.query<{ id: number }>(
      `SELECT pl.id FROM pool_levels pl JOIN items i ON i.id = pl.item_id WHERE i.sku = 'TEE-S'`,
    );
    await h.db.query(
      `INSERT INTO pool_adjustments (pool_level_id, kind, value, note) VALUES ($1, 'adjust', 5, 'Delivery')`,
      [level.rows[0]!.id],
    );
    await enqueuePoolLevels(h.db, [level.rows[0]!.id], 'test');
    await h.drain();
    for (const s of h.stores) {
      const v = s.shop.variants.find((x) => x.sku === 'TEE-S')!;
      expect(s.shop.level(v.inventoryItemId, s.locationId)).toBe(5);
    }

    // The custom-id field is created once per store.
    await publish(id);
    await settle();
    for (const s of h.stores) {
      expect(s.shop.calls.filter((c) => c.op === 'ensureProductIdDefinition')).toHaveLength(1);
    }
  });

  it('sends the store’s rule prices, fixed prices and the cost in the store’s currency', async () => {
    const [a] = h.stores;
    await h.db.query(
      `INSERT INTO price_rules (store_id, enabled, multiplier, round_mode, round_step,
                                round_ending, round_direction)
       VALUES ($1, true, 1.5, 'ending', 1, 0.9, 'up')`,
      [a!.id],
    );
    const id = await createProduct(h.db, tee());
    const m = await h.db.query<{ id: number }>(`SELECT id FROM items WHERE sku = 'TEE-M'`);
    await h.db.query(
      `INSERT INTO price_overrides (store_id, item_id, price, compare_at_price) VALUES ($1, $2, 25, 30)`,
      [a!.id, m.rows[0]!.id],
    );
    await publish(id, [a!]);
    await settle();
    const [request] = productSets(a!);
    expect(request!.input.variants!.map((v) => [v.sku, v.price, v.compareAtPrice])).toEqual([
      ['TEE-S', '15.90', null],
      ['TEE-M', '25.00', '30.00'],
    ]);
    expect(request!.input.variants![0]!.inventoryItem!.cost).toBe('4.00');
    expect(request!.input.variants![1]!.inventoryItem!.cost).toBeUndefined();
  });

  it('refuses a new product without a price, naming the SKU', async () => {
    const id = await createProduct(
      h.db,
      tee({
        variants: [
          { sku: 'TEE-S', optionValues: ['S'] },
          { sku: 'TEE-M', optionValues: ['M'], basePrice: 1 },
        ],
      }),
    );
    await publish(id, [h.stores[0]!]);
    await settle();
    const row = await brandRow(id, h.stores[0]!.id);
    expect(row.publish_state).toBe('failed');
    expect(row.last_error).toContain('SKU TEE-S has no price');
    expect(productSets(h.stores[0]!)).toHaveLength(0);
  });
});

describe('retries never make a second copy', () => {
  it('a create that went through before the connection dropped is found again by custom id', async () => {
    const [a] = h.stores;
    const id = await createProduct(h.db, tee());
    a!.shop.failNext('productSet', 'throw_after');
    await publish(id, [a!]);
    await runOnce();
    const waiting = await brandRow(id, a!.id);
    expect(waiting.publish_state).toBe('queued');
    expect(waiting.last_error).toMatch(/^Interrupted, trying again soon/);
    await settle();
    expect((await brandRow(id, a!.id)).publish_state).toBe('published');
    expect(productsWithSku(a!, 'TEE-S').size).toBe(1);
    expect(productSets(a!).map((r) => r.identifier)).toEqual([
      { customId: String(id) },
      { customId: String(id) },
    ]);
  });

  it('…or by its SKUs, once the store told us about the new variants', async () => {
    const [a] = h.stores;
    const id = await createProduct(h.db, tee());
    a!.shop.failNext('productSet', 'throw_after');
    await publish(id, [a!]);
    await runOnce();
    // Shopify's "inventory item created" notifications arrive before the retry.
    for (const v of a!.shop.variants) {
      await refreshInventoryItem(
        { db: h.db, shopify: h.registry, logger: silentLogger },
        a!.id,
        v.inventoryItemId,
      );
    }
    await settle();
    expect(productsWithSku(a!, 'TEE-S').size).toBe(1);
    const productId = [...productsWithSku(a!, 'TEE-S')][0]!;
    expect(productSets(a!).at(-1)!.identifier).toEqual({ id: productId });
    expect((await brandRow(id, a!.id)).shopify_product_id).toBe(productId);
  });

  it('network trouble before Shopify got the request: retried, nothing doubled', async () => {
    const [a] = h.stores;
    const id = await createProduct(h.db, tee());
    a!.shop.failNext('productSet', 'throw_before');
    await publish(id, [a!]);
    await runOnce();
    const task = await h.db.query<{ attempts: number; last_error: string }>(
      `SELECT attempts, last_error FROM tasks WHERE kind = 'publish_product'`,
    );
    expect(task.rows[0]).toMatchObject({ attempts: 1, last_error: 'fake network error' });
    await settle();
    expect((await brandRow(id, a!.id)).publish_state).toBe('published');
    expect(productsWithSku(a!, 'TEE-S').size).toBe(1);
  });
});

describe('a store that already has the product', () => {
  async function readCatalog(s: TestStore) {
    await syncStoreCatalog({ db: h.db, shopify: h.registry, logger: silentLogger }, s.id);
  }

  it('updates the product holding exactly our SKUs instead of creating a copy', async () => {
    const [a] = h.stores;
    const existing = a!.shop.addProduct({
      title: 'Old linen tee',
      productOptions: [{ name: 'Size', values: [{ name: 'S' }] }],
      variants: [{ sku: 'tee-s', optionValues: [{ optionName: 'Size', name: 'S' }], price: '9' }],
    });
    a!.shop.stock(existing.variants[0]!.inventoryItemId, a!.locationId, 7);
    await readCatalog(a!);
    const id = await createProduct(h.db, tee());
    await publish(id, [a!]);
    await settle();
    expect(productSets(a!)[0]!.identifier).toEqual({ id: existing.productId });
    expect(productsWithSku(a!, 'TEE-S')).toEqual(new Set([existing.productId]));
    // Its variant kept its id and inventory item (and so its stock link).
    const kept = a!.shop.variants.find((v) => v.variantId === existing.variants[0]!.id)!;
    expect(kept.sku).toBe('TEE-S');
    expect(kept.inventoryItemId).toBe(existing.variants[0]!.inventoryItemId);
    expect(a!.shop.variants.filter((v) => v.productId === existing.productId)).toHaveLength(2);
    const row = await brandRow(id, a!.id);
    expect(row.publish_state).toBe('published');
    expect(row.shopify_product_id).toBe(existing.productId);
    expect(row.warnings[0]).toContain('Updated “Old linen tee”');
  });

  it('refuses when our SKUs are in a product with other variants', async () => {
    const [a] = h.stores;
    a!.shop.addProduct({
      title: 'Tee bundle',
      productOptions: [{ name: 'Size', values: [{ name: 'S' }, { name: 'XL' }] }],
      variants: [
        { sku: 'TEE-S', optionValues: [{ optionName: 'Size', name: 'S' }], price: '9' },
        { sku: 'TEE-XL', optionValues: [{ optionName: 'Size', name: 'XL' }], price: '9' },
      ],
    });
    await readCatalog(a!);
    const id = await createProduct(h.db, tee());
    await publish(id, [a!]);
    await settle();
    const row = await brandRow(id, a!.id);
    expect(row.publish_state).toBe('failed');
    expect(row.last_error).toContain('already has TEE-S in “Tee bundle” (with other variants)');
    expect(productSets(a!)).toHaveLength(0);
    const alert = await h.db.query<{ kind: string; message: string }>(
      `SELECT kind, message FROM alerts WHERE resolved_at IS NULL`,
    );
    expect(alert.rows).toEqual([expect.objectContaining({ kind: 'catalog_publish_failed' })]);
    expect(alert.rows[0]!.message).toMatch(/^“Linen tee” couldn’t be published to brand0: /);
  });

  it('refuses to add a variant whose SKU is in another product of the store', async () => {
    const [a] = h.stores;
    const id = await createProduct(
      h.db,
      tee({ variants: [{ sku: 'TEE-S', optionValues: ['S'], basePrice: 10 }] }),
    );
    await publish(id, [a!]);
    await settle();
    // Meanwhile, the merchant made a separate product with TEE-M in Shopify.
    a!.shop.addProduct({
      title: 'Tee M (manual)',
      variants: [{ sku: 'TEE-M', optionValues: [{ optionName: 'Title', name: 'Default Title' }] }],
      productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
    });
    await readCatalog(a!);
    await updateProduct(h.db, id, {
      variants: [
        { sku: 'TEE-S', optionValues: ['S'] },
        { sku: 'TEE-M', optionValues: ['M'], basePrice: 12 },
      ],
    });
    await publish(id, [a!]);
    await settle();
    const row = await brandRow(id, a!.id);
    expect(row.publish_state).toBe('failed');
    expect(row.last_error).toContain('TEE-M in “Tee M (manual)”');
    expect(productSets(a!)).toHaveLength(1);
  });
});

describe('updating a published product', () => {
  it('deletes only the variants removed from the catalog; the others keep their ids', async () => {
    const [a] = h.stores;
    const id = await createProduct(h.db, tee());
    await publish(id, [a!]);
    await settle();
    const before = a!.shop.variants.find((v) => v.sku === 'TEE-S')!;
    await updateProduct(h.db, id, {
      options: [{ name: 'Size', values: ['S', 'L'] }],
      variants: [
        { sku: 'TEE-S', optionValues: ['S'] },
        { sku: 'TEE-L', optionValues: ['L'], basePrice: 14 },
      ],
    });
    await publish(id, [a!]);
    await settle();
    const productId = (await brandRow(id, a!.id)).shopify_product_id!;
    expect(productSets(a!).at(-1)!.identifier).toEqual({ id: productId });
    const now = a!.shop.variants.filter((v) => v.productId === productId);
    expect(now.map((v) => v.sku)).toEqual(['TEE-S', 'TEE-L']);
    expect(now[0]!.variantId).toBe(before.variantId);
    expect(now[0]!.inventoryItemId).toBe(before.inventoryItemId);
    // Our copy of the store's catalog follows at once.
    const rows = await h.db.query<{ sku: string; deleted: boolean; linked: boolean }>(
      `SELECT sku, deleted_at IS NOT NULL AS deleted, item_id IS NOT NULL AS linked
         FROM variants WHERE store_id = $1 ORDER BY sku`,
      [a!.id],
    );
    expect(rows.rows).toEqual([
      { sku: 'TEE-L', deleted: false, linked: true },
      { sku: 'TEE-M', deleted: true, linked: false },
      { sku: 'TEE-S', deleted: false, linked: true },
    ]);
  });

  it('re-reads only the new variants, and remembers the prices it sent', async () => {
    const [a] = h.stores;
    await h.db.query(`INSERT INTO price_rules (store_id, enabled) VALUES ($1, true)`, [a!.id]);
    const id = await createProduct(h.db, tee());
    await publish(id, [a!]);
    await settle();
    const reads = vi.spyOn(a!.shop, 'listVariantsByInventoryItem');
    const product = (await loadMasterProduct(h.db, id))!;
    await updateProduct(h.db, id, {
      options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
      variants: [
        { id: product.variants[0]!.id, sku: 'TEE-S', optionValues: ['S'], basePrice: 11 },
        { id: product.variants[1]!.id, sku: 'TEE-M', optionValues: ['M'] },
        { sku: 'TEE-L', optionValues: ['L'], basePrice: 14 },
      ],
    });
    await publish(id, [a!]);
    await settle();
    const tl = a!.shop.variants.find((v) => v.sku === 'TEE-L')!;
    expect(reads.mock.calls).toEqual([[tl.inventoryItemId]]);
    const prices = await h.db.query<{ sku: string; price: number }>(
      `SELECT sku, price FROM variants WHERE store_id = $1 AND deleted_at IS NULL ORDER BY sku`,
      [a!.id],
    );
    expect(prices.rows).toEqual([
      { sku: 'TEE-L', price: 14 },
      { sku: 'TEE-M', price: 12 },
      { sku: 'TEE-S', price: 11 },
    ]);
  });

  it('uploads an image once, then refers to it; again only if it was deleted in Shopify', async () => {
    const [a] = h.stores;
    const image = await saveImage(h.db, PNG_1X1, 'front.png');
    const id = await createProduct(
      h.db,
      tee({ media: [{ fileId: image.id, alt: 'Front', optionValue: 'S' }] }),
    );
    await publish(id, [a!]);
    await settle();
    expect(a!.shop.stagedUploads).toHaveLength(1);
    expect(a!.shop.stagedUploads[0]!.data.equals(PNG_1X1)).toBe(true);
    expect(a!.shop.stagedUploads[0]!.filename).toBe('front.png');
    const first = productSets(a!)[0]!;
    expect(first.input.files).toEqual([
      expect.objectContaining({
        originalSource: a!.shop.stagedUploads[0]!.resourceUrl,
        alt: 'Front',
      }),
    ]);
    // The S variant shows it.
    expect(first.input.variants![0]!.file).toEqual(first.input.files![0]);
    const link = await h.db.query<{ shopify_media_id: string }>(
      'SELECT shopify_media_id FROM master_media_links WHERE store_id = $1',
      [a!.id],
    );
    expect(link.rows).toHaveLength(1);

    await updateProduct(h.db, id, { title: 'Linen tee (new)' });
    await publish(id, [a!]);
    await settle();
    expect(a!.shop.stagedUploads).toHaveLength(1);
    expect(productSets(a!).at(-1)!.input.files).toEqual([
      { id: link.rows[0]!.shopify_media_id, alt: 'Front' },
    ]);

    // Someone deletes the image in the Shopify admin.
    const productId = (await brandRow(id, a!.id)).shopify_product_id!;
    await a!.shop.productSet({ identifier: { id: productId }, input: { files: [] } });
    await publish(id, [a!]);
    await settle();
    expect(a!.shop.stagedUploads).toHaveLength(2);
    const relinked = await h.db.query<{ shopify_media_id: string }>(
      'SELECT shopify_media_id FROM master_media_links WHERE store_id = $1',
      [a!.id],
    );
    expect(relinked.rows[0]!.shopify_media_id).not.toBe(link.rows[0]!.shopify_media_id);
  });

  it('creates the product again when it was deleted in Shopify, and says so', async () => {
    const [a] = h.stores;
    const id = await createProduct(h.db, tee());
    await publish(id, [a!]);
    await settle();
    const old = (await brandRow(id, a!.id)).shopify_product_id!;
    a!.shop.removeProduct(old);
    await publish(id, [a!]);
    await settle();
    const row = await brandRow(id, a!.id);
    expect(row.publish_state).toBe('published');
    expect(row.shopify_product_id).not.toBe(old);
    expect(row.warnings.join(' ')).toContain('deleted in brand0');
  });

  it('shows unpublished edits and price differences as “changed”', async () => {
    const [a] = h.stores;
    await h.db.query(`INSERT INTO price_rules (store_id, enabled) VALUES ($1, true)`, [a!.id]);
    const id = await createProduct(h.db, tee());
    await publish(id, [a!]);
    await settle();
    const state = async () => {
      const product = (await loadMasterProduct(h.db, id))!;
      const itemIds = product.variants.map((v) => v.itemId);
      const [ctx] = await loadStoreContexts(h.db, itemIds, [a!.id]);
      const current = await loadCurrentPrices(h.db, itemIds);
      return storeState(product, ctx!, product.stores.get(a!.id), current);
    };
    expect(await state()).toEqual({ state: 'published', changedReason: null });
    // A price changed in Shopify (what we last read differs from what we'd send).
    await h.db.query(`UPDATE variants SET price = 11 WHERE store_id = $1 AND sku = 'TEE-S'`, [
      a!.id,
    ]);
    expect(await state()).toEqual({ state: 'changed', changedReason: 'prices' });
    await h.db.query(`UPDATE variants SET price = 10 WHERE store_id = $1 AND sku = 'TEE-S'`, [
      a!.id,
    ]);
    expect(await state()).toEqual({ state: 'published', changedReason: null });
    // Without a rule Store Sync doesn't manage the store's prices: nothing to compare.
    await h.db.query(`UPDATE price_rules SET enabled = false`);
    await h.db.query(`UPDATE variants SET price = 11 WHERE store_id = $1 AND sku = 'TEE-S'`, [
      a!.id,
    ]);
    expect(await state()).toEqual({ state: 'published', changedReason: null });
    await updateProduct(h.db, id, { stores: [{ storeId: a!.id, title: 'Linen tee by A' }] });
    expect(await state()).toEqual({ state: 'changed', changedReason: 'content' });
    // A new average cost doesn't make it "changed".
    await h.db.query(`UPDATE items SET cost = 5`);
    await publish(id, [a!]);
    await settle();
    expect(await state()).toEqual({ state: 'published', changedReason: null });
  });
});

describe('what stops a publish', () => {
  it('a missing permission: recorded with the steps, the store left alone, no retry', async () => {
    const [a] = h.stores;
    await h.db.query(`UPDATE stores SET granted_scopes = $2 WHERE id = $1`, [
      a!.id,
      ['read_products', 'read_inventory', 'write_inventory', 'read_locations'],
    ]);
    const id = await createProduct(h.db, tee());
    await publish(id, [a!]);
    await settle();
    const row = await brandRow(id, a!.id);
    expect(row.publish_state).toBe('failed');
    expect(row.last_error).toContain(
      'hasn’t given Store Sync permission to create and update its products (write_products)',
    );
    expect(a!.shop.calls.filter((c) => c.op !== 'getShop')).toEqual([]);
    const store = await h.db.query<{ status: string }>('SELECT status FROM stores WHERE id = $1', [
      a!.id,
    ]);
    expect(store.rows[0]!.status).toBe('active');
    expect((await h.db.query('SELECT 1 FROM tasks')).rowCount).toBe(0);
  });

  it('Shopify refusing for lack of permission (scopes not read yet): failed, store not in error', async () => {
    const [a] = h.stores;
    a!.shop.scopes = ['read_products', 'read_inventory', 'write_inventory', 'read_locations'];
    const id = await createProduct(h.db, tee());
    await publish(id, [a!]);
    await settle();
    const row = await brandRow(id, a!.id);
    expect(row.publish_state).toBe('failed');
    expect(row.last_error).toMatch(
      /^Shopify refused: brand0 hasn’t given Store Sync the permission/,
    );
    const store = await h.db.query<{ status: string }>('SELECT status FROM stores WHERE id = $1', [
      a!.id,
    ]);
    expect(store.rows[0]!.status).toBe('active');
    expect((await h.db.query('SELECT 1 FROM tasks')).rowCount).toBe(0);
  });

  it('an archived product a store doesn’t have yet', async () => {
    const [a] = h.stores;
    const id = await createProduct(h.db, tee({ status: 'ARCHIVED' }));
    await publish(id, [a!]);
    await settle();
    const row = await brandRow(id, a!.id);
    expect(row.publish_state).toBe('failed');
    expect(row.last_error).toContain('This product is archived and brand0 doesn’t have it');
  });

  it('a paused store', async () => {
    const [a] = h.stores;
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [a!.id]);
    const id = await createProduct(h.db, tee());
    await publish(id, [a!]);
    await settle();
    const row = await brandRow(id, a!.id);
    expect(row.publish_state).toBe('failed');
    expect(row.last_error).toBe('brand0 is paused. Resume it on its page, then publish again.');
  });

  it('what Shopify refuses (a taken handle), in plain words; fixed, the alert goes away', async () => {
    const [a] = h.stores;
    a!.shop.addProduct({ title: 'Other', handle: 'linen-tee' });
    const id = await createProduct(h.db, tee({ handle: 'linen-tee' }));
    await publish(id, [a!]);
    await settle();
    const row = await brandRow(id, a!.id);
    expect(row.publish_state).toBe('failed');
    expect(row.last_error).toBe(
      'brand0 refused the product: the web address (handle) is already used by another product in brand0: choose another handle for this brand.',
    );
    const open = () =>
      h.db.query(
        `SELECT 1 FROM alerts WHERE kind = 'catalog_publish_failed' AND resolved_at IS NULL`,
      );
    expect((await open()).rowCount).toBe(1);
    await updateProduct(h.db, id, { stores: [{ storeId: a!.id, handle: 'linen-tee-a' }] });
    await publish(id, [a!]);
    await settle();
    expect((await brandRow(id, a!.id)).publish_state).toBe('published');
    expect((await open()).rowCount).toBe(0);
  });

  it('a brand turned off after a failure has no publishing alert left', async () => {
    const [a] = h.stores;
    a!.shop.addProduct({ title: 'Other', handle: 'linen-tee' });
    const id = await createProduct(h.db, tee({ handle: 'linen-tee' }));
    await publish(id, [a!]);
    await settle();
    const open = () =>
      h.db.query(
        `SELECT 1 FROM alerts WHERE kind = 'catalog_publish_failed' AND resolved_at IS NULL`,
      );
    expect((await open()).rowCount).toBe(1);
    await updateProduct(h.db, id, { stores: [{ storeId: a!.id, enabled: false }] });
    expect((await open()).rowCount).toBe(0);
  });

  it('a brand turned off after publishing was asked for goes back to its last state', async () => {
    const [a] = h.stores;
    const id = await createProduct(h.db, tee());
    await publish(id, [a!]);
    await updateProduct(h.db, id, { stores: [{ storeId: a!.id, enabled: false }] });
    await settle();
    expect((await brandRow(id, a!.id)).publish_state).toBe('never');
    expect(productSets(a!)).toHaveLength(0);
  });
});

describe('the Online Store', () => {
  it('hides the product when asked, and only shows active products', async () => {
    const [a, b] = h.stores;
    const id = await createProduct(
      h.db,
      tee({
        stores: [
          { storeId: a!.id, publishToOnlineStore: false },
          { storeId: b!.id, status: 'DRAFT' },
        ],
      }),
    );
    await publish(id);
    await settle();
    expect(a!.shop.calls.some((c) => c.op === 'unpublishProduct')).toBe(true);
    expect(a!.shop.calls.some((c) => c.op === 'publishProduct')).toBe(false);
    expect(
      b!.shop.calls.some((c) => c.op === 'publishProduct' || c.op === 'unpublishProduct'),
    ).toBe(false);
    // The publication is looked up once and remembered.
    const cached = await h.db.query<{ online_store_publication_id: string | null }>(
      'SELECT online_store_publication_id FROM stores WHERE id = $1',
      [a!.id],
    );
    expect(cached.rows[0]!.online_store_publication_id).toBe(a!.shop.publications[0]!.id);
  });

  it('without the permission: published anyway, with a warning', async () => {
    const [a] = h.stores;
    await h.db.query(`UPDATE stores SET granted_scopes = $2 WHERE id = $1`, [
      a!.id,
      ['read_products', 'write_products', 'write_inventory', 'read_locations'],
    ]);
    const id = await createProduct(h.db, tee());
    await publish(id, [a!]);
    await settle();
    const row = await brandRow(id, a!.id);
    expect(row.publish_state).toBe('published');
    expect(row.warnings.join(' ')).toContain('(write_publications)');
  });
});
