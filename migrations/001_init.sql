-- Shopify multi-store shared-inventory sync: initial schema.
--
-- Vocabulary
--   store       one Shopify shop (one brand).
--   warehouse   one physical stock pool shared by all stores (usually just one).
--   item        one physical product, identified by SKU, sold by several stores.
--   pool level  shared "available" quantity of one item in one warehouse (the source of truth).
--   store level per-store baseline: the last "available" value we know the store had.

CREATE TABLE stores (
  id                     bigserial PRIMARY KEY,
  name                   text NOT NULL,
  shop_domain            text NOT NULL UNIQUE,              -- my-brand.myshopify.com
  auth_mode              text NOT NULL CHECK (auth_mode IN ('access_token', 'client_credentials')),
  access_token_enc       text,                               -- auth_mode = access_token
  client_id              text,                               -- auth_mode = client_credentials
  client_secret_enc      text,                               -- client_credentials, and HMAC secret fallback
  -- Shopify keeps signing webhooks with the old secret until it is revoked, so after a rotation
  -- the previous one stays accepted for a while.
  previous_client_secret_enc text,
  client_secret_rotated_at   timestamptz,
  webhook_secret_enc     text,                               -- secret that signs this store's webhooks
  safety_buffer          integer NOT NULL DEFAULT 0 CHECK (safety_buffer >= 0),
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error', 'disconnected')),
  last_error             text,
  last_webhook_at        timestamptz,
  webhooks_registered_at timestamptz,
  catalog_synced_at      timestamptz,
  last_drift_scan_at     timestamptz,
  last_drift_count       integer,
  -- The store's catalog must be re-read before it takes part in syncing: a new store, or one
  -- coming back from paused/error, may have renamed or reused variants meanwhile.
  catalog_pending        boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (auth_mode <> 'access_token' OR access_token_enc IS NOT NULL),
  CHECK (auth_mode <> 'client_credentials' OR (client_id IS NOT NULL AND client_secret_enc IS NOT NULL))
);

