import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { withTransaction } from '../src/db/pool.js';
import { PRICING_HOUSEKEEPING, PRICING_JOBS } from '../src/pricing/jobs.js';
import { createPriceRun } from '../src/pricing/runs.js';
import type { ScheduleInput } from '../src/pricing/schedules.js';
import {
  cancelSchedule,
  createSchedule,
  loadSchedules,
  runSchedule,
  updateSchedule,
} from '../src/pricing/schedules.js';
import { runTasksOnce } from '../src/tasks/runner.js';
import type { TaskDeps } from '../src/tasks/types.js';
import { Harness, silentLogger } from './helpers/harness.js';
import type { TestItem, TestStore } from './helpers/harness.js';

/** Sales and base price changes: start, end, cancel, and what they put back. */

const ALL_SCOPES = ['read_products', 'write_products', 'read_inventory', 'write_inventory'];

let h: Harness;
let ruled: TestStore; // USD, rule on (prices ending in .99)
let own: TestStore; // COP, rule off: the store sets its own prices

const deps = (): TaskDeps => ({
  db: h.db,
  shopify: h.registry,
  logger: silentLogger,
  publicUrl: 'https://sync.example.com',
});

beforeEach(async () => {
  h = await Harness.create(2);
  [ruled, own] = h.stores as [TestStore, TestStore];
  own.shop.currencyCode = 'COP';
  for (const s of h.stores) s.shop.scopes = [...ALL_SCOPES, 'read_locations'];
  await h.db.query(
    `UPDATE stores SET currency_code = CASE WHEN id = $1 THEN 'USD' ELSE 'COP' END,
            exchange_rate = CASE WHEN id = $1 THEN 1 ELSE 4000 END, granted_scopes = $2`,
    [ruled.id, ALL_SCOPES],
  );
  await h.db.query(
    `INSERT INTO price_rules (store_id, enabled, round_mode, round_step, round_ending, round_direction)
     VALUES ($1, true, 'ending', 1, 0.99, 'nearest'), ($2, false, 'none', 1, 0, 'nearest')`,
    [ruled.id, own.id],
  );
});

afterEach(async () => {
  await h.close();
});

function shopVariant(store: TestStore, item: TestItem) {
  const inventoryItemId = item.inventoryItemIds.get(store.id)!;
  return store.shop.variants.find((v) => v.inventoryItemId === inventoryItemId)!;
}

/** Sold in both stores; the stores charge `prices` now (the database knows them too). */
async function item(sku: string, basePrice: number | null, prices: [number, number]) {
  const it = await h.addItem(sku, [5, 5]);
  await h.db.query('UPDATE items SET base_price = $2 WHERE id = $1', [it.itemId, basePrice]);
  for (const [i, store] of h.stores.entries()) {
    shopVariant(store, it).price = prices[i]!;
    await h.db.query('UPDATE variants SET price = $3 WHERE store_id = $1 AND item_id = $2', [
      store.id,
      it.itemId,
      prices[i],
    ]);
  }
  return it;
}

const minutes = (n: number) => new Date(Date.now() + n * 60_000);

function sale(itemIds: number[], extra: Partial<Extract<ScheduleInput, { kind: 'sale' }>> = {}) {
  return {
    kind: 'sale' as const,
    name: 'Summer sale',
    startsAt: minutes(-1),
    endsAt: minutes(60),
    storeIds: null,
    itemIds,
    percentOff: 20,
    showCompareAt: true,
    ...extra,
  };
}

/** Lets the sale's end be due now (the CHECK keeps ends_at after starts_at). */
async function makeEndDue(id: number) {
  await h.db.query(
    `UPDATE price_schedules SET starts_at = now() - interval '2 hours',
                                ends_at = now() - interval '1 second' WHERE id = $1`,
    [id],
  );
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await h.db.query('UPDATE tasks SET run_after = now() WHERE run_after > now()');
    if ((await runTasksOnce(h.db, deps(), silentLogger, 10)) === 0) return;
  }
}

async function overrides() {
  const { rows } = await h.db.query<{
    store_id: number;
    item_id: number;
    price: number;
    compare_at_price: number | null;
    schedule_id: number | null;
    note: string | null;
  }>('SELECT * FROM price_overrides ORDER BY store_id, item_id');
  return rows;
}

