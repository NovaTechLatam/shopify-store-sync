-- Catalog (master products), price rules, sales history, purchasing and reorder planning.
--
-- Vocabulary
--   master product  one product written once in Store Sync and published to every brand store.
--   base currency   settings.base_currency. Base prices and unit costs are in it.
--   store currency  stores.currency_code. Prices and sales amounts read from a store are in it.
--   exchange rate   stores.exchange_rate: units of the store's currency per 1 unit of the base
--                   currency (base USD, store COP: about 4000). 1 when they are the same.
--
-- Money is numeric(18,4) (pg returns it as a JS number, see src/db/pool.ts) and is rounded to the
-- currency's decimals only when it is sent to Shopify or shown.

-- ---------- stores ----------------------------------------------------------------------------

ALTER TABLE stores
  ADD COLUMN currency_code    text,                                  -- 'COP'; NULL until read from Shopify
  ADD COLUMN iana_timezone    text,                                  -- 'America/Bogota'
  ADD COLUMN exchange_rate    numeric(18,8) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  -- When the merchant last saved the rate. NULL: still the default 1, which is no rate at all for
  -- a store in another currency (src/util/money.ts, exchangeRateUnset).
  ADD COLUMN exchange_rate_set_at timestamptz,
  -- Access scopes the app had on this store when we last looked (NULL = never checked). Features
  -- that need optional scopes (write_products, read_orders...) check these before calling Shopify.
  ADD COLUMN granted_scopes   text[],
  ADD COLUMN scopes_checked_at timestamptz,
  -- Webhook topics we had registered after the last successful ensure_webhooks, so a topic we add
  -- in a new version isn't mistaken for one Shopify deleted.
  ADD COLUMN webhook_topics   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN online_store_publication_id text,                       -- gid://shopify/Publication/1
  ADD COLUMN product_id_definition_at timestamptz,                   -- custom-id metafield definition created
  -- Sales history: Shopify updated_at of the newest order ingested (incremental sync resumes here).
  ADD COLUMN orders_synced_at timestamptz,
  ADD COLUMN sales_backfill_status text NOT NULL DEFAULT 'none'
    CHECK (sales_backfill_status IN ('none', 'running', 'done', 'failed')),
  ADD COLUMN sales_backfill_operation_id text,                       -- gid://shopify/BulkOperation/1
  ADD COLUMN sales_backfill_started_at timestamptz,
  ADD COLUMN sales_backfill_error text;

-- Stores already set up had every topic of version 1 registered.
UPDATE stores SET webhook_topics = ARRAY[
  'INVENTORY_LEVELS_UPDATE', 'INVENTORY_LEVELS_CONNECT', 'INVENTORY_LEVELS_DISCONNECT',
  'INVENTORY_ITEMS_CREATE', 'INVENTORY_ITEMS_UPDATE', 'INVENTORY_ITEMS_DELETE', 'PRODUCTS_DELETE',
  'LOCATIONS_CREATE', 'LOCATIONS_UPDATE', 'LOCATIONS_ACTIVATE', 'LOCATIONS_DEACTIVATE',
  'LOCATIONS_DELETE', 'APP_UNINSTALLED']
 WHERE webhooks_registered_at IS NOT NULL;

-- ---------- items and variants -----------------------------------------------------------------

ALTER TABLE items
  ADD COLUMN base_price            numeric(18,4) CHECK (base_price >= 0),            -- base currency
  ADD COLUMN base_compare_at_price numeric(18,4) CHECK (base_compare_at_price >= 0),
  ADD COLUMN cost                  numeric(18,4) CHECK (cost >= 0),                  -- unit cost, base currency
  ADD COLUMN cost_updated_at       timestamptz,
  ADD COLUMN supplier_id           bigint,                                           -- preferred supplier (FK below)
  ADD COLUMN lead_time_days        integer CHECK (lead_time_days >= 0),              -- NULL = supplier's, then the setting
  ADD COLUMN reorder_cover_days    integer CHECK (reorder_cover_days > 0),           -- NULL = the setting
  ADD COLUMN reorder_enabled       boolean NOT NULL DEFAULT true;                    -- false = discontinued, never suggest