CREATE TABLE warehouses (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO warehouses (name) VALUES ('Main warehouse');

-- Shopify locations of every store, and which shared warehouse (if any) each one represents.
CREATE TABLE store_locations (
  id                  bigserial PRIMARY KEY,
  store_id            bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_location_id text NOT NULL,                         -- gid://shopify/Location/123
  name                text NOT NULL,
  is_active           boolean NOT NULL DEFAULT true,
  warehouse_id        bigint REFERENCES warehouses(id) ON DELETE SET NULL,
  -- Bumped (by trigger) whenever this location starts or stops holding a warehouse's stock.
  membership_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (store_id, shopify_location_id)
);
-- A store maps at most one of its locations to a given warehouse.
CREATE UNIQUE INDEX store_locations_one_per_warehouse ON store_locations (store_id, warehouse_id)
  WHERE warehouse_id IS NOT NULL;

CREATE TABLE items (
  id                  bigserial PRIMARY KEY,
  sku                 text NOT NULL UNIQUE,                  -- normalised (trimmed, upper-cased)
  title               text NOT NULL DEFAULT '',
  sync_enabled        boolean NOT NULL DEFAULT true,
  low_stock_threshold integer CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Every variant of every store, matched or not, so the dashboard can show unmatched SKUs.
CREATE TABLE variants (
  id                 bigserial PRIMARY KEY,
  store_id           bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  item_id            bigint REFERENCES items(id) ON DELETE SET NULL,
  shopify_product_id text NOT NULL,
  shopify_variant_id text NOT NULL,
  inventory_item_id  text NOT NULL,                          -- gid://shopify/InventoryItem/123
  sku                text,                                   -- normalised; NULL when blank
  barcode            text,
  product_title      text NOT NULL DEFAULT '',
  variant_title      text NOT NULL DEFAULT '',
  tracked            boolean NOT NULL DEFAULT true,
  is_bundle          boolean NOT NULL DEFAULT false,
  -- 'auto' links come from SKU matching and are recomputed on every catalog sync;
  -- 'manual' links were set in the dashboard and are left alone.
  link_source        text NOT NULL DEFAULT 'auto' CHECK (link_source IN ('auto', 'manual')),
  seen_at            timestamptz NOT NULL DEFAULT now(),        -- last catalog sync that saw it
  -- Bumped (by trigger) whenever the variant starts or stops syncing an item (link, tracking,
  -- bundle, inventory item or deletion changes).
  membership_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at         timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, shopify_variant_id)
);
CREATE UNIQUE INDEX variants_store_inventory_item ON variants (store_id, inventory_item_id)
  WHERE deleted_at IS NULL;
-- One linked variant per store per item.
CREATE UNIQUE INDEX variants_one_per_store_item ON variants (store_id, item_id)
  WHERE item_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX variants_sku ON variants (sku) WHERE deleted_at IS NULL;

-- A store's baseline for an item is only meaningful while the store kept syncing it. Any change
-- of membership bumps these timestamps; the engine ignores baselines older than them, so a store
-- that leaves and later comes back is treated as joining (its count is replaced, not added).
CREATE FUNCTION variants_membership_changed() RETURNS trigger AS $$
BEGIN
  IF NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.tracked IS DISTINCT FROM OLD.tracked
     OR NEW.is_bundle IS DISTINCT FROM OLD.is_bundle
     OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    NEW.membership_changed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER variants_membership_changed BEFORE UPDATE ON variants
  FOR EACH ROW EXECUTE FUNCTION variants_membership_changed();

CREATE FUNCTION store_locations_membership_changed() RETURNS trigger AS $$
BEGIN
  IF NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    NEW.membership_changed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER store_locations_membership_changed BEFORE UPDATE ON store_locations
  FOR EACH ROW EXECUTE FUNCTION store_locations_membership_changed();

CREATE TABLE pool_levels (
  id           bigserial PRIMARY KEY,
  item_id      bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  warehouse_id bigint NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  -- Shared available quantity. NULL until the item is initialised (onboarding); uninitialised
  -- levels are never written to Shopify.
  quantity     integer,
  version      bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, warehouse_id)
);

CREATE TABLE store_levels (
  pool_level_id     bigint NOT NULL REFERENCES pool_levels(id) ON DELETE CASCADE,
  store_id          bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  -- The Shopify inventory level the baseline belongs to. If the store's variant or location
  -- mapping changes, the baseline no longer applies and is ignored.
  inventory_item_id text NOT NULL,
  location_id       text NOT NULL,
  -- Last "available" value we know this store had (read by us, or written by us and confirmed).
  -- NULL = never observed: the store joins the pool and is overwritten without counting a delta.
  baseline          integer,
  -- clock_timestamp() of the write; compared with membership_changed_at (see triggers above).
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (pool_level_id, store_id)
);

-- Write-ahead record of every quantity write sent to Shopify. Rows exist only while the outcome
-- is unknown; they are resolved by replaying the same request with the same idempotency key.
CREATE TABLE pending_writes (
  pool_level_id     bigint NOT NULL REFERENCES pool_levels(id) ON DELETE CASCADE,
  store_id          bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  inventory_item_id text NOT NULL,
  location_id       text NOT NULL,
  idempotency_key   uuid NOT NULL UNIQUE,
  change_from     integer NOT NULL,
  target          integer NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pool_level_id, store_id)
);

