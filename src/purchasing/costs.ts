import { setAlert } from '../alerts/alerts.js';
import { ShopifyApiError } from '../shopify/client.js';
import type { TaskDeps } from '../tasks/types.js';
import { getSettings } from '../settings.js';
import { roundMoney, toMoneyString } from '../util/money.js';

export type CostMethod = 'average' | 'last';

/**
 * An item's unit cost (base currency) after a delivery of `quantity` units at `unitCost` each.
 *
 * - 'last': the delivery's price.
 * - 'average': the weighted average of the stock already there (at the old cost) and the delivery:
 *   (stock × old + quantity × new) ÷ (stock + quantity). Oversold stock (below 0) counts as 0, and
 *   an item without a cost yet takes the delivery's.
 *
 * Kept to 4 decimals, like the column.
 */
export function nextItemCost(input: {
  method: CostMethod;
  oldCost: number | null;
  stockBefore: number;
  quantity: number;
  unitCost: number;
}): number {
  const { method, oldCost, quantity, unitCost } = input;
  if (method === 'last' || oldCost === null || quantity <= 0) return roundMoney(unitCost, 4);
  const stock = Math.max(0, input.stockBefore);
  return roundMoney((stock * oldCost + quantity * unitCost) / (stock + quantity), 4);
}

/** A purchase order's unit cost (its currency) in the base currency. */
export function toBaseCost(unitCost: number, exchangeRate: number): number {
  return roundMoney(unitCost / exchangeRate, 4);
}

/**
 * The `push_item_costs` task: writes the items' costs (base currency × the store's exchange rate)
 * to the store's "Cost per item" (inventoryItemUpdate, which needs write_inventory: a scope every
 * connected store has). Absolute values, so a retry is harmless. Items the store doesn't sell, or
 * without a cost, are skipped. A cost Shopify refuses is logged and the others go on; a network
 * problem retries the task; a permission problem raises an alert and stops (no endless retries).
 */
export async function pushItemCosts(
  deps: TaskDeps,
  storeId: number,
  itemIds: number[],
): Promise<{ updated: number; failed: number; skipped: number }> {
  const { db, logger } = deps;
  if (itemIds.length === 0) return { updated: 0, failed: 0, skipped: 0 };
  const settings = await getSettings(db);
  const { rows: stores } = await db.query<{
    name: string;
    currency_code: string | null;
    exchange_rate: number;
  }>('SELECT name, currency_code, exchange_rate FROM stores WHERE id = $1', [storeId]);
  const store = stores[0];
  if (!store) return { updated: 0, failed: 0, skipped: itemIds.length };
  const currency = store.currency_code ?? settings.baseCurrency;
  const { rows } = await db.query<{
    item_id: number;
    sku: string;
    cost: number | null;
    inventory_item_id: string | null;
  }>(
    `SELECT i.id AS item_id, i.sku, i.cost, v.inventory_item_id
       FROM items i
       LEFT JOIN variants v ON v.item_id = i.id AND v.store_id = $2 AND v.deleted_at IS NULL
                           AND NOT v.is_bundle
      WHERE i.id = ANY($1::bigint[])
      ORDER BY i.id`,
    [itemIds, storeId],
  );
  const admin = await deps.shopify.forStore(storeId);
  let updated = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.cost === null || row.inventory_item_id === null) {
      skipped++;
      continue;
    }
    const cost = toMoneyString(row.cost * store.exchange_rate, currency);
    try {
      await admin.updateInventoryItemCost(row.inventory_item_id, cost);
      updated++;
    } catch (err) {
      if (err instanceof ShopifyApiError && err.kind === 'auth') {
        await setAlert(db, {
          open: true,
          kind: 'cost_push_failed',
          dedupeKey: `cost_push_failed:${storeId}`,
          storeId,
          message:
            `${store.name}: costs couldn’t be copied to Shopify because the app isn’t allowed to ` +
            'change inventory items there. Check the store’s connection on its page in Store Sync.',
        });
        logger.warn({ storeId, err }, 'cost push refused: missing permission');
        return { updated, failed: failed + 1, skipped };
      }
      if (err instanceof ShopifyApiError && err.kind === 'store_unavailable') {
        // The shop is closed or frozen: stock syncing reports the store; don't retry forever.
        logger.warn({ storeId, err }, 'cost push stopped: store unavailable');
        return { updated, failed: failed + 1, skipped };
      }
      if (err instanceof ShopifyApiError && err.kind === 'invalid') {
        failed++;
        logger.warn({ storeId, sku: row.sku, err }, 'shopify refused an item cost');
        continue;
      }
      throw err; // transient: the task retries (values are absolute, so repeats are harmless)
    }
  }
  await setAlert(db, {
    open: false,
    kind: 'cost_push_failed',
    dedupeKey: `cost_push_failed:${storeId}`,
    message: '',
  });
  logger.info({ storeId, updated, failed, skipped }, 'item costs copied to shopify');
  return { updated, failed, skipped };
}
