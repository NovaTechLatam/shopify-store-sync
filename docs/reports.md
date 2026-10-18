# Reports

Reports show the sales of all your brands together: revenue, units, orders and margin, how each
store compares, and how each product is selling against the stock you have. The first part of this
page is for anyone. The last part, [Under the hood](#under-the-hood), is for developers.

## Where the numbers come from

Store Sync keeps its own copy of every store's orders: the products, quantities and amounts. It
never reads customers' names, addresses, emails or phone numbers.

- **When a store is connected**, Store Sync imports its order history from Shopify. That usually
  takes a few minutes. Meanwhile, new orders are counted already.
- **After that**, Shopify tells Store Sync about new orders, refunds, edits and cancellations as
  they happen ("live updates"), and Store Sync also checks every store for changed orders every
  15 minutes, in case a notification was missed.

A refund or a cancellation made a month after the sale changes that sale's numbers, on the day of
the sale. Reports always show the orders as Shopify has them now.

## Turning it on

Reading orders needs a permission that stock syncing doesn't: `read_orders`. Without it, Reports
shows the steps to give it, and stock keeps syncing as before.

1. Add `read_orders` to your app's permissions, as described in
   [Permissions for the extra features](setup-shopify.md#permissions-for-the-extra-features).
   Add `read_all_orders` too if you want sales older than 60 days (see
   [How far back sales go](#how-far-back-sales-go)).
2. Release the new app version and approve it in **each** store's Shopify admin.
3. In Store Sync, open each store and click **Test connection**. The history import starts within
   a minute.

The store's page shows, under **Permissions for extra features**, whether Reports is allowed.

**Live updates need one more step for some apps.** Orders contain customer information, so
Shopify may refuse to send order notifications until your app says how it uses that data. Store
Sync then raises the alert "No live sales updates". Reports still work, but new orders show up
within 15 minutes instead of right away. How to fix it is under **Live sales updates** in
[Permissions for the extra features](setup-shopify.md#permissions-for-the-extra-features).

## Using the Reports page

**Period.** Pick _Last 7 days_, _Last 30 days_, _This month_, _Last month_, _Last 90 days_, or a
_Custom range_ with a start and an end date (both included). The period, the stores you picked and
the sorting are kept in the page's address, so you can bookmark or share a report.

**Stores.** _All stores_, or click one or more stores to see only them. Each store keeps the same
colour everywhere on the page.

**Totals.** Revenue, units sold, orders and margin for the period, in your base currency
(Settings > Currency).

**Revenue chart.** Revenue per day, stacked by store. Periods longer than 3 months are shown by
week, and periods longer than 2 years by month. Screen readers get the same numbers as a table.

**By store.** Each store's orders, units and revenue in its own currency, converted to your base
currency, its share of the total, and its margin.

**By product.** One row per product that sold in the period or has stock now. Search by SKU or
name, and sort by revenue, units, margin, days of stock left or sell-through: click a column's
name, or use **Sort by** (on a phone, the only way). Click a product to open it. **Download CSV**
downloads every row of the table as it is (same period, stores, search and sorting).

Sales of a SKU that isn't one of your products (gift wrapping, a product that was never matched)
show as "Not one of your products". Once the SKU is matched to a product, its past sales move to
that product within a minute.

**Sales history by store** says, for each store, how far back its sales go, whether its history is
still being imported, and when it was last checked. While a history is being imported, the page
looks again every 15 seconds and fills in by itself when the import is done. **Import again…**
reads the store's history from Shopify once more: useful after you give Store Sync the
`read_all_orders` permission, or after an import that didn't work. Sales already in your reports
stay while it runs.

It also tells you when a store in another currency still has the exchange rate 1 (for example
1 USD = 1 COP): its sales then count one for one in your base currency, which makes the totals
wrong. Set the rate on the store's page. And if Store Sync loses the permission to read a store's
orders, the sales it read before stay in your reports; only the newest ones are missing.

**Product page.** Each product's page has a **Sales in the last 30 days** card: units and revenue
per store, units per day, and days of stock left, with a link to the product in Reports.

## How each number is worked out

| Number             | What it means                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revenue            | What customers paid for products after discounts and refunds, **before tax and shipping**.                                                                                        |
| Units sold         | Units ordered, minus the ones refunded or removed from the order.                                                                                                                 |
| Orders             | Orders placed in the period. Test and cancelled orders are left out.                                                                                                              |
| Margin             | (Revenue − cost) ÷ revenue, only over the sales that have a cost. The tile tells you how much revenue had no cost.                                                                |
| Per day            | Units sold per day over the last 30 days (Settings > Reorder planning, sales pace), in **every** store, whatever period or stores you picked. The Reorder tab uses the same pace. |
| Days of stock left | The shared stock now ÷ units per day. "Out of stock" when there is none left.                                                                                                     |
| Sell-through       | Units sold in the period ÷ (units sold + stock now): how much of what you had sold. 80% means a fifth is left.                                                                    |

Some details:

- **Days.** A sale counts on the day its order was placed, in the report time zone (Settings >
  Sales history; by default your first store's time zone). An order placed at 11:30 pm in Bogotá
  counts on that day, even though it is already the next day in UTC. The same time zone decides
  "today" elsewhere too: when a purchase order is overdue, and the day stock runs out on the
  Reorder tab. Settings only accepts a time zone the database knows (a name like America/Bogota).
- **Currencies.** Each store's amounts are in that store's currency (what Shopify calls the shop
  currency, whatever currency the customer paid in). Totals convert them to your base currency
  with each store's exchange rate **as it is now** (on the store's page). If you change a rate,
  past reports change with it: Store Sync doesn't keep a history of rates.
- **Costs.** Each sale keeps the product's cost from when Store Sync first saw it, so a later
  change of cost doesn't rewrite past margins. Sales that came in before the product had any cost
  take the first cost you give it.
- **Left out:** test orders, cancelled orders and gift cards (they aren't products you stock).
- **A store you remove** takes its sales history with it (see
  [Removing a store](operations.md#removing-a-store)).
- **Per day** doesn't spread a product's sales over days before it first appeared (added to Store
  Sync, or its first sale if that is earlier), nor over days before your history starts, and it
  only counts the sales of those days. Right after you install Store Sync, a product sold for
  months is measured over the history read so far. It is shown like on the Purchasing card: one
  decimal below 10 a day, and "<0.1" for a product that sells only now and then.
- **Days of stock left** use the shared stock as the sync has it. A delivery you just received
  counts a few seconds later (or when syncing resumes, if it's paused), while the Reorder tab
  counts it at once.

## How far back sales go

Shopify only lets apps read the orders of the **last 60 days**, unless the app has the
`read_all_orders` permission. Shopify must approve your app for that permission first (under
**API access requests** in your app's settings; see
[Setting up Shopify](setup-shopify.md#permissions-for-the-extra-features)).

- The history import reads as far back as **Settings > Sales history > Read sales from the last
  (days)** says, but never more than 60 days without `read_all_orders`. Reports then says
  "Shopify gives the last 60 days of orders without the “read all orders” permission".
- If you pick a period that starts before a store's history, Reports tells you that the first
  days of the period have no sales from that store.
- After you get `read_all_orders`, or raise **Read sales from the last (days)**, open Reports and
  click **Import again…** for each store: changing the setting doesn't import anything by itself.
- Without `read_all_orders`, a refund made today on an order older than 60 days doesn't reach
  Reports: Shopify won't show Store Sync that order any more.

If the import from Shopify fails, Store Sync raises the alert "Order history not imported" and
reads the orders page by page instead. That takes longer but gets there: once it has read the
whole history, the store shows as complete in Reports and the alert goes away. You can also try
the import again from Reports. [Operations](operations.md#order-history-import) says what to do if
an import never starts.

## Things to know

- **Taxes.** Revenue is before tax. For stores whose prices include tax (common in Europe and
  Latin America), Store Sync relies on Shopify's "after discounts, before taxes" amount of each
  line. We couldn't confirm on a live tax-inclusive store that it never contains tax, so compare
  one order with Shopify's own report when you start.
- **Shipping, duties and tips** are not in revenue.
- **Orders** include an order that only had a gift card, as Shopify's own reports do, while the
  gift card itself isn't revenue.
- **Shopify's own analytics** may differ a little: Shopify dates a refund on the day of the refund,
  Reports on the day of the sale.
- **Deleted orders** disappear from Reports when they are deleted in Shopify.
- **A paused store** keeps its past sales; new ones come in again when you resume it.
- **The CSV** opens in Excel, Numbers and Google Sheets. Text that starts like a formula (`=`,
  `+`, `-`, `@`) gets an apostrophe in front, and text with a semicolon is quoted (for spreadsheets
  that split on semicolons), so opening the file can never run anything. Money is in each
  currency's own decimals. **Cost** only covers the sales that have a cost, and is empty when none
  has: work out profit as **Revenue with a cost** − **Cost**, not from the whole revenue. A store
  whose orders Store Sync may not read has empty cells.

## Under the hood

Code: `src/sales/` (ingestion, sync, history import, report queries), `src/http/api/reports.ts`,
`public/js/views/reports.js`. Schema: `sales_orders` and `sales_lines` in
`migrations/002_catalog_pricing_sales_purchasing.sql`, plus `migrations/005_sales.sql`.

**Ingestion** (`src/sales/ingest.ts`). `upsertOrder` writes an order and its lines in one
transaction. The order row is upserted with `ON CONFLICT … DO UPDATE … WHERE
stored.shopify_updated_at <= new.updatedAt`, so an older copy never overwrites a newer one, and
concurrent copies of one order are written one after the other (the row stays locked until
commit). A batch of orders (`ingestOrders`, 100 per transaction) is written in order of order
id, so two batches that share orders (the import and a sync page) lock them in the same order and
can't deadlock. Lines no longer on the order are deleted. Each line maps to an item through the
store's variant (as matched on the Matching page; a variant unlinked by hand stays unmapped), else
through its normalised SKU. `unit_cost` is the item's cost when the line is first seen and is
kept on updates (filled in later when it was NULL). A deleted order keeps its row with `deleted_at`
and no lines, so a copy read before the deletion can't bring it back (both go through the same
unique key).

**Tasks** (`src/sales/sync.ts`, `src/sales/tasks.ts`).

- `refresh_order` (orders/create, updated, cancelled and refunds/create webhooks): reads the order
  and upserts it. An order Shopify won't return (older than 60 days) is left as it is.
- `remove_order` (orders/delete): writes the deletion marker, even while the store is paused.
- `sync_orders`: reads orders updated since `stores.orders_synced_at` minus 10 minutes, oldest
  update first, and moves `orders_synced_at` forward after each page. After about 4 minutes it
  saves where it stopped (`orders_sync_since` and Shopify's page cursor), queues itself again and
  ends, so one big store never hogs a worker and thousands of orders changed at the same moment
  are still read once. A cursor Shopify no longer takes makes the next run start over.
- `sales_backfill`, a state machine on `stores.sales_backfill_status`: `none` → start a bulk
  export of the orders updated in the window (`salesHistoryDays`, at most 60 without
  `read_all_orders`) → `running`: poll the operation, again in 45 seconds while it runs →
  `COMPLETED`: download the JSONL with `fetchFn`, parse it (line items may come before their
  order; they are joined on `__parentId`), upsert in batches of 100 orders, set
  `orders_synced_at` to the export's start minus 10 minutes → `done`. `FAILED`, `CANCELED`,
  `EXPIRED`, an operation Shopify no longer knows, or an expired file (HTTP 4xx) → `failed`, alert
  `sales_import_failed:<store>`, and `sync_orders` reads the window page by page; the first sync
  pass that started at or before `sales_history_from` and reached the last page sets the status
  to `done` and resolves the alert. A 0-object export has no file: `done`. The
  `bulk_operations/finish` webhook runs a check right away. A task can't push its own next run
  later (re-queuing its own key makes it run again at once), so delayed checks alternate between
  the plain key and a `poll: true` one. Only one check per store runs at a time
  (`pg_try_advisory_lock(LOCK_CLASSES.salesBackfill, storeId)` on a dedicated connection; every
  lock id is listed in `src/db/locks.ts`), so the file is downloaded once. A non-permission error
  starting the export is thrown, so the task runner retries it with backoff; the status stays
  `none` meanwhile, so `sync_orders` isn't queued for that store.
- Permissions: without `read_orders` (as last read from Shopify) no task calls Shopify. An
  `ACCESS_DENIED` from Shopify records the problem on the store's sales columns
  (`sales_backfill_error`, `orders_sync_error`) and ends the task; it never marks the store as
  broken. A refused import goes back to `none` and starts again once the store's permissions have
  been read again (`scopes_checked_at > sales_backfill_finished_at`).

**Scheduler** (`src/sales/jobs.ts`). Every minute, `sales_orders` looks at the active stores
whose last-read scopes include `read_orders` (a store whose scopes were never read waits for the
next check). It queues `sync_orders` for those whose import is done (or failed) and whose
`orders_checked_at` is 15 minutes old, and
`sales_backfill` for stores waiting to import (or with a running import whose next check got
lost). Tasks are de-duplicated and "due" lives in the database, so several instances don't add
runs. Housekeeping maps unmatched lines once products or variants change, and fills in missing
costs.

**Report queries** (`src/sales/reports.ts`). Days are bucketed by Postgres
(`(processed_at AT TIME ZONE tz)::date`), so the setting is checked against `pg_timezone_names`
when it is saved (a name only Node knows is refused with a 400). `reportTimezone` and
`reportToday` (`src/settings.ts`) give every feature the same zone and "today". The period's
bounds are local midnights turned into instants, so the `(store_id, processed_at)` indexes of
`sales_lines` and `sales_orders` are used. Orders are counted from `sales_orders` (counting
distinct orders of the lines needs a big sort). Amounts are summed per store, then divided by the
store's exchange rate. The products report sums lines per item and store, adds the stock (Σ
started pool levels) and the pace (`src/sales/pace.ts`, shared with the Reorder tab: units over
`reorderLookbackDays` in every store, divided by the days the window really covers), then sorts and pages. On 600,000 lines (3 stores, a year), the
summary took about 0.1 s for 30 days and 0.5 s for a year, and the products report 0.3 to 0.7 s.
