-- Sales history (reports): the incremental sync's schedule and problems, the backfill's progress,
-- markers for orders deleted in Shopify, and an index for filling in missing unit costs.

ALTER TABLE stores
  -- When the incremental order sync last finished; the 15-minute schedule is due from it.
  -- (orders_synced_at is Shopify's updated_at of the newest order seen, which stays put while
  -- no order changes, so it can't tell when we last looked.)
  ADD COLUMN orders_checked_at          timestamptz,
  -- Why the last incremental sync stopped (a missing permission...); NULL when it worked.
  ADD COLUMN orders_sync_error          text,
  -- Start of the history the last backfill asked for: reports cover sales from here on.
  ADD COLUMN sales_history_from         timestamptz,
  -- The backfill asked for less than salesHistoryDays: Shopify only gives 60 days of orders
  -- without the read_all_orders scope.
  ADD COLUMN sales_history_capped       boolean NOT NULL DEFAULT false,
  ADD COLUMN sales_backfill_finished_at timestamptz,
  -- Progress of a running export: objects (orders and their lines) Shopify has written so far.
  ADD COLUMN sales_backfill_objects     bigint;

-- An order deleted in Shopify keeps its row (without lines) as a marker, so a copy read before
-- the deletion and written after it (webhooks arrive out of order) can't bring it back. Report
-- queries never see it: it has no lines.
ALTER TABLE sales_orders ADD COLUMN deleted_at timestamptz;

-- Lines first seen while their item had no cost: filled in once it has one (housekeeping).
CREATE INDEX sales_lines_no_cost ON sales_lines (item_id) WHERE unit_cost IS NULL AND item_id IS NOT NULL;
