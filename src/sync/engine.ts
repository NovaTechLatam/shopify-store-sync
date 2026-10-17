import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Db, DbClient, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { ShopifyApiError } from '../shopify/client.js';
import type { ShopifyAdmin } from '../shopify/types.js';
import { evaluateStockAlerts, setAlert } from '../alerts/alerts.js';
import { getSettings, updateSettings } from '../settings.js';
import type { ClaimedLevel } from './queue.js';
import { checkLease } from './queue.js';

/**
 * THE SYNC ALGORITHM
 *
 * For every (item, warehouse) "pool level" we keep:
 *   Q            the shared available quantity (pool_levels.quantity), and
 *   baseline[s]  for every store s, the last available value we KNOW store s had
 *                (store_levels.baseline): either we read it, or our compare-and-set write of it
 *                was confirmed by Shopify.
 *
 * Reconciling a pool level (one worker at a time, enforced by the queue lease):
 *   1. Resolve writes whose outcome is unknown (crash / timeout) by replaying them with the same
 *      idempotency key: Shopify answers "applied" or "not applied" without applying twice.
 *   2. Read every store's live value L[s].
 *   3. Every difference L[s] - baseline[s] is a real change made in store s (an order, a refund,
 *      a staff edit...). Our own writes never show up as differences because a confirmed write
 *      moves the baseline with it. So:  Q' = Q + Σ (L[s] - baseline[s])  (+ manual adjustments).
 *   4. Persist Q', baseline[s] = L[s] and a write-ahead record of each write we are about to send.
 *   5. Write target[s] = max(0, Q' - safetyBuffer[s]) to every store whose L[s] differs, using
 *      compare-and-set (changeFromQuantity = L[s]). If the store changed after our read, Shopify
 *      rejects the write (stale) and we simply reconcile again; nothing is overwritten blindly.
 *   6. Confirmed writes set baseline[s] = target[s].
 *
 * Invariant: every unit change made in any store is counted exactly once in Q:
 *   - a change is counted when it first appears as L[s] - baseline[s], after which baseline[s]
 *     includes it, so it is never counted again;
 *   - a write only lands if the store still had baseline[s] (compare-and-set), so it never erases
 *     an uncounted change;
 *   - a write whose outcome is unknown freezes that store's baseline until the replay tells us
 *     which value is right.
 * Duplicate, late or out-of-order webhooks are harmless: they only trigger step 2's fresh read.
 *
 * Membership. A baseline only means something while the store kept syncing the item. Whenever a
 * store's variant or location stops or starts syncing it (relinked, untracked, unmapped...),
 * database triggers bump `membership_changed_at`; a baseline written before that is ignored, so
 * the store "joins": its current value is not counted and it is overwritten with the shared
 * quantity. Every transaction that saves baselines first re-checks (and row-locks) the members
 * it was computed for, so a relink racing with a reconcile can't slip a stale baseline in.
 */

export interface ShopifyRegistry {
  forStore(storeId: number): Promise<ShopifyAdmin>;
}

export type ReconcileOutcome =
  | { status: 'done' }
  /** `delayMs` omitted = retry with exponential backoff. */
  | { status: 'retry'; delayMs?: number; reason: string }
  | { status: 'skipped'; reason: string };

/** Shopify forgets idempotency keys after 24h; past this age a replay proves nothing. */
export const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;
/**
 * Shopify may keep answering "in progress" for a stalled write. After this many replays we stop
 * waiting and settle it by looking at the store, so the store isn't frozen for a whole day.
 */
const MAX_IN_PROGRESS_REPLAYS = 6;
/**
 * A stock count describes the shelf when it was entered. If it can't be applied within this time
 * (a store can't be read), shipments since may have changed the shelf: it is cancelled instead.
 */
const COUNT_MAX_DELAY_MS = 10 * 60_000;

interface PendingWrite {
  storeId: number;
  inventoryItemId: string;
  locationId: string;
  idempotencyKey: string;
  changeFrom: number;
  target: number;
  attempts: number;
  createdAt: Date;
}

interface Member {
  storeId: number;
  storeName: string;
  buffer: number;
  inventoryItemId: string;
  locationId: string;
  baseline: number | null;
}

/** A store that sells the item from this warehouse, whatever its sync status. */
interface Seller {
  storeId: number;
  storeName: string;
  status: string;
  catalogPending: boolean;
  inventoryItemId: string;
  locationId: string;
}

interface Adjustment {
  id: number;
  kind: 'initialize' | 'set' | 'adjust' | 'count';
  strategy: 'store' | 'min' | 'max' | 'sum' | 'value' | null;
  sourceStoreId: number | null;
  storeIds: number[] | null;
  value: number | null;
  note: string | null;
  /** Logged instead of the default event kind (a feature's own, e.g. 'po_received'). */
  eventKind: string | null;
  /** With `eventKind`: the event's details. */
  details: unknown;
  createdAt: Date;
}

interface LevelContext {
  poolLevelId: number;
  itemId: number;
  warehouseId: number;
  sku: string;
  quantity: number | null;
  syncEnabled: boolean;
  lowStockThreshold: number | null;
  members: Member[];
  /** Fingerprint of the members (rows and their membership timestamps) when loaded. */
  membership: string;
  sellers: Seller[];
  pending: PendingWrite[];
  adjustments: Adjustment[];
}

interface Problem {
  storeId: number;
  message: string;
  /** Credentials rejected / shop unavailable: the whole store needs attention. */
  storeLevel: boolean;
}

interface EventRow {
  kind: string;
  storeId?: number | null;
  delta?: number | null;
  before?: number | null;
  after?: number | null;
  message?: string;
  details?: unknown;
}