-- Prices the store has now (store currency), read with the catalog. Not covered by the
-- membership trigger: a price change never affects stock syncing.
ALTER TABLE variants
  ADD COLUMN price            numeric(18,4),
  ADD COLUMN compare_at_price numeric(18,4);

-- Adjustments made by features (a purchase order received...) log their own event kind and details.
ALTER TABLE pool_adjustments
  ADD COLUMN event_kind text,                                       -- inventory_events.kind; NULL = default for the kind
  ADD COLUMN details    jsonb;

-- ---------- catalog: master products ----------------------------------------------------------

-- Images uploaded from the dashboard. Shared by every store; uploaded to each store when published.
CREATE TABLE media_files (
  id         bigserial PRIMARY KEY,
  sha256     text NOT NULL UNIQUE,
  filename   text NOT NULL,
  mime_type  text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  byte_size  integer NOT NULL CHECK (byte_size > 0),
  width      integer,
  height     integer,
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Shared fields of a product, and the defaults of every brand's version of it.
CREATE TABLE master_products (
  id               bigserial PRIMARY KEY,
  title            text NOT NULL,
  description_html text NOT NULL DEFAULT '',
  vendor           text NOT NULL DEFAULT '',
  product_type     text NOT NULL DEFAULT '',
  tags             text[] NOT NULL DEFAULT '{}',
  handle           text,                                            -- NULL = Shopify derives it from the title
  seo_title        text,
  seo_description  text,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('ACTIVE', 'DRAFT', 'ARCHIVED')),
  -- [{"name": "Size", "values": ["S", "M"]}], at most 3. [] = a single variant without options.
  options          jsonb NOT NULL DEFAULT '[]',
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One per SKU. Price comes from items.base_price (and the store's price rule), cost from items.cost.
CREATE TABLE master_variants (
  id                bigserial PRIMARY KEY,
  master_product_id bigint NOT NULL REFERENCES master_products(id) ON DELETE CASCADE,
  item_id           bigint NOT NULL UNIQUE REFERENCES items(id) ON DELETE RESTRICT,
  sku               text NOT NULL,                                  -- as typed; items.sku is the normalised form
  option_values     text[] NOT NULL DEFAULT '{}',                   -- one per master option, in order
  barcode           text,
  weight            numeric(12,3) CHECK (weight >= 0),
  weight_unit       text NOT NULL DEFAULT 'GRAMS' CHECK (weight_unit IN ('GRAMS', 'KILOGRAMS', 'OUNCES', 'POUNDS')),
  requires_shipping boolean NOT NULL DEFAULT true,
  taxable           boolean NOT NULL DEFAULT true,
  position          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (master_product_id, option_values)
);

-- A brand's version of a master product. NULL text fields use the master's value.
CREATE TABLE master_product_stores (
  master_product_id  bigint NOT NULL REFERENCES master_products(id) ON DELETE CASCADE,
  store_id           bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  enabled            boolean NOT NULL DEFAULT true,                 -- false = not sold in this store
  title              text,
  description_html   text,
  vendor             text,
  product_type       text,
  handle             text,
  seo_title          text,
  seo_description    text,
  extra_tags         text[] NOT NULL DEFAULT '{}',                  -- added to the master's tags
  status             text CHECK (status IN ('ACTIVE', 'DRAFT', 'ARCHIVED')),
  publish_to_online_store boolean NOT NULL DEFAULT true,
  shopify_product_id text,                                          -- gid://shopify/Product/1; NULL = not in the store yet
  publish_state      text NOT NULL DEFAULT 'never'
    CHECK (publish_state IN ('never', 'queued', 'publishing', 'published', 'failed')),
  published_hash     text,                                          -- of what was last sent; differs = unpublished changes
  published_at       timestamptz,
  last_error         text,
  warnings           text[] NOT NULL DEFAULT '{}',                  -- non-fatal problems of the last publish
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (master_product_id, store_id)
);
CREATE UNIQUE INDEX master_product_stores_shopify_product
  ON master_product_stores (store_id, shopify_product_id) WHERE shopify_product_id IS NOT NULL;

-- Images of a master product, per brand (store_id) or for every brand (store_id NULL).
CREATE TABLE master_media (
  id                bigserial PRIMARY KEY,
  master_product_id bigint NOT NULL REFERENCES master_products(id) ON DELETE CASCADE,
  store_id          bigint REFERENCES stores(id) ON DELETE CASCADE,
  position          integer NOT NULL DEFAULT 0,
  alt               text NOT NULL DEFAULT '',
  file_id           bigint REFERENCES media_files(id) ON DELETE RESTRICT,
  source_url        text,                                           -- https image URL (e.g. imported from a store)
  option_value      text,                                           -- variant image for variants with this option value
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (file_id IS NOT NULL OR source_url IS NOT NULL)
);
CREATE INDEX master_media_product ON master_media (master_product_id, position);

-- The Shopify media created for an image in each store, so updates reference it instead of
-- uploading it again.
CREATE TABLE master_media_links (
  master_media_id  bigint NOT NULL REFERENCES master_media(id) ON DELETE CASCADE,
  store_id         bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_media_id text NOT NULL,                                   -- gid://shopify/MediaImage/1
  PRIMARY KEY (master_media_id, store_id)
);

-- ---------- pricing ---------------------------------------------------------------------------

-- How a store's prices follow the base prices:
--   price = round(base_price × exchange_rate × multiplier + add_amount)
-- round: 'none' = currency decimals; 'multiple' = to a multiple of round_step; 'ending' = to
-- k × round_step + round_ending (step 1, ending 0.90 gives 12.90; step 1000, ending 900 gives 41,900).
CREATE TABLE price_rules (
  store_id          bigint PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  enabled           boolean NOT NULL DEFAULT false,                 -- false = Store Sync doesn't manage this store's prices
  multiplier        numeric(12,6) NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  add_amount        numeric(18,4) NOT NULL DEFAULT 0,               -- store currency
  round_mode        text NOT NULL DEFAULT 'none' CHECK (round_mode IN ('none', 'ending', 'multiple')),
  round_step        numeric(18,4) NOT NULL DEFAULT 1 CHECK (round_step > 0),
  round_ending      numeric(18,4) NOT NULL DEFAULT 0 CHECK (round_ending >= 0),
  round_direction   text NOT NULL DEFAULT 'nearest' CHECK (round_direction IN ('up', 'nearest', 'down')),
  -- none = no compare-at price; keep = leave the store's as it is; from_base = the base
  -- compare-at price through the same rule; markup = price × compare_at_markup.
  compare_at_mode   text NOT NULL DEFAULT 'from_base' CHECK (compare_at_mode IN ('none', 'keep', 'from_base', 'markup')),
  compare_at_markup numeric(12,6) NOT NULL DEFAULT 1 CHECK (compare_at_markup >= 1),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (round_ending < round_step)
);

CREATE TABLE price_schedules (
  id              bigserial PRIMARY KEY,
  name            text NOT NULL,
  -- sale: percent off the regular price in some stores, between starts_at and ends_at, through
  --       price_overrides owned by the schedule. base_change: new base prices from starts_at on.
  kind            text NOT NULL CHECK (kind IN ('sale', 'base_change')),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz,
  status          text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'active', 'ended', 'cancelled', 'failed')),
  store_ids       bigint[],                                         -- sale: NULL = every store
  item_ids        bigint[] NOT NULL DEFAULT '{}',
  percent_off     numeric(5,2) CHECK (percent_off > 0 AND percent_off < 100),
  show_compare_at boolean NOT NULL DEFAULT true,                    -- sale: regular price shown crossed out
  -- base_change: [{"itemId": 1, "basePrice": 10.5, "baseCompareAtPrice": null}]
  changes         jsonb NOT NULL DEFAULT '[]',
  -- What the schedule replaced when it started, restored when a sale ends:
  -- [{"storeId": 1, "itemId": 2, "override": null | {"price": 9, "compareAtPrice": null, "note": null}}]
  previous        jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  ended_at        timestamptz,
  CHECK (kind <> 'sale' OR (ends_at IS NOT NULL AND ends_at > starts_at AND percent_off IS NOT NULL)),
  CHECK (kind <> 'base_change' OR ends_at IS NULL)
);
CREATE INDEX price_schedules_due ON price_schedules (starts_at) WHERE status IN ('scheduled', 'active');

