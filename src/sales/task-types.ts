/** Background tasks of the sales history (reports) feature. */
export type SalesTaskPayloads = {
  /** Re-read one order (orders/create|updated|cancelled and refunds/create webhooks). */
  refresh_order: { storeId: number; orderId: string /* gid://shopify/Order/1 */ };
  /** An order was deleted in Shopify (orders/delete webhook). */
  remove_order: { storeId: number; orderId: string };
  /** Incremental sync: orders updated since `stores.orders_synced_at`. */
  sync_orders: { storeId: number };
  /** First import of a store's order history (bulk operation), step by step. */
  sales_backfill: { storeId: number };
};