type Resolution =
  | { kind: 'applied' | 'not_applied'; note?: string }
  | { kind: 'unknown'; message: string; storeLevel: boolean };

type LiveRead =
  | { kind: 'ok'; value: number; activated: boolean; offShelf?: number }
  | { kind: 'not_stocked' }
  | { kind: 'error'; message: string; storeLevel: boolean };

class MembershipChanged extends Error {}

export interface SyncEngineOptions {
  db: Db;
  shopify: ShopifyRegistry;
  logger: Logger;
  /** Stock the item at the mapped location when a store doesn't have it there yet. */
  autoActivate?: boolean;
  now?: () => number;
}

/** What a store shows for a shared quantity: the safety buffer is held back, never below 0. */
export function displayQuantity(shared: number, buffer: number): number {
  return Math.max(0, shared - buffer);
}

// Stores selling an item ($1) from a warehouse ($2): a tracked, non-bundle variant and an active
// location mapped to the warehouse. Members are the sellers that take part in syncing: active,
// with an up-to-date catalog.
const SELLERS_FROM = `
  FROM stores s
  JOIN variants v ON v.store_id = s.id AND v.item_id = $1 AND v.deleted_at IS NULL
                 AND v.tracked AND NOT v.is_bundle
  JOIN store_locations sl ON sl.store_id = s.id AND sl.warehouse_id = $2 AND sl.is_active`;
const MEMBERS_WHERE = `s.status = 'active' AND NOT s.catalog_pending`;

export class SyncEngine {
  private readonly db: Db;
  private readonly shopify: ShopifyRegistry;
  private readonly logger: Logger;
  private readonly autoActivate: boolean;
  private readonly now: () => number;

  constructor(opts: SyncEngineOptions) {
    this.db = opts.db;
    this.shopify = opts.shopify;
    this.logger = opts.logger;
    this.autoActivate = opts.autoActivate ?? true;
    this.now = opts.now ?? Date.now;
  }

  async reconcile(claim: ClaimedLevel): Promise<ReconcileOutcome> {
    const ctx = await this.load(claim.poolLevelId);
    if (!ctx) return { status: 'skipped', reason: 'pool level no longer exists' };
    const log = this.logger.child({ poolLevelId: ctx.poolLevelId, sku: ctx.sku });
    // Every write to our state happens in a transaction that re-checks the members (and holds
    // their rows) before re-checking the lease: same lock order as the catalog code.
    const lease = <T>(fn: (client: DbClient) => Promise<T>) =>
      withTransaction(this.db, async (client) => {
        const now = await membershipOf(client, ctx.itemId, ctx.warehouseId, true);
        if (now !== ctx.membership) throw new MembershipChanged();
        await checkLease(client, claim.poolLevelId, claim.leaseToken);
        return fn(client);
      });
    const problems: Problem[] = [];
    try {
      return await this.run(ctx, lease, problems, log);
    } catch (err) {
      if (!(err instanceof MembershipChanged)) throw err;
      // A relink or mapping change raced with us; whatever we computed is for the old members.
      return { status: 'retry', delayMs: 0, reason: 'the stores selling this item changed' };
    } finally {
      await this.flagStoreProblems(problems);
    }
  }