-- A fixed price for one item in one store (store currency), instead of the rule.
CREATE TABLE price_overrides (
  store_id         bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  item_id          bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  price            numeric(18,4) NOT NULL CHECK (price >= 0),
  compare_at_price numeric(18,4) CHECK (compare_at_price >= 0),
  schedule_id      bigint REFERENCES price_schedules(id) ON DELETE SET NULL, -- set while a sale owns it
  note             text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, item_id)
);

-- One "update the stores' prices" job, started from the dashboard or by a schedule.
CREATE TABLE price_runs (
  id          bigserial PRIMARY KEY,
  reason      text NOT NULL,                                        -- 'manual', 'schedule:12'
  item_ids    bigint[],                                             -- NULL = every item
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE TABLE price_run_stores (
  run_id           bigint NOT NULL REFERENCES price_runs(id) ON DELETE CASCADE,
  store_id         bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  variants_checked integer NOT NULL DEFAULT 0,
  variants_updated integer NOT NULL DEFAULT 0,
  variants_failed  integer NOT NULL DEFAULT 0,
  errors           jsonb NOT NULL DEFAULT '[]',                     -- [{"sku": "X", "message": "..."}], at most 50
  error            text,                                            -- the store-level failure, if any
  started_at       timestamptz,
  finished_at      timestamptz,
  PRIMARY KEY (run_id, store_id)
);

-- ---------- sales history ---------------------------------------------------------------------

-- Orders of every store, as Shopify has them now (refunds, edits and cancellations included).
-- Holds no customer data.
CREATE TABLE sales_orders (
  id                 bigserial PRIMARY KEY,
  store_id           bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_order_id   text NOT NULL,                                 -- gid://shopify/Order/1
  name               text NOT NULL DEFAULT '',                      -- '#1001'
  processed_at       timestamptz NOT NULL,                          -- the sale date
  shopify_updated_at timestamptz NOT NULL,                          -- an older copy never overwrites a newer one
  cancelled_at       timestamptz,
  test               boolean NOT NULL DEFAULT false,
  currency_code      text NOT NULL,                                 -- shop currency of the amounts
  source_name        text,                                          -- 'web', 'pos'...
  taxes_included     boolean NOT NULL DEFAULT false,
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, shopify_order_id)
);
CREATE INDEX sales_orders_processed ON sales_orders (store_id, processed_at);

