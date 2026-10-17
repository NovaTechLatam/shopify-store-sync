/** Background tasks of the purchasing and reorder feature. */
export type PurchasingTaskPayloads = {
  /** Re-evaluate the reorder alerts of every item. A singleton (empty payload). */
  reorder_check: Record<string, never>;
  /**
   * Copy item costs to a store's inventory items ("Cost per item"). The list has no natural
   * de-duplication key: enqueue it with `dedupeKey: push_item_costs:<storeId>:<receiptId>`.
   */
  push_item_costs: { storeId: number; itemIds: number[] };
};
