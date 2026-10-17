# Roadmap

You asked which other features are worth adding. This page lists what is in this version (✅) and
what we suggest building next, in order, with the reason each one matters for brands that sell
**the same product with a different brand, price and images**.

It is based on a review of the Shopify stock sync apps on the market (Syncio, Multi-Store Sync
Power, Trunk, Hydra, DeltaSync and others), heavier inventory systems (Linnworks, Cin7, Katana,
SKUSavvy, Prediko) and the problems their users report.

Effort: **S** about 1-3 days, **M** about 1-2 weeks, **L** 3 weeks or more.

## What goes wrong with other sync apps

Reviews of these apps keep reporting the same failures. Version 1 was designed around them:

| Reported problem                                                       | How Store Sync handles it                                                                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Every store's stock set to zero, or scrambled, at setup or disconnect. | A preview before anything is written. Disconnecting never writes zeros. A circuit breaker pauses sync when many products drop to zero at once. |
| One "main" store rules: edits made in the other stores are ignored.    | No main store. A change in any store counts.                                                                                                   |
| Duplicate or mismatched SKUs move the wrong stock.                     | SKUs used twice in a store are never synced. Unmatched products are listed for you to link.                                                    |
| Changes made by other apps (bundles, POS, returns apps) are missed.    | Store Sync follows Shopify's stock numbers, which every app and channel changes, rather than orders.                                           |
| Sync silently stopped for days.                                        | Every store is compared every 15 minutes, notifications are re-created when Shopify drops them, and alerts tell you.                           |
| Overselling because sync runs every hour or two.                       | Changes sync within seconds, plus a safety buffer per store.                                                                                   |
| Stock doubling or bouncing between stores.                             | Store Sync's own updates are never counted as changes, and every update is conditional on the number it just read.                             |

## In this version

| Feature                                                                                                            | Status |
| ------------------------------------------------------------------------------------------------------------------ | ------ |
| One shared stock, with every store as an equal                                                                     | ✅     |
| Sync within seconds of any change: orders, cancellations, refunds, returns, POS, staff edits, other apps           | ✅     |
| Updates that never overwrite a sale, and are safe to retry after a crash or timeout                                | ✅     |
| Automatic matching by SKU, manual linking, duplicate SKUs held back                                                | ✅     |
| A safe first sync: four ways to pick starting numbers, with a preview                                              | ✅     |
| Safety buffer per store                                                                                            | ✅     |
| Pause everything, one store or one product. Circuit breaker for mass zeroing. No zeroing on disconnect             | ✅     |
| A 15-minute comparison of every store, re-created notifications and automatic store health checks                  | ✅     |
| Activity log of every change, plus Store Sync's updates tagged in Shopify's own inventory history                  | ✅     |
| Alerts (low stock, oversold, store problems, missed notifications, deliveries entered twice) to Slack or a webhook | ✅     |
| Stock tools: set the stock, add or remove units, or enter a shelf count (unshipped and set-aside units subtracted) | ✅     |
| Several warehouses (one location per store per warehouse)                                                          | ✅     |
| New products start syncing on their own                                                                            | ✅     |
| Two ways to connect a store: Dev Dashboard app, or an existing custom app                                          | ✅     |

## Next: the features we recommend

### 1. Create a product once, publish it to every brand (L)

Write a product once and push it to every store. Each brand gets its own title, description,
images, SEO and tags, while shared details stay identical: SKU, barcode, weight, options and
variants.

**Why for you:** your brands differ only in brand, price and images, so today every product is
created several times by hand. This removes most of that work. It also guarantees the same SKU
everywhere, which is what makes stock sync work. Other apps only copy fields with on/off switches;
real per-brand versions are a gap in the market.

### 2. Price rules per brand (M)

For example: "Brand B = Brand A's price × 1.3, rounded to end in .90", compare-at prices, scheduled
price changes and bulk edits.

**Why for you:** price is one of the three things that differ between your brands. Keeping several
price lists consistent by hand is slow and error-prone.

### 3. Reports across all brands (M-L)

Units and revenue per product per brand, sell-through, days of stock left and margin per brand, in
each store's currency and combined.

**Why for you:** each Shopify store only sees its own sales. Deciding what to reorder, or which
brand deserves the stock, needs all of them side by side. This needs one more permission
(`read_orders`).

