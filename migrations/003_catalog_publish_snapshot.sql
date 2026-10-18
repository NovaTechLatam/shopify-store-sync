-- Catalog: what was last published to each brand, so the publish preview can say what changes.
--
-- published_hash (002) only tells whether something changed since the last publish; the snapshot
-- is that same content (src/products/desired.ts, DesiredContent: titles, options, variants, image
-- ids...) as JSON, so the preview can list which fields differ. Prices and costs are not part of
-- it: they follow the base prices and price rules, and are compared with what the store charges
-- now instead (variants.price).

ALTER TABLE master_product_stores
  ADD COLUMN published_snapshot jsonb;                              -- NULL = never published