CREATE TABLE sales_lines (
  id                 bigserial PRIMARY KEY,
  order_id           bigint NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  store_id           bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_line_id    text NOT NULL,                                 -- gid://shopify/LineItem/1
  item_id            bigint REFERENCES items(id) ON DELETE SET NULL,
  sku                text,                                          -- normalised
  shopify_variant_id text,
  quantity           integer NOT NULL,                              -- ordered, including refunded and removed units
  current_quantity   integer NOT NULL,                              -- after refunds, removals and cancellation
  gross              numeric(18,4) NOT NULL DEFAULT 0,              -- unit price × quantity, store currency
  discounts          numeric(18,4) NOT NULL DEFAULT 0,
  net                numeric(18,4) NOT NULL DEFAULT 0,              -- after discounts, refunds and removals, before tax
  unit_cost          numeric(18,4),                                 -- base currency: items.cost when first seen
  is_gift_card       boolean NOT NULL DEFAULT false,
  processed_at       timestamptz NOT NULL,                          -- the order's, copied for the indexes
  UNIQUE (order_id, shopify_line_id)
);
CREATE INDEX sales_lines_item ON sales_lines (item_id, processed_at);
CREATE INDEX sales_lines_store ON sales_lines (store_id, processed_at);
CREATE INDEX sales_lines_unmatched ON sales_lines (store_id) WHERE item_id IS NULL;

