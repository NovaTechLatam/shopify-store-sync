# Purchasing and reorder suggestions

Store Sync keeps track of the stock you buy: who you buy it from, what you ordered, what arrived,
and what each product costs you. When a delivery arrives you enter it once, and every store's stock
goes up. From your sales, Store Sync also tells you which products will run out before a new
delivery could arrive, and how many to order.

Everything is on the **Purchasing** page, in three tabs: **Orders**, **Reorder** and
**Suppliers**. The last part of this page, [Under the hood](#under-the-hood), is for developers.

## Suppliers

A supplier is a company you buy stock from. For each one you can keep:

- a contact person, an email address and a phone number (they show on printed orders);
- the **currency** they invoice in, for example USD or EUR;
- the **lead time**: how many days a delivery usually takes, from ordering to arriving;
- notes.

Open a supplier to add the **products you buy from them**, with their own code for the product,
their price per unit, a **minimum order** (you must order at least this many) and a **pack size**
(you order in multiples of this, for example boxes of 12).

Each product can have a **preferred supplier**: the one reorder suggestions and draft orders use.
The first supplier you add a product to becomes its preferred supplier; you can change it on the
supplier's page, on the Reorder tab, or on the product's page.

**Changing a supplier's currency** asks first when you have prices from it: they keep their
numbers, now in the new currency (12.50 EUR becomes 12.50 USD), so check them afterwards. Orders
already made keep their own currency.

**Archiving** a supplier takes it out of your lists and stops new orders to it. Its past orders
stay. Products that were ordered from it no longer have a preferred supplier, so choose another
one for them. You can only archive a supplier once its orders are received, closed or cancelled.
A supplier that never had an order can be deleted instead.

## Purchase orders

A purchase order (PO) is what you send a supplier: the products, how many, and at what price. Each
order gets a number (PO-0001, PO-0002...) and goes through these steps:

| Status          | What it means                                               | What you can do                                                              |
| --------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Draft           | You are still preparing it. Nothing counts as ordered yet.  | Change anything, mark it as ordered, delete it.                              |
| Ordered         | You sent it to the supplier. Its units count as "on order". | Receive a delivery, change dates, quantities and prices, close or cancel it. |
| Partly received | Some of it arrived.                                         | Receive more, close it (the rest isn't coming).                              |
| Received        | Everything arrived.                                         | Change its notes, undo a delivery entered by mistake.                        |
| Closed          | Part of it arrived and the rest is no longer expected.      | Change its notes, undo a delivery.                                           |
| Cancelled       | Nothing arrived and nothing will.                           | Change its notes.                                                            |

An ordered or partly received order is marked **Overdue** from the day after its expected date, by
the calendar of your report time zone (Settings > Sales history), not the server's.

To create one, click **New purchase order**, choose the supplier, and click **Add products…** to
search your products (the supplier's products come first, with their price). Prices are filled in
from the supplier's price list, or from what the product cost you before. Save it as a draft, then
click **Mark as ordered** when you send it.

**Currency.** An order is in the supplier's currency unless you change it. When that isn't your
own currency (the one in Settings), enter the **exchange rate**: how many of the supplier's
currency make 1 of yours. Store Sync suggests the rate of your last order in that currency, or the
rate of a store that sells in it. The rate is used to work out what products cost you.

**Once an order is sent**, its supplier, warehouse and currency stay as they are. You can still
change the expected date, the notes, quantities and prices, and add products. A quantity can't go
below what already arrived, and a product that had a delivery on the order (even one you undid)
can't be removed, so the order's list of deliveries stays complete: lower its quantity instead, or
close the order when the rest isn't coming.

**Printing and spreadsheets.** **Print** prints just the order (the menu and buttons are left
out). **Download CSV** gives you the order's products as a spreadsheet.

## Receiving a delivery

When stock arrives, open the order and click **Receive…**. Every product still to come is listed
with the number that is still expected; change the numbers to what actually came (0 for products
that didn't). Click **Receive units**: the units are added to the shared stock and every store
updates within seconds. The order becomes **Partly received** or **Received**.

- **Partial deliveries** are normal: receive what came, and receive the rest when it arrives.
- **More than you ordered?** Store Sync asks you to confirm, then adds all of it.
- **Clicked twice, or the connection dropped?** Each delivery has its own reference, so sending it
  again never adds the units twice.
- **A draft can be received straight away**: it is marked as ordered first.
- The units go to the warehouse the order delivers to.

Some products can't get their units right away:

- **A brand-new product that no store sells yet** starts at 0 plus what you received, as soon as
  a store sells it. Publish it from the [catalog](catalog.md) (or create it in your stores with 0
  in stock): Store Sync then writes the received quantity to every store. A number you type into
  a store for it is replaced.
- **A product a store sells but that hasn't started syncing** (you left it out when you started)
  keeps its delivery waiting. Start it on the **Start syncing** page: the starting number is chosen
  as usual, and the delivery is added on top.
- **While a product's syncing is paused** (or all syncing is), its units are added when you resume.
- **A warehouse no store sells from** (no store location is set to it): the units wait until a
  store's location is set to that warehouse and the product is started there.

The message after receiving tells you when this happens.

### Undoing a delivery

Entered a delivery on the wrong order, or the wrong number? Open the order and click **Undo…**
next to the delivery under **Deliveries**. Its units are taken out of the shared stock again
(every store goes down by that much) and the order goes back to **Ordered** or **Partly
received**. A closed order stays closed. Undoing doesn't change product costs (see below).

## Closing and cancelling

- **Close** an order when part of it arrived and the rest isn't coming. The missing units stop
  counting as on order, so reorder suggestions take that into account.
- **Cancel** an order when nothing arrived and nothing will. Once something was received, close
  it instead.
- **Delete** is only for drafts.

## What products cost

Each product has a **cost**: what one unit costs you, in your own currency. Reports use it for
margins, and Prices for each brand's margin. Every delivery with a price updates it, in one of two
ways (choose in **Settings > Costs**):

- **Average cost** (the default): the stock you already have and the delivery are mixed. With 10
  units at $5.00 and a delivery of 30 at $7.00, the cost becomes $6.50.
- **Last price**: the cost becomes the price of the latest delivery.

Things to know:

- Prices in another currency are converted with the order's exchange rate.
- A product line with no price (0) doesn't change the cost: we don't know what it cost.
- Oversold stock (below 0) counts as none in the average.
- Deliveries that haven't reached the shared stock yet count too: for example two orders of a new
  product received before any store sells it are averaged, not just the last one.
- Undoing a delivery doesn't change the cost back: once later deliveries are mixed in, the old
  average can't be worked out exactly. If it matters, set the cost on the Prices page.

**Copying costs to Shopify.** With **Settings > Costs > Copy costs to Shopify** on, each new cost
is written to every active store's "Cost per item", converted with the store's exchange rate. It
only reaches stores where the product is linked. If a store refuses, you get an alert ("Costs not
sent to Shopify") and nothing else stops. The same switch decides whether publishing a catalog
product sends its cost (see [The catalog](catalog.md)): off, Store Sync never changes "Cost per
item" in Shopify, from deliveries or from the catalog.

## Reorder suggestions

The **Reorder** tab lists the products that will run out before a new delivery could arrive, and
how many to order. It works from:

- **How fast the product sells**, across every store, over the last 30 days (Settings: "Measure
  the sales pace over"). A product that is newer than that is measured since it first appeared,
  so a product launched 5 days ago isn't diluted over 30 days. Test orders, gift cards and
  cancelled orders don't count; refunded units don't count either.
- **The shared stock** you have now (a delivery counts as soon as you receive it, even before the
  stores are updated, for example while all syncing is paused), and the units **on order**
  (ordered or partly received orders; drafts don't count).
- **The lead time**: the product's own (on its page), else its supplier's, else the "Usual
  delivery time" in Settings.

A product **needs reordering** when what you have plus what is on order lasts no longer than the
lead time plus the **safety margin** (Settings, 7 days by default).

The **suggested quantity** is enough to cover the lead time plus the days in **Order enough
for** (Settings, 30 days by default; a product can have its own), minus what you have and
what is on order. It is then raised to the supplier's minimum order and rounded up to whole packs.

> Example: a tee sells 3 a day, you have 30, nothing is on order, and the supplier takes 14 days.
> 30 units last 10 days, less than 14 + 7, so it needs reordering. 3 × (14 + 30) − 30 = 102 units;
> in packs of 12, that's 108.

To order, tick products (or **Select every product that needs reordering**), adjust the numbers,
and click **Create draft orders**: you get one draft per supplier, ready to check and send. Products
without a supplier can't be added that way: click **Choose…** next to them first. When a supplier
invoices in a currency Store Sync has no exchange rate for yet (no earlier order in it, and no store
selling in it), you are asked for the rate first. The **Order** link next to a product opens a
new order with just that product.

**Alerts.** When a product needs reordering, you also get an alert ("Time to reorder") like the
other alerts, for example "TEE-1 will run out in about 9 days at the current pace (3 a day). Lead
time is 14 days. Suggested order: 108 units from Acme." It goes away by itself once the product
has enough stock or enough on order: a little more than just enough, so a product right at the
line doesn't alert you again and again as sales come in. Once the alert is open, the product stays
on the Reorder tab until its stock and what's on order last the lead time plus the safety margin
plus 2 more days (or 10% of those days, if that's more). Turn these alerts off in Settings; the
Reorder tab still works. Store Sync checks every hour, and right after a delivery or an order
change.

**Products left out**: products whose syncing is paused, products that haven't started syncing
(their stock isn't known), and products where you turned off **Suggest reorders for this product**
(for example discontinued ones).

## Shopify permissions

| What                         | Permission needed                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suppliers, orders, receiving | None beyond stock syncing: receiving changes the shared stock, which syncing writes.                                                                                       |
| Copying costs to Shopify     | `write_inventory`, which every connected store already has.                                                                                                                |
| Reorder suggestions          | Sales history, which needs `read_orders` on your stores (see [Setting up Shopify](setup-shopify.md#permissions-for-the-extra-features)). Without it, nothing is suggested. |

## Limitations

- **Reorder suggestions need sales history.** Until your stores' orders are read (Reports), every
  product sells "none" and nothing is suggested.
- **One currency per order**, and exchange rates are what you enter: Store Sync doesn't fetch
  market rates.
- **Deliveries go to one warehouse**, the one the order delivers to. To split a delivery across
  warehouses, make one order per warehouse.
- **Stock in transit isn't shown in Shopify**: Shopify's "incoming" numbers aren't used. Stores
  only change when you receive the delivery here.
- **Costs follow deliveries received here.** If you also change costs in Shopify, the next
  delivery or catalog publish (with "Copy costs to Shopify" on) overwrites them.
- **The sales pace is an average**: seasonal peaks, promotions and stock-outs (no sales because
  nothing was in stock) make it less accurate. Check the suggestion before you order.
- **Changing a draft's currency or supplier** doesn't change the prices of the products already on
  it: check them before you send it.
- **A closed order can't be opened again.** Make a new order for what's still coming.
- **Copying costs to Shopify** was only tested against a stand-in for Shopify, not a real store:
  check "Cost per item" on one product after your first delivery with it on.

## Under the hood

For developers. Code in `src/purchasing/`, routes in `src/http/api/purchasing.ts`
(`/api/purchasing/...`), tables in `migrations/002_catalog_pricing_sales_purchasing.sql`.

- **Receiving** (`receiveOrder`, `src/purchasing/orders.ts`) is one transaction: the order row is
  locked (`FOR UPDATE`), then its lines, then the items in id order, the order every bulk change of
  items uses (`src/db/locks.ts`), so two deliveries, or a delivery and a bulk price edit or a
  catalog save, queue instead of deadlocking. The receipt's `request_id` is unique: the dashboard
  makes one per delivery, so a retried request finds the first receipt (after the order lock) and
  returns it with `200` instead of `201`. For each line a `pool_adjustments` row (`kind 'adjust'`,
  `event_kind 'po_received'`, `details { purchaseOrderId, number, supplierName, receiptId }`) is
  inserted; the sync engine applies it like any adjustment and logs the event with those details.
  A pool level that hasn't started, of an item no store sells, without a pending start, first
  gets an `initialize` (strategy `value`, 0), under the catalog lock (`startUnsoldAtZero` in
  `src/catalog/catalog.ts`, the same rule as a catalog product's first publish). The pool levels
  are enqueued last, in the same transaction; `push_item_costs` tasks too (dedupe key
  `push_item_costs:<storeId>:<receiptId>`).
- **Supplier currency.** `PATCH /suppliers/:id` with a new `currencyCode` answers 409 (with
  `currencyChange: { pricedItems }`) when the supplier has prices, unless the body has
  `confirmCurrencyChange: true`; the prices keep their numbers.
- **Undo** adds the opposite adjustments (`event_kind 'po_receipt_reversed'`) in one transaction;
  a second undo is a no-op.
- **Status changes** are checked on the locked order row. Orders on order are `ordered` and
  `partial`. A line with a `po_receipt_lines` row is never deleted (that would cascade into the
  delivery's history).
- **Draft orders from suggestions** (`createDraftOrders`) take `exchangeRates` (like
  `{ "EUR": 0.92 }`); a currency with neither a given nor a suggested rate is refused with a 400
  listing it in `exchangeRatesNeeded` (with `baseCurrency`), before anything is created.
- **Reorder** (`src/purchasing/reorder.ts`): `computeReorder` is the pure maths;
  `loadReorderRows` reads every input with one query; `runReorderCheck` opens or resolves alerts
  `reorder:<itemId>` (kind `reorder`). An open alert raises the line by `reorderCloseMargin`
  (max(2 days, 10% of lead + safety)) until it closes, so it doesn't flap; the Reorder tab uses the
  same figures. The `reorder_check` task (a singleton) runs it; the hourly
  job and every change that affects it enqueue the task.
- **Costs** (`src/purchasing/costs.ts`): `nextItemCost` (pure; the receipt passes it the started
  pool levels plus the item's pending `adjust` adjustments as the stock before) and the
  `push_item_costs` task (`inventoryItemUpdate`, absolute values, so retries are harmless; a
  permission error raises `cost_push_failed:<storeId>` and stops instead of retrying).