const schedule = async (id: number) => (await loadSchedules(h.db, { id }))[0]!;

describe('sales', () => {
  it('starts: fixed sale prices from the regular price, shown crossed out, written to the stores', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const id = await createSchedule(h.db, sale([tee.itemId]));
    await runSchedule(deps(), id);

    const s = await schedule(id);
    expect(s.status).toBe('active');
    expect(s.pricesChanged).toBe(2);
    // Ruled store: 24.99 × 0.8 = 19.992 → nearest .99 = 19.99. Own store: 99,000 × 0.8.
    expect(await overrides()).toEqual([
      expect.objectContaining({
        store_id: ruled.id,
        price: 19.99,
        compare_at_price: 24.99,
        schedule_id: id,
        note: 'Sale: Summer sale',
      }),
      expect.objectContaining({ store_id: own.id, price: 79200, compare_at_price: 99000 }),
    ]);
    await settle();
    expect(shopVariant(ruled, tee)).toMatchObject({ price: 19.99, compareAtPrice: 24.99 });
    expect(shopVariant(own, tee)).toMatchObject({ price: 79200, compareAtPrice: 99000 });
    expect(s.lastRun).not.toBeNull();
  });

  it('takes a store’s own price as it is in Shopify at the start, not as last read', async () => {
    const tee = await item('TEE', 10, [10.99, 50000]);
    // Changed in the Shopify admin since the last catalog read.
    shopVariant(own, tee).price = 60000;
    const id = await createSchedule(h.db, sale([tee.itemId], { storeIds: [own.id] }));
    await runSchedule(deps(), id);
    expect((await overrides())[0]).toMatchObject({ price: 48000, compare_at_price: 60000 });
  });

  it('ends: puts everything back, leaving prices changed meanwhile alone', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const cap = await item('CAP', 10, [10.99, 40000]);
    const id = await createSchedule(h.db, sale([tee.itemId, cap.itemId]));
    await runSchedule(deps(), id);
    await settle();
    // Meanwhile: the base price changes, and someone edits CAP's price in the own store's admin.
    await h.db.query('UPDATE items SET base_price = 30 WHERE id = $1', [tee.itemId]);
    shopVariant(own, cap).price = 35000;

    await makeEndDue(id);
    await runSchedule(deps(), id);
    expect((await schedule(id)).status).toBe('ended');
    expect(await overrides()).toEqual([]);
    await settle();
    // Ruled store: back to the rule, with today's base price.
    expect(shopVariant(ruled, tee)).toMatchObject({ price: 29.99, compareAtPrice: null });
    expect(shopVariant(ruled, cap).price).toBe(9.99);
    // Own store: its own price back, except where it was changed during the sale.
    expect(shopVariant(own, tee)).toMatchObject({ price: 99000, compareAtPrice: null });
    expect(shopVariant(own, cap).price).toBe(35000);
  });

  it('puts back a fixed price that was there before the sale', async () => {
    const tee = await item('TEE', 24.99, [29.99, 99000]);
    await h.db.query(
      `INSERT INTO price_overrides (store_id, item_id, price, compare_at_price, note)
       VALUES ($1, $2, 29.99, 35, 'Launch price')`,
      [ruled.id, tee.itemId],
    );
    const id = await createSchedule(h.db, sale([tee.itemId], { storeIds: [ruled.id] }));
    await runSchedule(deps(), id);
    // 29.99 × 0.8 = 23.992 → 23.99, crossed out: the fixed price.
    expect((await overrides())[0]).toMatchObject({ price: 23.99, compare_at_price: 29.99 });
    await makeEndDue(id);
    await runSchedule(deps(), id);
    expect(await overrides()).toEqual([
      expect.objectContaining({
        price: 29.99,
        compare_at_price: 35,
        note: 'Launch price',
        schedule_id: null,
      }),
    ]);
  });

  it('leaves a fixed price the merchant set during the sale', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const id = await createSchedule(h.db, sale([tee.itemId], { storeIds: [ruled.id] }));
    await runSchedule(deps(), id);
    // What PUT /api/prices/overrides does: the merchant's price, no longer the sale's.
    await h.db.query(
      `UPDATE price_overrides SET price = 17.5, schedule_id = NULL WHERE store_id = $1`,
      [ruled.id],
    );
    await makeEndDue(id);
    await runSchedule(deps(), id);
    expect(await overrides()).toEqual([
      expect.objectContaining({ price: 17.5, schedule_id: null }),
    ]);
  });

  it('shows no compare-at price when asked not to', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const id = await createSchedule(
      h.db,
      sale([tee.itemId], { storeIds: [ruled.id], showCompareAt: false }),
    );
    await runSchedule(deps(), id);
    expect((await overrides())[0]).toMatchObject({ price: 19.99, compare_at_price: null });
  });

  it('starts and ends once when several workers try at the same moment', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const id = await createSchedule(h.db, sale([tee.itemId]));
    // Two instances' jobs claim due schedules at the same time: one task.
    const ctx = { db: h.db, logger: silentLogger, now: Date.now() };
    await Promise.all([PRICING_JOBS[0]!.run(ctx), PRICING_JOBS[0]!.run(ctx)]);
    const tasks = await h.db.query(`SELECT 1 FROM tasks WHERE kind = 'price_schedule'`);
    expect(tasks.rowCount).toBe(1);
    // Two tasks running the same schedule anyway (an expired lease): it starts once.
    await Promise.all([runSchedule(deps(), id), runSchedule(deps(), id)]);
    const starts = await h.db.query(`SELECT 1 FROM price_runs WHERE reason = $1`, [
      `schedule:${id}:start`,
    ]);
    expect(starts.rowCount).toBe(1);
    await makeEndDue(id);
    await Promise.all([runSchedule(deps(), id), runSchedule(deps(), id)]);
    const ends = await h.db.query(`SELECT 1 FROM price_runs WHERE reason = $1`, [
      `schedule:${id}:end`,
    ]);
    expect(ends.rowCount).toBe(1);
  });

  it('does nothing before its time', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const id = await createSchedule(h.db, sale([tee.itemId], { startsAt: minutes(30) }));
    await runSchedule(deps(), id);
    await PRICING_JOBS[0]!.run({ db: h.db, logger: silentLogger, now: Date.now() });
    expect((await schedule(id)).status).toBe('scheduled');
    expect(await overrides()).toEqual([]);
    const tasks = await h.db.query('SELECT 1 FROM tasks');
    expect(tasks.rowCount).toBe(0);
  });

  it('is carried out by the job and the task runner', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const id = await createSchedule(h.db, sale([tee.itemId]));
    let woken = 0;
    await PRICING_JOBS[0]!.run({
      db: h.db,
      logger: pino({ level: 'silent' }),
      now: Date.now(),
      onWork: () => woken++,
    });
    expect(woken).toBe(1);
    await settle();
    expect((await schedule(id)).status).toBe('active');
    expect(shopVariant(ruled, tee).price).toBe(19.99);
  });

  it('fails, with an alert, when none of its products can go on sale', async () => {
    const lonely = await h.addItem('LONELY', [1, 1], []); // sold nowhere
    const id = await createSchedule(h.db, sale([lonely.itemId]));
    await runSchedule(deps(), id);
    const s = await schedule(id);
    expect(s.status).toBe('failed');
    expect(s.error).toContain('nothing went on sale');
    const alerts = await h.db.query<{ kind: string; message: string }>(
      'SELECT kind, message FROM alerts WHERE resolved_at IS NULL',
    );
    expect(alerts.rows).toEqual([
      {
        kind: 'price_schedule_failed',
        message: expect.stringContaining('The sale “Summer sale” didn’t start'),
      },
    ]);
  });

  it('raises an alert when a store can’t be updated at the start', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [own.id]);
    const id = await createSchedule(h.db, sale([tee.itemId]));
    await runSchedule(deps(), id);
    const alerts = await h.db.query<{ kind: string; store_id: number; message: string }>(
      'SELECT kind, store_id, message FROM alerts WHERE resolved_at IS NULL',
    );
    expect(alerts.rows).toEqual([
      expect.objectContaining({
        kind: 'price_update_failed',
        store_id: own.id,
        message: expect.stringContaining('the start of the sale “Summer sale”'),
      }),
    ]);
  });
});