  private async run(
    ctx: LevelContext,
    lease: <T>(fn: (client: DbClient) => Promise<T>) => Promise<T>,
    problems: Problem[],
    log: Logger,
  ): Promise<ReconcileOutcome> {
    const frozen = new Set<number>(); // stores we can't trust or touch in this run
    const memberOf = (storeId: number) => ctx.members.find((m) => m.storeId === storeId);

    // ---- 1. resolve writes with an unknown outcome ------------------------------------------
    if (ctx.pending.length) {
      const resolutions = await Promise.all(ctx.pending.map((p) => this.resolvePending(p)));
      await lease(async (client) => {
        for (const [i, p] of ctx.pending.entries()) {
          const r = resolutions[i]!;
          const member = memberOf(p.storeId);
          // A write to an inventory level the store no longer syncs only needs settling; it says
          // nothing about the current member's baseline.
          const current =
            member &&
            member.inventoryItemId === p.inventoryItemId &&
            member.locationId === p.locationId;
          if (r.kind === 'unknown') {
            // Hands off this store until the write is settled (one write-ahead record per store).
            frozen.add(p.storeId);
            problems.push({ storeId: p.storeId, message: r.message, storeLevel: r.storeLevel });
            await client.query(
              `UPDATE pending_writes SET attempts = attempts + 1, last_error = $3
                WHERE pool_level_id = $1 AND store_id = $2`,
              [ctx.poolLevelId, p.storeId, r.message],
            );
            continue;
          }
          await client.query(
            'DELETE FROM pending_writes WHERE pool_level_id = $1 AND store_id = $2',
            [ctx.poolLevelId, p.storeId],
          );
          if (current) {
            member.baseline = r.kind === 'applied' ? p.target : p.changeFrom;
            await upsertBaseline(client, ctx.poolLevelId, member, member.baseline);
          }
          if (r.note) {
            await insertEvents(client, ctx, [
              {
                kind: 'write_recovered',
                storeId: p.storeId,
                message: r.note,
                details: { changeFrom: p.changeFrom, target: p.target, outcome: r.kind },
              },
            ]);
          }
        }
      });
    }

    if (!ctx.syncEnabled) return { status: 'skipped', reason: 'sync disabled for this item' };
    if (ctx.members.length === 0) return { status: 'skipped', reason: 'no store sells this item' };

    const init =
      ctx.quantity === null ? ctx.adjustments.find((a) => a.kind === 'initialize') : undefined;
    if (ctx.quantity === null && !init) {
      // Nothing to do until the merchant starts this item. Don't touch Shopify at all: even
      // stocking the item at a location could put an old, inactive quantity on sale.
      return { status: 'skipped', reason: 'item not initialised yet' };
    }
    const countPending = ctx.adjustments.some((a) => a.kind === 'count');

    // ---- 2. read live values ------------------------------------------------------------------
    const active = ctx.members.filter((m) => !frozen.has(m.storeId));
    const reads = await Promise.all(active.map((m) => this.readLive(m, countPending)));
    const live = new Map<number, number>();
    const offShelf = new Map<number, number>(); // for stock counts: committed + unavailable
    const activated = new Set<number>();
    const forget: Member[] = []; // baselines that no longer mean anything
    for (const [i, m] of active.entries()) {
      const r = reads[i]!;
      if (r.kind === 'error') {
        frozen.add(m.storeId);
        problems.push({ storeId: m.storeId, message: r.message, storeLevel: r.storeLevel });
      } else if (r.kind === 'not_stocked') {
        frozen.add(m.storeId);
        problems.push({
          storeId: m.storeId,
          message: `SKU ${ctx.sku} is not stocked at the synced location of ${m.storeName}`,
          storeLevel: false,
        });
        if (m.baseline !== null) forget.push(m);
      } else {
        // Re-stocked after being disconnected: whatever it shows now is not a sale or restock.
        if (r.activated) {
          activated.add(m.storeId);
          if (m.baseline !== null) forget.push(m);
        }
        live.set(m.storeId, r.value);
        if (r.offShelf !== undefined) offShelf.set(m.storeId, r.offShelf);
      }
    }
    for (const m of forget) m.baseline = null;
    const participants = active.filter((m) => live.has(m.storeId));
    const unstocked = forget.filter((m) => !live.has(m.storeId));

    // ---- 3. compute the new shared quantity ---------------------------------------------------
    const events: EventRow[] = [];
    const applied: number[] = [];
    let quantity = ctx.quantity;

    if (init) {
      const started = this.initialize(ctx, init, participants, live, activated);
      if (started.kind === 'wait') {
        if (unstocked.length) await lease((c) => clearBaselines(c, ctx.poolLevelId, unstocked));
        return { status: 'retry', reason: started.reason };
      }
      if (started.kind === 'failed') {
        const reason = started.reason;
        await lease(async (client) => {
          await client.query('UPDATE pool_adjustments SET applied_at = now() WHERE id = $1', [
            init.id,
          ]);
          await insertEvents(client, ctx, [{ kind: 'initialize_failed', message: reason }]);
        });
        return { status: 'skipped', reason };
      }
      const { counted } = started;
      quantity = started.quantity;
      // The stores counted in the starting number have nothing to add; any other store joins.
      for (const m of participants) {
        m.baseline = counted.has(m.storeId) ? live.get(m.storeId)! : null;
      }
      applied.push(init.id);
      events.push({
        kind: 'initialized',
        after: quantity,
        message: `Started syncing at ${quantity} (${describeStrategy(init, ctx)})`,
        details: {
          strategy: init.strategy,
          sourceStoreId: init.sourceStoreId,
          live: Object.fromEntries(participants.map((m) => [m.storeId, live.get(m.storeId)])),
        },
      });
    }

    let next = quantity!;
    for (const m of participants) {
      const value = live.get(m.storeId)!;
      if (m.baseline === null) {
        events.push({
          kind: 'store_joined',
          storeId: m.storeId,
          message: `${m.storeName} started syncing this item (it showed ${value})`,
          details: { live: value },
        });
        continue;
      }
      const delta = value - m.baseline;
      if (delta === 0) continue;
      events.push({
        kind: 'external_change',
        storeId: m.storeId,
        delta,
        before: next,
        after: next + delta,
        message: `${m.storeName}: ${m.baseline} → ${value}`,
        details: { from: m.baseline, to: value },
      });
      next += delta;
    }

    // Manual adjustments, strictly in the order they were entered. A stock count needs every
    // store's open orders and set-aside units read right now; if it can't have them, it and
    // everything after it wait for the next run.
    const outside = countPending
      ? await this.offShelfEverywhere(ctx, participants, offShelf, problems)
      : null;
    let cancelledCount = false;
    for (const adj of ctx.adjustments) {
      if (applied.includes(adj.id)) continue;
      if (adj.kind === 'initialize') {
        applied.push(adj.id); // already initialised
        continue;
      }
      if (adj.kind === 'count' && !outside) {
        if (this.now() - adj.createdAt.getTime() <= COUNT_MAX_DELAY_MS) break;
        applied.push(adj.id);
        events.push({
          kind: 'stock_count_cancelled',
          message:
            `The stock count of ${adj.value} entered ${adj.createdAt.toISOString()} was cancelled: ` +
            'not every store could be read in time. Count again and re-enter it.',
        });
        cancelledCount = true;
        continue;
      }
      applied.push(adj.id);
      let after: number;
      let message: string;
      let details: unknown;
      if (adj.kind === 'count') {
        const held = [...outside!.values()].reduce((a, b) => a + b, 0);
        after = adj.value! - held;
        message =
          adj.note ??
          `Counted ${adj.value} in the warehouse; ${held} are sold and waiting to ship or set ` +
            `aside, so ${after} can be sold`;
        details = { counted: adj.value, heldByStore: Object.fromEntries(outside!) };
      } else {
        after = adj.kind === 'set' ? adj.value! : next + adj.value!;
        message =
          adj.note ??
          (adj.kind === 'set' ? `Set to ${adj.value}` : `Adjusted by ${signed(adj.value!)}`);
      }
      // Adjustments made by a feature (a delivery received...) say what they were.
      events.push({
        kind:
          adj.eventKind ??
          { set: 'manual_set', adjust: 'manual_adjust', count: 'stock_count' }[adj.kind],
        delta: after - next,
        before: next,
        after,
        message,
        details: adj.eventKind ? (adj.details ?? details) : details,
      });
      next = after;
    }
    if (ctx.quantity !== null && next !== ctx.quantity)
      log.info({ from: ctx.quantity, to: next }, 'shared quantity changed');

    // ---- circuit breaker: many items wiped out at once is more likely a bad import than sales.
    // Nothing has been persisted yet, so holding here loses nothing: if the merchant fixes the
    // store, the difference is gone when sync resumes; if the change was real, it is counted then.
    const wipedOut =
      ctx.quantity !== null &&
      ctx.quantity > 0 &&
      next <= 0 &&
      events.some((e) => e.kind === 'external_change');
    if (wipedOut && (await this.breakerTripped(ctx))) {
      return { status: 'retry', delayMs: 60_000, reason: 'circuit breaker tripped: sync paused' };
    }

    // ---- 4. plan the writes and persist everything we know before touching Shopify -----------
    const writes = participants
      .map((m) => ({
        member: m,
        from: live.get(m.storeId)!,
        to: displayQuantity(next, m.buffer),
        key: randomUUID(),
      }))
      // A store below zero ("continue selling when out of stock") already shows nothing for sale;
      // raising it to 0 would only invent stock in that store's books.
      .filter((w) => w.from !== w.to && !(w.to === 0 && w.from < 0));
    const duplicates = await this.findDuplicateRestocks(ctx, events);

    await lease(async (client) => {
      if (next !== ctx.quantity) {
        await client.query(
          'UPDATE pool_levels SET quantity = $2, version = version + 1, updated_at = now() WHERE id = $1',
          [ctx.poolLevelId, next],
        );
      }
      for (const m of participants)
        await upsertBaseline(client, ctx.poolLevelId, m, live.get(m.storeId)!);
      await clearBaselines(client, ctx.poolLevelId, unstocked);
      for (const w of writes) {
        await client.query(
          `INSERT INTO pending_writes
             (pool_level_id, store_id, inventory_item_id, location_id, idempotency_key, change_from, target)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            ctx.poolLevelId,
            w.member.storeId,
            w.member.inventoryItemId,
            w.member.locationId,
            w.key,
            w.from,
            w.to,
          ],
        );
      }
      for (const d of duplicates) {
        await setAlert(client, {
          open: true,
          kind: 'possible_double_count',
          dedupeKey: `possible_double_count:${ctx.poolLevelId}`,
          renotify: true,
          itemId: ctx.itemId,
          storeId: d.storeId,
          message:
            `${d.storeNames.join(' and ')} each added ${d.delta} units of ${ctx.sku} within 10 minutes. ` +
            `If this was the same delivery entered in each store, the shared stock now counts it twice: ` +
            `remove ${d.delta} units from the product page. Tip: enter deliveries in one store (or here) only.`,
          details: { delta: d.delta, storeIds: d.storeIds },
        });
      }
      if (cancelledCount) {
        await setAlert(client, {
          open: true,
          kind: 'stock_count_cancelled',
          dedupeKey: `stock_count_cancelled:${ctx.poolLevelId}`,
          renotify: true,
          itemId: ctx.itemId,
          message: `A stock count of ${ctx.sku} could not be applied because a store was unreachable. Enter it again.`,
        });
      }
      if (applied.length) {
        await client.query(
          'UPDATE pool_adjustments SET applied_at = now() WHERE id = ANY($1::bigint[])',
          [applied],
        );
      }
      await insertEvents(client, ctx, events);
      await evaluateStockAlerts(client, {
        poolLevelId: ctx.poolLevelId,
        itemId: ctx.itemId,
        sku: ctx.sku,
        quantity: next,
        threshold: ctx.lowStockThreshold,
      });
    });

    // ---- 5. send the writes (compare-and-set, idempotent) -------------------------------------
    const results = await Promise.all(
      writes.map(async (w) => {
        try {
          const shop = await this.shopify.forStore(w.member.storeId);
          const result = await shop.setAvailable({
            inventoryItemId: w.member.inventoryItemId,
            locationId: w.member.locationId,
            changeFrom: w.from,
            quantity: w.to,
            idempotencyKey: w.key,
          });
          return { w, result, error: null };
        } catch (err) {
          return { w, result: null, error: describeError(err) };
        }
      }),
    );

    // ---- 6. record the outcomes ---------------------------------------------------------------
    let stale = false;
    const pushed: { storeId: number; from: number; to: number; status: string }[] = [];
    await lease(async (client) => {
      for (const { w, result, error } of results) {
        const storeId = w.member.storeId;
        if (!result) {
          // Unknown outcome: keep the write-ahead record; the next run replays it.
          problems.push({ storeId, message: error!.message, storeLevel: error!.storeLevel });
          await client.query(
            `UPDATE pending_writes SET attempts = attempts + 1, last_error = $3
              WHERE pool_level_id = $1 AND store_id = $2`,
            [ctx.poolLevelId, storeId, error!.message],
          );
          pushed.push({ storeId, from: w.from, to: w.to, status: 'unknown' });
          continue;
        }
        pushed.push({ storeId, from: w.from, to: w.to, status: result.status });
        if (result.status === 'in_progress') {
          problems.push({
            storeId,
            message: 'write still in progress at Shopify',
            storeLevel: false,
          });
          continue; // replay later
        }
        await client.query(
          'DELETE FROM pending_writes WHERE pool_level_id = $1 AND store_id = $2',
          [ctx.poolLevelId, storeId],
        );
        switch (result.status) {
          case 'applied':
            await upsertBaseline(client, ctx.poolLevelId, w.member, w.to);
            await setAlert(client, {
              open: false,
              kind: 'write_rejected',
              dedupeKey: `write_rejected:${ctx.poolLevelId}:${storeId}`,
              message: '',
            });
            break;
          case 'stale':
          case 'not_applied':
            stale = true; // the store moved after we read it: count that change on the next run
            break;
          case 'not_stocked':
            stale = true;
            await upsertBaseline(client, ctx.poolLevelId, w.member, null);
            break;
          case 'rejected':
            problems.push({
              storeId,
              message: `Shopify rejected the update: ${result.message}`,
              storeLevel: false,
            });
            await setAlert(client, {
              open: true,
              kind: 'write_rejected',
              dedupeKey: `write_rejected:${ctx.poolLevelId}:${storeId}`,
              itemId: ctx.itemId,
              storeId,
              message: `${w.member.storeName} refused the stock update for ${ctx.sku}: ${result.message}`,
            });
            break;
        }
      }
      if (pushed.length) {
        const ok = pushed.filter((p) => p.status === 'applied').length;
        await insertEvents(client, ctx, [
          {
            kind: 'propagated',
            after: next,
            message: `Shared stock ${next}: updated ${ok} of ${pushed.length} store${pushed.length === 1 ? '' : 's'}`,
            details: { stores: pushed },
          },
        ]);
      }
    });

    if (stale)
      return { status: 'retry', delayMs: 0, reason: 'a store changed while we were writing' };
    if (problems.length) {
      log.warn({ problems }, 'reconcile incomplete');
      return { status: 'retry', reason: describeProblems(problems) };
    }
    return { status: 'done' };
  }

  /**
   * Works out the starting quantity of an item, or why it must wait. Every store whose stock should
   * be part of the starting number must be readable right now: the stores the merchant saw in the
   * onboarding preview, or (for items that start automatically) every store that sells the item and
   * isn't paused. A store whose level we just stocked counts as 0, as the preview showed.
   */
  private initialize(
    ctx: LevelContext,
    init: Adjustment,
    participants: Member[],
    live: Map<number, number>,
    activated: Set<number>,
  ):
    | { kind: 'ok'; quantity: number; counted: Set<number> }
    | { kind: 'wait'; reason: string }
    | { kind: 'failed'; reason: string } {
    const sellers = new Map(ctx.sellers.map((s) => [s.storeId, s]));
    const required = init.storeIds
      ? init.storeIds.filter((id) => sellers.has(id))
      : ctx.sellers
          .filter((s) => s.status === 'active' || s.status === 'error')
          .map((s) => s.storeId);
    if (init.strategy === 'store') {
      if (!init.sourceStoreId || !sellers.has(init.sourceStoreId)) {
        return { kind: 'failed', reason: 'The chosen source store does not sell this item' };
      }
      if (!required.includes(init.sourceStoreId)) required.push(init.sourceStoreId);
    }
    const missing = required.filter((id) => !participants.some((m) => m.storeId === id));
    if (missing.length) {
      const names = missing.map((id) => sellers.get(id)!.storeName).join(', ');
      return { kind: 'wait', reason: `waiting for ${names} before starting this item` };
    }
    const counted = new Set(required);
    const valueOf = (storeId: number) => (activated.has(storeId) ? 0 : live.get(storeId)!);
    const values = [...counted].map(valueOf);
    let quantity: number | null;
    switch (init.strategy) {
      case 'store':
        quantity = valueOf(init.sourceStoreId!);
        break;
      case 'min':
        quantity = values.length ? Math.min(...values) : null;
        break;
      case 'max':
        quantity = values.length ? Math.max(...values) : null;
        break;
      case 'sum':
        quantity = values.reduce((a, b) => a + b, 0);
        break;
      case 'value':
        quantity = init.value;
        break;
      default:
        quantity = null;
    }
    if (quantity === null)
      return { kind: 'failed', reason: 'No store could provide a starting number' };
    return { kind: 'ok', quantity, counted };
  }

  /**
   * Units held outside "available" in every store that sells the item from this warehouse
   * (committed to open orders, or set aside as damaged/reserved/...), or null when a stock count
   * can't be applied yet because some store can't be read. Paused stores are read too: their
   * open orders are still on the shelf.
   */
  private async offShelfEverywhere(
    ctx: LevelContext,
    participants: Member[],
    known: Map<number, number>,
    problems: Problem[],
  ): Promise<Map<number, number> | null> {
    const held = new Map<number, number>();
    for (const seller of ctx.sellers) {
      if (participants.some((m) => m.storeId === seller.storeId)) {
        const value = known.get(seller.storeId);
        if (value === undefined) return null;
        held.set(seller.storeId, value);
        continue;
      }
      if (seller.status !== 'paused' || seller.catalogPending) {
        problems.push({
          storeId: seller.storeId,
          message: `stock count waits until ${seller.storeName} can be read`,
          storeLevel: false,
        });
        return null;
      }
      try {
        const shop = await this.shopify.forStore(seller.storeId);
        const level = (await shop.readLevels(seller.locationId, [seller.inventoryItemId])).get(
          seller.inventoryItemId,
        );
        held.set(seller.storeId, level ? level.committed + level.unavailable : 0);
      } catch (err) {
        problems.push({ storeId: seller.storeId, ...describeError(err), storeLevel: false });
        return null;
      }
    }
    return held;
  }

  /** Replays a write with an unknown outcome to learn whether it landed. */
  private async resolvePending(p: PendingWrite): Promise<Resolution> {
    try {
      const shop = await this.shopify.forStore(p.storeId);
      if (this.now() - p.createdAt.getTime() > IDEMPOTENCY_WINDOW_MS) {
        return this.settleByLooking(shop, p, 'was unresolved for over 24 hours');
      }
      const result = await shop.setAvailable({
        inventoryItemId: p.inventoryItemId,
        locationId: p.locationId,
        changeFrom: p.changeFrom,
        quantity: p.target,
        idempotencyKey: p.idempotencyKey,
      });
      switch (result.status) {
        case 'applied':
          return { kind: 'applied' };
        case 'in_progress':
          if (p.attempts >= MAX_IN_PROGRESS_REPLAYS) {
            return this.settleByLooking(shop, p, 'stayed "in progress" at Shopify');
          }
          return {
            kind: 'unknown',
            message: 'previous write still in progress at Shopify',
            storeLevel: false,
          };
        case 'rejected':
          return {
            kind: 'not_applied',
            note: `Write ${p.changeFrom} → ${p.target} was rejected: ${result.message}`,
          };
        default:
          return { kind: 'not_applied' };
      }
    } catch (err) {
      const e = describeError(err);
      return { kind: 'unknown', message: e.message, storeLevel: e.storeLevel };
    }
  }

  /**
   * Settles a write that can't be replayed by looking at the store. If it shows neither the old
   * nor the new value, assume whichever outcome leaves less stock (never oversell).
   */
  private async settleByLooking(
    shop: ShopifyAdmin,
    p: PendingWrite,
    why: string,
  ): Promise<Resolution> {
    const live = (await shop.readAvailable(p.locationId, [p.inventoryItemId])).get(
      p.inventoryItemId,
    );
    const landed =
      live === p.target ? true : live === p.changeFrom ? false : p.target > p.changeFrom;
    return {
      kind: landed ? 'applied' : 'not_applied',
      note:
        `Write ${p.changeFrom} → ${p.target} ${why}; assumed ${landed ? 'applied' : 'not applied'} ` +
        `(store shows ${live ?? 'nothing'}). Check this item's count.`,
    };
  }

  /**
   * Reads a member's live value (and, for stock counts, its off-shelf units in the same request).
   * An item not stocked at the location is stocked there first: we only get here when we are
   * about to write the shared quantity to it.
   */
  private async readLive(m: Member, withLevels: boolean): Promise<LiveRead> {
    try {
      const shop = await this.shopify.forStore(m.storeId);
      const read = async (): Promise<{ value: number; offShelf?: number } | null> => {
        if (withLevels) {
          const level = (await shop.readLevels(m.locationId, [m.inventoryItemId])).get(
            m.inventoryItemId,
          );
          return level
            ? { value: level.available, offShelf: level.committed + level.unavailable }
            : null;
        }
        const value = (await shop.readAvailable(m.locationId, [m.inventoryItemId])).get(
          m.inventoryItemId,
        );
        return value === null || value === undefined ? null : { value };
      };
      const first = await read();
      if (first) return { kind: 'ok', activated: false, ...first };
      if (!this.autoActivate) return { kind: 'not_stocked' };
      await shop.activateInventory(m.inventoryItemId, m.locationId);
      const after = await read();
      if (!after) return { kind: 'not_stocked' };
      return { kind: 'ok', activated: true, ...after };
    } catch (err) {
      const e = describeError(err);
      return { kind: 'error', message: e.message, storeLevel: e.storeLevel };
    }
  }

  /**
   * Records that this pool level is about to be wiped out by store changes and returns true (after
   * pausing sync) if that makes more than `massZeroLimit` such items within 10 minutes. The hit is
   * committed before counting, so concurrent workers see each other's hits.
   */
  private async breakerTripped(ctx: LevelContext): Promise<boolean> {
    const settings = await getSettings(this.db);
    if (settings.massZeroLimit <= 0) return false;
    // Held before the merchant resumed sync: they reviewed it and said the change was real.
    if (settings.breakerResetAt) {
      const acknowledged = await this.db.query(
        `SELECT 1 FROM circuit_breaker_hits
          WHERE pool_level_id = $1 AND created_at <= $2::timestamptz
            AND created_at > $2::timestamptz - interval '1 hour'`,
        [ctx.poolLevelId, settings.breakerResetAt],
      );
      if (acknowledged.rowCount) return false;
    }
    await this.db.query('INSERT INTO circuit_breaker_hits (pool_level_id) VALUES ($1)', [
      ctx.poolLevelId,
    ]);
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(DISTINCT pool_level_id)::int AS n FROM circuit_breaker_hits
        WHERE created_at > GREATEST(now() - interval '10 minutes', COALESCE($1::timestamptz, '-infinity'))`,
      [settings.breakerResetAt],
    );
    if (rows[0]!.n <= settings.massZeroLimit) return false;
    const reason =
      `Paused automatically: more than ${settings.massZeroLimit} items went out of stock within 10 minutes ` +
      `because of changes made in the stores (latest: ${ctx.sku}). If this was a mistake (for example a bad ` +
      `CSV import), fix the quantities in that store first, then resume sync. If the changes were real, just resume.`;
    await updateSettings(this.db, { syncPaused: true, pausedReason: reason });
    await setAlert(this.db, {
      open: true,
      kind: 'circuit_breaker',
      dedupeKey: 'circuit_breaker',
      message: reason,
    });
    this.logger.error({ sku: ctx.sku }, 'circuit breaker tripped; sync paused');
    return true;
  }

  /**
   * Restocks of the same size made in different stores within 10 minutes are usually one delivery
   * typed into every store (the habit from before syncing), which counts it several times. We
   * can't know for sure, so we apply it and raise an alert with the fix.
   */
  private async findDuplicateRestocks(
    ctx: LevelContext,
    events: EventRow[],
  ): Promise<{ delta: number; storeId: number; storeIds: number[]; storeNames: string[] }[]> {
    const restocks = events.filter((e) => e.kind === 'external_change' && (e.delta ?? 0) > 0);
    if (restocks.length === 0) return [];
    const { rows } = await this.db.query<{ store_id: number; delta: number; store_name: string }>(
      `SELECT e.store_id, e.delta, s.name AS store_name FROM inventory_events e JOIN stores s ON s.id = e.store_id
        WHERE e.pool_level_id = $1 AND e.kind = 'external_change' AND e.delta > 0
          AND e.created_at > now() - interval '10 minutes'`,
      [ctx.poolLevelId],
    );
    const nameOf = (storeId: number) =>
      ctx.members.find((m) => m.storeId === storeId)?.storeName ??
      rows.find((r) => r.store_id === storeId)?.store_name ??
      `store ${storeId}`;
    const found: { delta: number; storeId: number; storeIds: number[]; storeNames: string[] }[] =
      [];
    for (const r of restocks) {
      const others = [
        ...rows
          .filter((p) => p.delta === r.delta && p.store_id !== r.storeId)
          .map((p) => p.store_id),
        ...restocks
          .filter((o) => o !== r && o.delta === r.delta && o.storeId !== r.storeId)
          .map((o) => o.storeId!),
      ];
      if (others.length === 0) continue;
      const storeIds = [...new Set([...others, r.storeId!])].sort((a, b) => a - b);
      if (found.some((f) => f.delta === r.delta)) continue;
      found.push({
        delta: r.delta!,
        storeId: r.storeId!,
        storeIds,
        storeNames: storeIds.map(nameOf),
      });
    }
    return found;
  }

  /** Credential / availability failures put the store in `error` until a health check clears it. */
  private async flagStoreProblems(problems: Problem[]): Promise<void> {
    const seen = new Set<number>();
    for (const p of problems) {
      if (!p.storeLevel || seen.has(p.storeId)) continue;
      seen.add(p.storeId);
      await this.db
        .query(
          `UPDATE stores SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1 AND status = 'active'`,
          [p.storeId, p.message],
        )
        .catch((err: unknown) => this.logger.error({ err }, 'failed to flag store problem'));
    }
  }

  private async load(poolLevelId: number): Promise<LevelContext | null> {
    const level = await this.db.query<{
      id: number;
      item_id: number;
      sku: string;
      quantity: number | null;
      sync_enabled: boolean;
      low_stock_threshold: number | null;
      warehouse_id: number;
    }>(
      `SELECT pl.id, pl.item_id, i.sku, pl.quantity, i.sync_enabled, i.low_stock_threshold, pl.warehouse_id
         FROM pool_levels pl JOIN items i ON i.id = pl.item_id
        WHERE pl.id = $1`,
      [poolLevelId],
    );
    const row = level.rows[0];
    if (!row) return null;
    // Fingerprint first: a membership change after this point is caught by the first save.
    const membership = await membershipOf(this.db, row.item_id, row.warehouse_id, false);

    const [members, sellers, pending, adjustments] = await Promise.all([
      this.db.query<{
        store_id: number;
        store_name: string;
        safety_buffer: number;
        inventory_item_id: string;
        shopify_location_id: string;
        baseline: number | null;
      }>(
        // A baseline counts only for the same inventory level, written after the store last
        // started syncing the item (see the membership triggers in the schema).
        `SELECT s.id AS store_id, s.name AS store_name, s.safety_buffer, v.inventory_item_id,
                sl.shopify_location_id,
                CASE WHEN lvl.inventory_item_id = v.inventory_item_id
                      AND lvl.location_id = sl.shopify_location_id
                      AND lvl.updated_at > GREATEST(v.membership_changed_at, sl.membership_changed_at)
                     THEN lvl.baseline END AS baseline
           ${SELLERS_FROM}
           LEFT JOIN store_levels lvl ON lvl.pool_level_id = $3 AND lvl.store_id = s.id
          WHERE ${MEMBERS_WHERE}
          ORDER BY s.id`,
        [row.item_id, row.warehouse_id, poolLevelId],
      ),
      this.db.query<{
        store_id: number;
        store_name: string;
        status: string;
        catalog_pending: boolean;
        inventory_item_id: string;
        shopify_location_id: string;
      }>(
        `SELECT s.id AS store_id, s.name AS store_name, s.status, s.catalog_pending,
                v.inventory_item_id, sl.shopify_location_id
           ${SELLERS_FROM}
          ORDER BY s.id`,
        [row.item_id, row.warehouse_id],
      ),
      this.db.query<{
        store_id: number;
        inventory_item_id: string;
        location_id: string;
        idempotency_key: string;
        change_from: number;
        target: number;
        attempts: number;
        created_at: Date;
      }>(
        `SELECT pw.store_id, pw.inventory_item_id, pw.location_id, pw.idempotency_key, pw.change_from,
                pw.target, pw.attempts, pw.created_at
           FROM pending_writes pw JOIN stores s ON s.id = pw.store_id
          WHERE pw.pool_level_id = $1 AND s.status = 'active'`,
        [poolLevelId],
      ),
      this.db.query<{
        id: number;
        kind: Adjustment['kind'];
        strategy: Adjustment['strategy'];
        source_store_id: number | null;
        store_ids: number[] | null;
        value: number | null;
        note: string | null;
        event_kind: string | null;
        details: unknown;
        created_at: Date;
      }>(
        `SELECT id, kind, strategy, source_store_id, store_ids, value, note, event_kind, details,
                created_at
           FROM pool_adjustments WHERE pool_level_id = $1 AND applied_at IS NULL ORDER BY id`,
        [poolLevelId],
      ),
    ]);

    const ctx: LevelContext = {
      poolLevelId: row.id,
      itemId: row.item_id,
      warehouseId: row.warehouse_id,
      sku: row.sku,
      quantity: row.quantity,
      syncEnabled: row.sync_enabled,
      lowStockThreshold: row.low_stock_threshold,
      members: members.rows.map((r) => ({
        storeId: r.store_id,
        storeName: r.store_name,
        buffer: r.safety_buffer,
        inventoryItemId: r.inventory_item_id,
        locationId: r.shopify_location_id,
        baseline: r.baseline,
      })),
      membership,
      sellers: sellers.rows.map((r) => ({
        storeId: r.store_id,
        storeName: r.store_name,
        status: r.status,
        catalogPending: r.catalog_pending,
        inventoryItemId: r.inventory_item_id,
        locationId: r.shopify_location_id,
      })),
      pending: pending.rows.map((r) => ({
        storeId: r.store_id,
        inventoryItemId: r.inventory_item_id,
        locationId: r.location_id,
        idempotencyKey: r.idempotency_key,
        changeFrom: r.change_from,
        target: r.target,
        attempts: r.attempts,
        createdAt: r.created_at,
      })),
      adjustments: adjustments.rows.map((a) => ({
        id: a.id,
        kind: a.kind,
        strategy: a.strategy,
        sourceStoreId: a.source_store_id,
        storeIds: a.store_ids,
        value: a.value,
        note: a.note,
        eventKind: a.event_kind,
        details: a.details,
        createdAt: a.created_at,
      })),
    };
    return ctx;
  }
}

/**
 * Fingerprint of the current members of a pool level: which variant and location rows, and when
 * they last started or stopped syncing. With `lock`, the rows are share-locked until the end of
 * the transaction, so membership can't change while we save baselines computed for it.
 */
async function membershipOf(
  db: Queryable,
  itemId: number,
  warehouseId: number,
  lock: boolean,
): Promise<string> {
  const { rows } = await db.query<{ fingerprint: string }>(
    `SELECT s.id || ':' || v.id || ':' || v.inventory_item_id || ':' || sl.id || ':' ||
            sl.shopify_location_id || ':' || v.membership_changed_at || ':' ||
            sl.membership_changed_at AS fingerprint
       ${SELLERS_FROM}
      WHERE ${MEMBERS_WHERE}
      ORDER BY s.id ${lock ? 'FOR SHARE OF v, sl' : ''}`,
    [itemId, warehouseId],
  );
  return rows.map((r) => r.fingerprint).join('|');
}

function describeStrategy(init: Adjustment, ctx: LevelContext): string {
  switch (init.strategy) {
    case 'store':
      return `copied from ${ctx.sellers.find((m) => m.storeId === init.sourceStoreId)?.storeName ?? 'source store'}`;
    case 'min':
      return 'lowest store quantity';
    case 'max':
      return 'highest store quantity';
    case 'sum':
      return 'sum of all stores';
    default:
      return 'entered manually';
  }
}

async function upsertBaseline(
  client: DbClient,
  poolLevelId: number,
  m: Member,
  baseline: number | null,
) {
  // clock_timestamp(), not now(): compared with membership_changed_at set by other transactions.
  await client.query(
    `INSERT INTO store_levels (pool_level_id, store_id, inventory_item_id, location_id, baseline, updated_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp())
     ON CONFLICT (pool_level_id, store_id) DO UPDATE
       SET inventory_item_id = EXCLUDED.inventory_item_id, location_id = EXCLUDED.location_id,
           baseline = EXCLUDED.baseline, updated_at = clock_timestamp()`,
    [poolLevelId, m.storeId, m.inventoryItemId, m.locationId, baseline],
  );
}

async function clearBaselines(client: DbClient, poolLevelId: number, members: Member[]) {
  for (const m of members) await upsertBaseline(client, poolLevelId, m, null);
}

async function insertEvents(client: DbClient, ctx: LevelContext, events: EventRow[]) {
  for (const e of events) {
    await client.query(
      `INSERT INTO inventory_events
         (pool_level_id, item_id, store_id, kind, delta, quantity_before, quantity_after, message, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ctx.poolLevelId,
        ctx.itemId,
        e.storeId ?? null,
        e.kind,
        e.delta ?? null,
        e.before ?? null,
        e.after ?? null,
        e.message ?? null,
        e.details === undefined ? null : JSON.stringify(e.details),
      ],
    );
  }
}

function describeError(err: unknown): { message: string; storeLevel: boolean } {
  if (err instanceof ShopifyApiError) {
    return {
      message: err.message,
      storeLevel: err.kind === 'auth' || err.kind === 'store_unavailable',
    };
  }
  return { message: err instanceof Error ? err.message : String(err), storeLevel: false };
}

function describeProblems(problems: Problem[]): string {
  return problems.map((p) => `store ${p.storeId}: ${p.message}`).join('; ');
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
