# Roadmap

You asked which other features are worth adding. This page lists what is in this version (✅),
what it doesn't do yet, and what we suggest building next, in order, with the reason each one
matters for brands that sell **the same product with a different brand, price and images**.

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

### Stock sync (version 1)

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

### Catalog, prices, reports and purchasing (version 2)

These were the first five recommendations of the previous roadmap. Each is optional and works
without the others. The catalog and prices need the `write_products` permission in Shopify, reports
and reorder suggestions `read_orders`, and purchasing nothing more (see
[Setting up Shopify](setup-shopify.md#permissions-for-the-extra-features)).

**✅ Create a product once, publish it to every brand** ([the catalog](catalog.md))

- A default version, and per brand its own title, description, images, search listing, tags,
  status and Online Store visibility. Options, variants, SKUs, barcodes and weights are shared.
- Import the products your stores already sell; the other brands' products with the same SKUs are
  linked, keeping their own texts and images.
- A preview per brand before publishing, including what would be deleted. New SKUs start at 0 and
  then follow the shared stock. Archive in every brand by archiving once and publishing.
- Not yet: collections, metafields, product categories, sales channels other than the Online
  Store, and Markets. Option names and values are the same in every brand. At most 3 options and
  250 variants. Publishing removes videos and 3D models from a brand's product.

**✅ Price rules per brand** ([prices](pricing.md))

- A base price per product, and a rule per store: exchange rate, multiplier, amount to add,
  rounding ("ending in .90", "multiple of 1,000") and compare-at price. Fixed prices per store,
  bulk edits, sales and base price changes planned ahead, a preview with big drops flagged, and a
  history of every update.
- Not yet: exchange rates are typed by hand. One price per product per store: no Markets, B2B
  catalogs or quantity breaks. Sales take a percentage off.

**✅ Reports across all brands** ([reports](reports.md))

- Revenue, units, orders and margin for every brand and combined, in each store's currency and
  your base currency; per product with sell-through and days of stock left; a CSV download. The
  order history is imported when a store is connected, then kept up to date live and every 15
  minutes.
- Not yet: 60 days of history unless Shopify approves `read_all_orders`. Past sales are converted
  with today's exchange rate. No breakdown by sales channel, discount code or customer.

**✅ Reorder alerts based on days of stock left** ([purchasing](purchasing.md#reorder-suggestions))

- The sales pace in every store, the stock you have and what's on order, the lead time and a
  safety margin; a suggested quantity rounded to the supplier's minimum and pack size; alerts that
  don't repeat for a product right at the line; draft orders per supplier in one click.
- Not yet: the pace is a plain average, so seasons, promotions and stock-outs make it less
  accurate. Alerts reach WhatsApp or email only through Zapier or Make.

**✅ Purchase orders and receiving** ([purchasing](purchasing.md))

- Suppliers with their currency, lead time, prices, minimum order and pack size. Purchase orders
  from draft to received; partial deliveries; more than ordered only after you confirm; a delivery
  sent twice is counted once; undo. Average or last cost, optionally copied to Shopify. Print and
  CSV.
- Not yet: one warehouse per order. A closed order can't be reopened. No transfers between
  warehouses. Orders aren't sent to suppliers from Store Sync: print or download them.

### Known gaps in this version

Smaller things we know about. Each is a small fix (S), except the last, which is a check to make on
a real store:

- **Taking a product out of a sale** drops the fixed price it had before the sale: set it again.
- **"Set base prices from a store…"** uses the prices from the last read of the store's products
  (up to 6 hours old), not fresh ones.
- **Changing a draft order's currency or supplier** keeps the prices of the lines already on it:
  check them.
- **A delivery to a warehouse no store location is set to** waits until one is, and the product
  is started there.
- **A catalog SKU you create by hand in a store before publishing it** waits for **Start
  syncing**, even with automatic start on.
- **Days of stock left in Reports** count a delivery once it's in the shared stock (seconds later,
  or when syncing resumes); the Reorder tab counts it at once, so the two can differ meanwhile.
- **"Import again…"** keeps retrying when Shopify won't start the export for a reason other than a
  permission, and the 15-minute order check stays off for that store meanwhile. The import also
  holds the whole export in memory (about 100 MB per 100,000 orders).
- **A product selling less than one unit in 200 days** shows "—" per day in Reports.
- **The page of a product not published yet** still says to fix its problems in Shopify.
- **Removing a SKU that was never in a store from a catalog product** removes it from Store Sync
  even when a planned sale lists it; the sale then skips it.
- **Shopify behaviour tested only against a stand-in store.** Check these on one product before
  relying on them: how images and variant images are matched when publishing, stock sent for
  variants added to an existing product, removing a compare-at price, prices Shopify refuses,
  "Cost per item" updates, live sales updates (protected customer data), and revenue on stores
  whose prices include tax. Each feature's page says which applies.

## Next: the features we recommend

### 1. Stock allocation per brand (M)

Rules such as "Brand B shows at most 20", "keep 50 for Brand A's launch" or "when fewer than 10 are
left, only sell in the premium brand".

**Why for you:** today every brand sells the same last units. Reports now show which brand sells
each product, and at what margin: allocation lets you act on it, so scarce stock goes to the brand
and price point you choose.

### 2. Returns policy: check before restocking (M)

Returned units wait as "to inspect" before they rejoin the shared stock, with a rule per brand
("Brand A's returns go straight back, Brand B's are checked first"). Store Sync now reads orders
and refunds, which makes this possible.

**Why for you:** with one shared stock, a damaged return in one brand is sold again by every
brand. Each brand may also promise different return terms.

### 3. Automatic exchange rates (S)

Each store's exchange rate updated every day from a public source, optionally with a margin, with
an alert when a rate moves more than you allow, and a history of rates so reports convert each
sale at the rate of its day.

**Why for you:** when your brands sell in different currencies, rates like USD to COP move every
week. Today a rate is typed by hand, so prices and margins drift until someone updates it, and
past reports change when it does.

### 4. Team roles and personal logins (S-M)

Owner, operations, brand manager (prices and content of their own brand only) and read-only, each
with their own login, and their name in the activity log.

**Why for you:** Store Sync now changes products and prices, not only stock, and everyone shares
one password. A brand manager shouldn't be able to change another brand's prices or the shared
stock.

### 5. Bundles, kits and pack sizes (M-L)

A bundle's stock worked out from the shared stock of its parts, for bundles each brand builds
differently; a brand's 2-pack shows half the stock and each sale removes 2 units. Built into the
catalog too.

**Why for you:** brands often package the same product differently (gift sets, multi-packs).
Today Store Sync syncs a bundle's parts and leaves the bundle itself to Shopify.

### 6. Demand forecasting (L)

Reorder suggestions that see seasons, promotions and growth, ignore days when the product was out
of stock, and plan orders month by month.

**Why for you:** a plain average orders too little before your peaks (Black Friday, Christmas) and
too much after them. It needs 6-12 months of combined sales: with `read_all_orders`, or once Store
Sync has collected them.

### 7. Collections per brand (M)

The catalog puts each product in each brand's collections when it publishes.

**Why for you:** each brand organises its store its own way. Collections based on tags already
work, because each brand has its own tags; collections you fill by hand still need every new
product added in every store.

### 8. Option names and values per brand (M)

"Talla / Color" in one brand and "Size / Colour" in another, or a brand in another language, while
the variants and SKUs stay the same.

**Why for you:** options are shared today because they define the variants. Brands with their own
voice, or in another language, need their own words for them.

### 9. Transfers between warehouses (M)

Move units from one warehouse to another, with the units in transit counted in neither until they
arrive; split a delivery across warehouses.

**Why for you:** with a warehouse and a shop, moving stock today takes two manual changes, and a
purchase order delivers to one warehouse only.

### 10. Central fulfilment and 3PLs (L)

One pick list for all brands with branded packing slips, or a 3PL's warehouse system as the source
of the shared stock.

**Why for you:** once one warehouse ships every brand's orders, picking store by store is slow,
and a 3PL's numbers become the real stock.

### 11. More sales channels on the same stock (L each)

Mercado Libre, Amazon, and wholesale (Shopify B2B), on the same shared stock and catalog.

**Why for you:** more places to sell the same units without overselling. Mercado Libre leads in
Latin America.

### 12. Smaller additions (S each)

- **Safety buffers per product,** or a percentage, on top of the per-store buffer: a bestseller
  needs a bigger buffer than a slow product.
- **Show which order caused each stock change,** in the activity log. Cheap now that Store Sync
  reads orders.
- **Send purchase orders to suppliers by email** from Store Sync.
- **"Read every store again" button**, to start fresh from the stores' current numbers after
  restoring an old backup (today this takes a few database commands, see
  [operations](operations.md#restoring)).
- **Approval queue** for suspicious changes, such as a large increase typed into a store, held
  until you confirm it.
- **Weekly summary** (top sellers, products at risk, price gaps between brands) and **WhatsApp and
  email alerts built in** (S-M): both easy now that reports exist; today alerts reach them through
  Zapier or Make.

## Later

| Feature                                                     | Why later                                                                       | Effort |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- | ------ |
| Barcode matching and stock counts with a phone              | Matching by SKU works well when SKUs are kept the same, which the catalog does. | M      |
| Country prices and availability per brand (Shopify Markets) | Only if your brands sell abroad.                                                | M      |
| Lot, expiry date or serial number tracking                  | Only for perishable or regulated products.                                      | L      |
| Shopify's newer notification system (Events)                | Richer notifications, but brand new. Classic notifications work well today.     | M      |
| Selling Store Sync to other merchants as a public app       | Needs Shopify's OAuth flow, billing and App Store review.                       | L      |

## Our recommendation

Version 2 built the five features we recommended first. Next, fix the known gaps above, then build
**1 (allocation per brand)** and **2 (returns checked before restocking)**: they protect the shared
stock now that every brand sells from it. Then **3 (automatic exchange rates)**, which keeps your
prices and reports right across currencies, and **4 (team roles)** before more people use Store
Sync. Bundles (5) when you start selling packs, and forecasting (6) once you have 6-12 months of
combined sales.