describe('sales back to back, and putting prices back late', () => {
  /** Sale A has been running; its end and sale B's start are both due now. */
  async function backToBack(tee: TestItem) {
    const a = await createSchedule(h.db, sale([tee.itemId], { name: 'Black Friday' }));
    await runSchedule(deps(), a);
    await settle();
    const b = await createSchedule(
      h.db,
      sale([tee.itemId], {
        name: 'Cyber Monday',
        startsAt: minutes(61),
        endsAt: minutes(120),
        percentOff: 30,
      }),
    );
    await makeEndDue(a);
    await h.db.query(
      `UPDATE price_schedules SET starts_at = now() - interval '1 second' WHERE id = $1`,
      [b],
    );
    return { a, b };
  }

  it('starts the next sale from the regular price when it starts before the last one ended', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const { a, b } = await backToBack(tee);
    // The two tasks run in any order: here the start comes first.
    await runSchedule(deps(), b);
    await runSchedule(deps(), a);
    await settle();
    // 30% off the regular price, not off Black Friday's (19.99 and 79,200).
    // Ruled store: 24.99 × 0.7 = 17.493 → nearest .99 = 17.99. Own store: 99,000 × 0.7.
    expect(shopVariant(ruled, tee)).toMatchObject({ price: 17.99, compareAtPrice: 24.99 });
    expect(shopVariant(own, tee)).toMatchObject({ price: 69300, compareAtPrice: 99000 });

    await makeEndDue(b);
    await runSchedule(deps(), b);
    await settle();
    // Everything back to the regular prices, and no fixed price left behind.
    expect(await overrides()).toEqual([]);
    expect(shopVariant(ruled, tee)).toMatchObject({ price: 24.99, compareAtPrice: null });
    expect(shopVariant(own, tee)).toMatchObject({ price: 99000, compareAtPrice: null });
  });

  it('starts the next sale from the regular price before the last one’s prices are back', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const { a, b } = await backToBack(tee);
    // A ended, but its update hasn't reached the stores yet when B starts.
    await runSchedule(deps(), a);
    await runSchedule(deps(), b);
    await settle();
    expect(shopVariant(ruled, tee)).toMatchObject({ price: 17.99, compareAtPrice: 24.99 });
    expect(shopVariant(own, tee)).toMatchObject({ price: 69300, compareAtPrice: 99000 });

    await makeEndDue(b);
    await runSchedule(deps(), b);
    await settle();
    expect(await overrides()).toEqual([]);
    expect(shopVariant(own, tee)).toMatchObject({ price: 99000, compareAtPrice: null });
  });

  it('puts back the store’s own compare-at price where the rule leaves it as it is', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    await h.db.query(`UPDATE price_rules SET compare_at_mode = 'keep' WHERE store_id = $1`, [
      ruled.id,
    ]);
    // The merchant shows a list price of 30 in Shopify, which Store Sync leaves alone.
    shopVariant(ruled, tee).compareAtPrice = 30;
    await h.db.query(
      'UPDATE variants SET compare_at_price = 30 WHERE store_id = $1 AND item_id = $2',
      [ruled.id, tee.itemId],
    );
    const id = await createSchedule(h.db, sale([tee.itemId], { storeIds: [ruled.id] }));
    await runSchedule(deps(), id);
    await settle();
    expect(shopVariant(ruled, tee)).toMatchObject({ price: 19.99, compareAtPrice: 24.99 });
    await makeEndDue(id);
    await runSchedule(deps(), id);
    await settle();
    // Not the sale's 24.99 left crossed out next to the price (a fake discount once it drops).
    expect(shopVariant(ruled, tee)).toMatchObject({ price: 24.99, compareAtPrice: 30 });
  });

  it('puts the regular price back when the store’s rule was turned off during the sale', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const id = await createSchedule(h.db, sale([tee.itemId], { storeIds: [ruled.id] }));
    await runSchedule(deps(), id);
    await settle();
    expect(shopVariant(ruled, tee).price).toBe(19.99);
    await h.db.query('UPDATE price_rules SET enabled = false WHERE store_id = $1', [ruled.id]);
    await makeEndDue(id);
    await runSchedule(deps(), id);
    await settle();
    expect(shopVariant(ruled, tee)).toMatchObject({ price: 24.99, compareAtPrice: null });
  });

  it('puts a store’s own price back with the next update when the sale’s end couldn’t', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const id = await createSchedule(h.db, sale([tee.itemId], { storeIds: [own.id] }));
    await runSchedule(deps(), id);
    await settle();
    expect(shopVariant(own, tee).price).toBe(79200);
    // The store is paused when the sale ends: its prices can't be put back then.
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [own.id]);
    await makeEndDue(id);
    await runSchedule(deps(), id);
    await settle();
    expect(shopVariant(own, tee).price).toBe(79200);
    // Resumed, then "Update prices in stores…" as the alert says: the price goes back.
    await h.db.query(`UPDATE stores SET status = 'active' WHERE id = $1`, [own.id]);
    const run = await withTransaction(h.db, (client) =>
      createPriceRun(client, { reason: { kind: 'manual' }, itemIds: null, storeIds: [own.id] }),
    );
    expect(run?.stores).toEqual([expect.objectContaining({ storeId: own.id, status: 'queued' })]);
    await settle();
    expect(shopVariant(own, tee)).toMatchObject({ price: 99000, compareAtPrice: null });
    // Put back once: a later update has nothing left to restore there.
    const again = await withTransaction(h.db, (client) =>
      createPriceRun(client, { reason: { kind: 'manual' }, itemIds: null, storeIds: [own.id] }),
    );
    expect(again).toBeNull();
  });

  it('doesn’t start a sale whose end passed before it could start', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const id = await createSchedule(h.db, sale([tee.itemId]));
    // Store Sync wasn't running for the whole sale.
    await makeEndDue(id);
    await runSchedule(deps(), id);
    await settle();
    const s = await schedule(id);
    expect(s.status).toBe('failed');
    expect(s.error).toContain('ended before');
    expect(await overrides()).toEqual([]);
    expect(shopVariant(ruled, tee).price).toBe(24.99);
    expect(shopVariant(own, tee).price).toBe(99000);
    const runs = await h.db.query('SELECT 1 FROM price_runs');
    expect(runs.rowCount).toBe(0);
  });
});

