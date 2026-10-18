-- Prices: what "update prices in stores" runs record beyond 002, and indexes for the checks the
-- prices feature makes often.

ALTER TABLE price_run_stores
  -- Variants in scope left as they are on purpose: no base price yet, or a price the merchant
  -- changed in Shopify during a sale (not put back when the sale ended).
  ADD COLUMN variants_skipped integer NOT NULL DEFAULT 0,
  -- Prices to put back where Store Sync has no price of its own for the item (the store's rule is
  -- off, or the item has no base price): what the store charged before a sale, written when the
  -- sale ends, and only if the store still charges the sale price.
  -- [{"itemId": 1, "price": 19.9, "compareAtPrice": null, "salePrice": 15.9}]
  ADD COLUMN restore_prices jsonb NOT NULL DEFAULT '[]';

-- "Is a price update already queued or running for this store?" (asked before every new run).
CREATE INDEX price_run_stores_open ON price_run_stores (store_id) WHERE status IN ('queued', 'running');

-- The fixed prices a sale wrote (restored when it ends).
CREATE INDEX price_overrides_schedule ON price_overrides (schedule_id) WHERE schedule_id IS NOT NULL;