-- ---------- purchasing ------------------------------------------------------------------------

CREATE TABLE suppliers (
  id             bigserial PRIMARY KEY,
  name           text NOT NULL,
  contact_name   text,
  email          text,
  phone          text,
  currency_code  text NOT NULL,                                     -- what the supplier invoices in
  lead_time_days integer CHECK (lead_time_days >= 0),               -- order to delivery
  notes          text,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppliers_name ON suppliers (lower(name)) WHERE archived_at IS NULL;

ALTER TABLE items ADD CONSTRAINT items_supplier_fk
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;

-- What a supplier sells: their code, price and order quantities for one of our items.
CREATE TABLE supplier_items (
  supplier_id   bigint NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  item_id       bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  supplier_sku  text,
  unit_cost     numeric(18,4) CHECK (unit_cost >= 0),               -- supplier currency
  min_order_qty integer CHECK (min_order_qty > 0),
  pack_size     integer CHECK (pack_size > 0),                      -- order in multiples of this
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, item_id)
);

CREATE SEQUENCE purchase_order_number_seq;

-- draft → ordered → partial → received; ordered/partial → closed (rest not coming);
-- draft/ordered → cancelled (only if nothing was received).
CREATE TABLE purchase_orders (
  id            bigserial PRIMARY KEY,
  number        text NOT NULL UNIQUE,                               -- 'PO-0001'
  supplier_id   bigint NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  warehouse_id  bigint NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status        text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ordered', 'partial', 'received', 'closed', 'cancelled')),
  currency_code text NOT NULL,                                      -- of the unit costs
  exchange_rate numeric(18,8) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0), -- PO currency per 1 base currency
  expected_on   date,
  notes         text,
  ordered_at    timestamptz,
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_orders_open ON purchase_orders (supplier_id) WHERE status IN ('ordered', 'partial');

CREATE TABLE purchase_order_lines (
  id                bigserial PRIMARY KEY,
  purchase_order_id bigint NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id           bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  quantity_ordered  integer NOT NULL CHECK (quantity_ordered > 0),
  quantity_received integer NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  unit_cost         numeric(18,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0), -- PO currency
  position          integer NOT NULL DEFAULT 0,
  UNIQUE (purchase_order_id, item_id)
);
CREATE INDEX purchase_order_lines_item ON purchase_order_lines (item_id);

-- One delivery: what arrived, booked into the shared stock through pool_adjustments.
CREATE TABLE po_receipts (
  id                bigserial PRIMARY KEY,
  purchase_order_id bigint NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  request_id        uuid NOT NULL UNIQUE,                           -- sent by the dashboard: a retried request books once
  note              text,
  reversed_at       timestamptz,                                    -- undone: the units were taken out again
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE po_receipt_lines (
  receipt_id         bigint NOT NULL REFERENCES po_receipts(id) ON DELETE CASCADE,
  line_id            bigint NOT NULL REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  quantity           integer NOT NULL CHECK (quantity > 0),
  pool_adjustment_id bigint REFERENCES pool_adjustments(id) ON DELETE SET NULL,
  PRIMARY KEY (receipt_id, line_id)
);