-- Work queue: one row per pool level that needs reconciling. Coalesces bursts of webhooks.
CREATE TABLE sync_queue (
  pool_level_id bigint PRIMARY KEY REFERENCES pool_levels(id) ON DELETE CASCADE,
  reason        text NOT NULL,
  generation    bigint NOT NULL DEFAULT 1,                   -- bumped on every enqueue
  run_after     timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  lease_token   uuid,
  leased_until  timestamptz,
  last_error    text,
  enqueued_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_queue_ready ON sync_queue (run_after);

-- Requested changes to the shared quantity, applied by the engine inside the next reconcile of
-- that pool level (so they never race with propagation):
--   initialize  start syncing an item; strategy picks the starting quantity from the stores' live
--               values: 'store' (one store is right), 'min', 'max', 'sum', or 'value' (given).
--   set         "we counted 40": the shared quantity becomes `value`.
--   adjust      "received 24 units": the shared quantity changes by `value`.
--   count       "there are 40 on the shelf": physical count; the shared quantity becomes `value`
--               minus the units every store has committed to open (unfulfilled) orders.
CREATE TABLE pool_adjustments (
  id              bigserial PRIMARY KEY,
  pool_level_id   bigint NOT NULL REFERENCES pool_levels(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('initialize', 'set', 'adjust', 'count')),
  strategy        text CHECK (strategy IN ('store', 'min', 'max', 'sum', 'value')),
  source_store_id bigint REFERENCES stores(id) ON DELETE SET NULL,
  -- initialize from onboarding: the stores the merchant saw in the preview. The engine waits until
  -- every one of them can be read, so no store's stock is left out of the starting number.
  store_ids       bigint[],
  value           integer,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  applied_at      timestamptz,
  CHECK (kind <> 'initialize' OR strategy IS NOT NULL),
  CHECK (kind = 'initialize' OR value IS NOT NULL),
  CHECK (strategy IS DISTINCT FROM 'value' OR value IS NOT NULL)
  -- No CHECK that 'store' has a source: deleting that store sets it to NULL, and the engine
  -- records the initialisation as failed.
);
CREATE INDEX pool_adjustments_pending ON pool_adjustments (pool_level_id) WHERE applied_at IS NULL;

-- Other background work (catalog refreshes, webhook registration), de-duplicated by key.
CREATE TABLE tasks (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  dedupe_key   text NOT NULL UNIQUE,
  payload      jsonb NOT NULL DEFAULT '{}',
  generation   bigint NOT NULL DEFAULT 1,                     -- bumped on every enqueue
  run_after    timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  lease_token  uuid,
  leased_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_ready ON tasks (run_after);

-- Webhook de-duplication (Shopify delivers at least once).
CREATE TABLE webhook_events (
  event_id    text PRIMARY KEY,
  store_id    bigint REFERENCES stores(id) ON DELETE CASCADE,
  topic       text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_received_at ON webhook_events (received_at);

-- Append-only audit trail of every quantity change we observed or made.
CREATE TABLE inventory_events (
  id              bigserial PRIMARY KEY,
  pool_level_id   bigint REFERENCES pool_levels(id) ON DELETE SET NULL,
  item_id         bigint REFERENCES items(id) ON DELETE SET NULL,
  store_id        bigint REFERENCES stores(id) ON DELETE SET NULL,
  kind            text NOT NULL,
  delta           integer,
  quantity_before integer,
  quantity_after  integer,
  message         text,
  details         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_events_item ON inventory_events (item_id, created_at DESC);
CREATE INDEX inventory_events_created ON inventory_events (created_at DESC);

CREATE TABLE alerts (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,                                 -- low_stock | oversold | store_error | ...
  dedupe_key  text NOT NULL,
  item_id     bigint REFERENCES items(id) ON DELETE CASCADE,
  store_id    bigint REFERENCES stores(id) ON DELETE CASCADE,
  message     text NOT NULL,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  resolved_at timestamptz
);
-- Only one open alert per dedupe key.
CREATE UNIQUE INDEX alerts_open_dedupe ON alerts (dedupe_key) WHERE resolved_at IS NULL;

-- One row per "an item was wiped out by store changes" seen by the circuit breaker (see settings).
CREATE TABLE circuit_breaker_hits (
  id            bigserial PRIMARY KEY,
  pool_level_id bigint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX circuit_breaker_hits_created ON circuit_breaker_hits (created_at);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