### 4. Reorder alerts based on days of stock left (S-M)

"At the current pace you will run out of SKU X in 9 days", sent to WhatsApp, Slack or email, in
place of a fixed low-stock number.

**Why for you:** this is your stated goal: never sell out. A fixed threshold is too late for
bestsellers and too noisy for slow products. It builds on the reports in 3.

### 5. Purchase orders and receiving (M)

Create a purchase order, then receive the delivery once (in full or in parts), and every brand is
updated. See what is on its way.

**Why for you:** a delivery is one physical event, but today staff are tempted to type it into
every store, which counts it several times. Version 1 already has **Add units** and warns about
deliveries entered twice; this adds suppliers, expected dates and partial deliveries. Shopify's own
Stocky app shut down on August 31, 2026, so many merchants are looking for this.

### 6. Stock allocation per brand (M)

Rules such as "Brand B shows at most 20", "keep 50 for Brand A's launch" or "when fewer than 10 are
left, only sell in the premium brand".

**Why for you:** when stock is scarce, you choose which brand and which price point gets it, and
protect your margin.

### 7. Safety buffers per product (S)

A buffer per product, or a percentage, on top of the per-store buffer.

**Why for you:** a bestseller that sells several units a minute needs a bigger buffer than a slow
product.

### 8. Pack sizes (M)

A brand sells a 2-pack of the same physical product: it shows half the shared stock, and each sale
removes 2 units.

**Why for you:** brands often package the same product differently.

### 9. Smaller additions (S each)

- **Discontinue or archive a product in every brand at once,** so no brand keeps a forgotten
  listing.
- **Returns inspection:** put returned units back into the shared stock only after they are
  checked, so one brand's damaged return isn't sold again by every brand.
- **"Read every store again" button**, to start fresh from the stores' current numbers after
  restoring an old backup (today this takes a few database commands, see
  [operations](operations.md#restoring)).
- **Approval queue** for suspicious changes, such as a large increase typed into a store, held
  until you confirm it.

### 10. Team roles (S-M)

Owner, operations, brand manager (prices and content of their own brand only) and read-only.

**Why for you:** brands are often run by different people. A brand manager shouldn't be able to
change the shared stock.

### 11. Bundles and kits (M-L)

Bundle availability calculated from the shared stock of its parts, for bundles each brand builds
differently.

### 12. Barcode matching and stock counts with a phone (M)

Match products by barcode when SKUs differ, and count shelves by scanning barcodes with a phone.

## Later

| Feature                                                                               | Why later                                                                         | Effort |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| Demand forecasting and suggested purchase orders                                      | Needs 6-12 months of combined sales history from the reports (3).                 | L      |
| One pick list for all brands, with branded packing slips                              | Worth it once one warehouse ships a lot for every brand.                          | L      |
| Connecting a 3PL or warehouse system as the stock source                              | Only if you outsource fulfillment.                                                | L      |
| More sales channels on the same stock: Mercado Libre, Amazon, wholesale (Shopify B2B) | Same shared stock, more places to sell. Mercado Libre leads in Latin America.     | L each |
| Country prices and availability per brand (Shopify Markets)                           | Only if your brands sell abroad.                                                  | M      |
| Lot, expiry date or serial number tracking                                            | Only for perishable or regulated products.                                        | L      |
| WhatsApp and email alerts built in                                                    | Version 1 reaches them through Zapier or Make.                                    | S-M    |
| Weekly summary (top sellers, products at risk, price gaps between brands)             | Easy once reports (3) exist.                                                      | S-M    |
| Show which order caused each stock change                                             | Needs order data (`read_orders`). The stock numbers are already right without it. | S-M    |
| Shopify's newer notification system (Events)                                          | Richer notifications, but brand new. Classic notifications work well today.       | M      |
| Selling Store Sync to other merchants as a public app                                 | Needs Shopify's OAuth flow, billing and App Store review.                         | L      |

## Our recommendation

If you build only a few things next, build **1 (create once, publish to every brand)**, **2 (price
rules per brand)**, **3 and 4 (reports with reorder alerts)** and **5 (receiving deliveries)**.
They follow directly from "the only difference is the brand, the price and the images", and the
low-cost sync apps don't do them well.