describe('creating and changing schedules', () => {
  it('refuses a sale that overlaps another on the same products and stores', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const cap = await item('CAP', 10, [10.99, 40000]);
    await createSchedule(
      h.db,
      sale([tee.itemId], { name: 'Weekend', startsAt: minutes(60), endsAt: minutes(180) }),
    );
    await expect(
      createSchedule(
        h.db,
        sale([tee.itemId, cap.itemId], { startsAt: minutes(120), endsAt: minutes(200) }),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('overlaps “Weekend”'),
    });
    // Other products, other stores, or another time: fine.
    await createSchedule(
      h.db,
      sale([cap.itemId], { startsAt: minutes(120), endsAt: minutes(200) }),
    );
    await createSchedule(
      h.db,
      sale([tee.itemId], { startsAt: minutes(180), endsAt: minutes(240) }),
    );
    const { rows } = await h.db.query<{ id: number }>(
      `UPDATE price_schedules SET store_ids = $1 WHERE name = 'Weekend' RETURNING id`,
      [[ruled.id]],
    );
    expect(rows).toHaveLength(1);
    await createSchedule(
      h.db,
      sale([tee.itemId], { storeIds: [own.id], startsAt: minutes(60), endsAt: minutes(90) }),
    );
  });

  it('refuses dates that make no sense', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    await expect(
      createSchedule(h.db, sale([tee.itemId], { startsAt: minutes(60), endsAt: minutes(30) })),
    ).rejects.toMatchObject({ statusCode: 400, message: 'The sale must end after it starts.' });
    await expect(
      createSchedule(h.db, sale([tee.itemId], { startsAt: minutes(-60), endsAt: minutes(-30) })),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('in the past') });
    await expect(createSchedule(h.db, sale([tee.itemId, 999_999]))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('can be changed only before it starts', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const id = await createSchedule(h.db, sale([tee.itemId], { startsAt: minutes(30) }));
    await updateSchedule(h.db, id, sale([tee.itemId], { name: 'Bigger sale', percentOff: 30 }));
    expect(await schedule(id)).toMatchObject({ name: 'Bigger sale', percentOff: 30 });
    await runSchedule(deps(), id); // starts (its start is now in the past)
    await expect(updateSchedule(h.db, id, sale([tee.itemId]))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('cancels one that hasn’t started, and ends a running sale now', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const later = await createSchedule(
      h.db,
      sale([tee.itemId], { startsAt: minutes(120), endsAt: minutes(180) }),
    );
    expect(await cancelSchedule(h.db, later)).toBeNull();
    expect((await schedule(later)).status).toBe('cancelled');
    await expect(cancelSchedule(h.db, later)).rejects.toMatchObject({ statusCode: 409 });

    const now = await createSchedule(h.db, sale([tee.itemId]));
    await runSchedule(deps(), now);
    await settle();
    expect(shopVariant(ruled, tee).price).toBe(19.99);
    const run = await cancelSchedule(h.db, now);
    expect(run?.runId).toBeGreaterThan(0);
    const s = await schedule(now);
    expect(s.status).toBe('ended');
    expect(s.endedAt!.getTime()).toBeLessThan(s.endsAt!.getTime());
    await settle();
    expect(shopVariant(ruled, tee).price).toBe(24.99);
    expect(shopVariant(own, tee).price).toBe(99000);
    await expect(cancelSchedule(h.db, 999_999)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('base price changes', () => {
  it('sets the new base prices at their time and updates the stores', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    const cap = await item('CAP', null, [10.99, 40000]);
    const id = await createSchedule(h.db, {
      kind: 'base_change',
      name: 'Autumn prices',
      startsAt: minutes(-1),
      changes: [
        { itemId: tee.itemId, basePrice: 27, baseCompareAtPrice: 35 },
        { itemId: cap.itemId, basePrice: 12, baseCompareAtPrice: null },
      ],
    });
    await runSchedule(deps(), id);
    const s = await schedule(id);
    expect(s.status).toBe('ended');
    expect(s.changes).toEqual([
      expect.objectContaining({ sku: 'TEE', basePrice: 27, previousBasePrice: 24.99 }),
      expect.objectContaining({ sku: 'CAP', basePrice: 12, previousBasePrice: null }),
    ]);
    const { rows } = await h.db.query<{ base_price: number; base_compare_at_price: number }>(
      'SELECT base_price, base_compare_at_price FROM items WHERE id = $1',
      [tee.itemId],
    );
    expect(rows[0]).toEqual({ base_price: 27, base_compare_at_price: 35 });
    await settle();
    // The default compare-at mode (from the base) applies: 35 → 34.99.
    expect(shopVariant(ruled, tee)).toMatchObject({ price: 26.99, compareAtPrice: 34.99 });
    expect(shopVariant(ruled, cap).price).toBe(11.99);
    // The own store's rule is off: untouched.
    expect(shopVariant(own, tee).price).toBe(99000);
  });

  it('refuses a compare-at price that isn’t above the price', async () => {
    const tee = await item('TEE', 24.99, [24.99, 99000]);
    await expect(
      createSchedule(h.db, {
        kind: 'base_change',
        name: 'Bad',
        startsAt: minutes(10),
        changes: [{ itemId: tee.itemId, basePrice: 20, baseCompareAtPrice: 20 }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('housekeeping', () => {
  it('finishes a run whose last open store was deleted', async () => {
    const tee = await item('TEE', 24.99, [20, 99000]);
    const id = await createSchedule(h.db, sale([tee.itemId], { storeIds: [ruled.id] }));
    await runSchedule(deps(), id);
    const { rows } = await h.db.query<{ id: number }>('SELECT id FROM price_runs');
    await h.db.query(`UPDATE price_runs SET created_at = now() - interval '10 minutes'`);
    await h.db.query('DELETE FROM stores WHERE id = $1', [ruled.id]);
    const ctx = { db: h.db, logger: silentLogger, now: Date.now() };
    for (const [, run] of PRICING_HOUSEKEEPING) await run(ctx);
    const after = await h.db.query<{ status: string }>(
      'SELECT status FROM price_runs WHERE id = $1',
      [rows[0]!.id],
    );
    expect(after.rows[0]!.status).toBe('done');
  });
});
