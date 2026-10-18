# Prices

Store Sync can set the prices of all your brand stores from one list. You write a **base price**
once per product; each store turns it into its own price with its own **rule** ("Brand B = base ×
1.3, ending in .90"). You can also give a product a **fixed price** in one store, plan **sales**
and **price changes** ahead, and see a preview before anything changes in Shopify.

Nothing changes in your stores until you say so: editing a base price or a rule only changes what
Store Sync _would_ send. Prices reach Shopify when you click **Update prices in stores…** on the
Prices page, when a sale or price change you planned starts or ends, or when you publish a product
from the catalog.

## Words used on this page

| Word             | Meaning                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Base currency    | The currency of your base prices and costs (Settings → Currency, for example USD).                                           |
| Base price       | A product's price in the base currency, before any store's rule.                                                             |
| Exchange rate    | How many units of a store's currency one unit of the base currency is worth ("1 USD = 4,100 COP"). Set on each store's page. |
| Rule             | How a store turns base prices into its prices: multiply, add, round, and the compare-at price.                               |
| Fixed price      | A price for one product in one store that is used whatever the rule says.                                                    |
| Compare-at price | The price Shopify shows crossed out next to the price ("~~$59.99~~ $47.99").                                                 |

## How a store's price is worked out

For each product, in each store:

1. If the product has a **fixed price** in that store, that's the price (and its compare-at price,
   if you gave one). This works even if the store's rule is off.
2. Otherwise, if the store's **rule is off**, Store Sync has no price for it and never changes it.
   You keep setting that store's prices in Shopify.
3. Otherwise, if the product has **no base price**, it is left as it is.
4. Otherwise: base price × exchange rate × multiplier + amount to add, then rounded.

Rounding has three choices:

- **Only to the currency's decimals**: 12.345 USD becomes 12.35; 9,990.4 CLP becomes 9,990.
- **So prices end in…**: a step and an ending. Step 1 and ending 0.90 give prices like 12.90; step
  1,000 and ending 900 give prices like 41,900.
- **To a multiple of…**: step 5 turns 23 into 25; step 0.05 turns 12.34 into 12.35.

Each rounds **up**, **to the nearest** or **down**. A price never rounds below zero: if rounding
down (or to the nearest) would go below zero, it rounds up instead, so a cheap product is never
free.

Examples, with base price 10.00 USD:

| Store                        | Rule                                   | Price      |
| ---------------------------- | -------------------------------------- | ---------- |
| Brand A (USD)                | ×1, ending .99, round up               | 10.99 USD  |
| Brand B (COP, 1 USD = 4,100) | ×1.3, step 1,000, ending 900, round up | 53,900 COP |
| Brand C (CLP, 1 USD = 950)   | ×1, multiple of 10, nearest            | 9,500 CLP  |

The **compare-at price** can be:

- **Converted from the base compare-at price** the same way as the price (the default).
- **The price plus a markup**: 1.25 shows a compare-at price 25% above the price.
- **Left as the store has it**: Store Sync never sends one.
- **None**: Store Sync removes it.

A compare-at price that isn't higher than the price is never sent: Shopify wouldn't show a sale.

The Rules tab shows live examples while you edit a rule, with a few of your own products.

## Getting started

1. **Check the permission.** Updating prices needs the `write_products` permission on each store's
   app (see [Setting up Shopify](setup-shopify.md#permissions-for-the-extra-features)). A store
   without it shows a warning on the Prices page and can't be chosen when updating.
2. **Choose the base currency** in Settings → Currency, and set each store's **exchange rate** on its
   page when its currency is different.
3. **Enter base prices.** Type them in the list, or use **Set base prices from a store…** to copy the
   prices one store charges now (divided by its exchange rate). Pick the store whose prices the
   others follow. Leave "Only products without a base price" on to keep the ones you already set.
4. **Set up each store's rule** on the Rules tab and turn it on.
5. Go back to the Prices tab and choose **Will change** to see every price that would change: what
   the store charges now → what it will charge, and the margin.
6. Click **Update prices in stores…**, check the numbers per store, and confirm.

## Editing prices

- **One product**: type its base price in the list, then **Save base prices** (the bar at the bottom
  appears as soon as something is unsaved, and keeps your edits while you change pages). **Edit…**
  next to it also changes the compare-at price and the cost.
- **Many products**: tick them (or tick none to change every product in the list), then **Change
  prices…**: set an amount, change by a percentage, add or subtract an amount, or round. You can
  round the results ("+10%, ending in .99"). Products without a value are skipped by relative
  changes. Nothing is changed if any result would be negative.
- **A fixed price**: the edit button in a store's column. It replaces the rule for that product in
  that store until you remove it. Add a note to remember why.

The **margin** shown is (price − cost × exchange rate) ÷ price, using the price the store will have.
It needs a cost (Purchasing keeps costs up to date when deliveries arrive).

## Updating prices in your stores

**Update prices in stores…** first shows, for each store, how many prices would change (up and
down), the products without a base price, and every price that **drops by 20% or more**, so a
typo doesn't go live unnoticed. These counts use the prices we last read from each store.

When you confirm, for each store:

1. Store Sync **reads the store's current prices again** from Shopify.
2. It works out each price again (with any change you made in the meantime) and sends **only the
   prices that differ**. Prices are sent as amounts ("set to 12.99"), never as changes ("add
   10%"), so a repeated update can never apply twice.
3. Products Shopify refuses are listed with the reason; the others are updated.

The progress shows at the top of the Prices page, and every update is kept on the **History** tab:
when, why (from the page, a sale, a price change), and per store how many prices were updated,
refused or left as they are.

Good to know:

- Only one update writes to a store at a time. If you start one while a sale is updating that
  store, it waits for it.
- If Shopify can't be reached, Store Sync keeps trying for an hour, then marks that store as failed.
  The other stores aren't affected. Paused stores and stores we can't connect to are skipped and
  marked as failed with the reason.
- An access error from Shopify stops the update for that store with a message about the
  permission. It doesn't affect stock syncing.

## Sales

A sale takes a percentage off the regular price of some products, in some stores (or all), between
two times. Create one on the **Sales & changes** tab with **New sale…**.

When it **starts** (within a minute of its start time), for each product it covers in each store:

- The **regular price** is the price Store Sync would set anyway (the fixed price, or the rule's
  price). Where Store Sync has no price for the product (the store's rule is off, or there is no
  base price), it is the price the store charges in Shopify right then.
- The **sale price** is the regular price minus the percentage, rounded with the store's rule (or
  to the currency's decimals). Rounding never brings the sale price up to the regular price: if it
  would, it rounds down instead.
- If you chose "Show the regular price crossed out", the regular price becomes the compare-at
  price.
- The sale price is saved as a fixed price that belongs to the sale, and your stores are updated.

When it **ends**, everything the sale changed is put back: the fixed price that was there before (if
any) comes back, otherwise the product follows its rule again (with today's base price). In a store
whose rule is off, the price it charged before the sale is put back, but only if it still charges
the sale price.

**Changes you make during a sale are kept.** If you set or remove a fixed price for a product in the
sale, that product leaves the sale in that store, and the end of the sale doesn't touch it. In a
store whose rule is off, a price changed in Shopify during the sale stays as it is.

- **Overlaps are refused**: two sales can't cover the same product in the same store at the same
  time. The message names the other sale.
- **Before it starts** you can edit or cancel it. **While it runs** you can end it now: prices go
  back at once, as when it ends.
- A sale's prices are fixed when it starts. If you change a base price during a sale, the new price
  applies once the sale ends.

## Price changes

A price change sets new base prices (and compare-at prices) for some products on a date: **New
price change…** on the Sales & changes tab. At that time the base prices change for good, and every
store whose rule is on (or that has fixed prices for those products) is updated. Store Sync keeps
a record of the base prices it replaced.

## Times and alerts

Sales and price changes are checked every minute, so they happen within a minute of their time.
Store Sync's worker must be running for that (it is in a normal setup). Times are entered in your
browser's time zone.

You get an alert when:

- **A sale or price change couldn't start** (for example none of its products is sold in its
  stores). It is marked as failed with the reason.
- **A scheduled update couldn't update a store** (paused, no permission, Shopify unreachable for an
  hour). The alert clears the next time prices reach that store, for example when you use **Update
  prices in stores…**.

## What needs which permission

| Permission       | What for                                                  |
| ---------------- | --------------------------------------------------------- |
| `write_products` | Updating prices in a store (and reading its prices back). |
| `read_products`  | Reading the store's prices (every store already has it).  |

Rules, base prices, fixed prices and schedules can all be prepared without the permission; only
sending prices to that store needs it.

## Watch out for

- **A store whose rule is on is managed by Store Sync.** A price changed in that store's Shopify
  admin is changed back the next time you update prices (or a sale starts or ends there). Use a
  fixed price instead, or turn the rule off.
- **Exchange rates don't follow the market.** Changing a store's exchange rate changes what Store
  Sync would send, but nothing is sent until you update prices.
- **Copying base prices from a store** divides by its exchange rate and rounds to the base
  currency's decimals. Converted back without rounding in the rule, a price can come out a cent off.
  Give that store's rule a rounding, or copy from the store in the base currency.
- **Publishing a product from the catalog** sends its prices too (the same prices as here).
- **"Store prices are as we last read them."** The list and the preview use the prices read with the
  regular catalog sync and the last update. The update itself always reads the store again first.

## Limitations

- Only each store's main price (in the store's own currency) is managed. Prices for other countries
  set with Shopify Markets or price lists, and B2B catalogs, are not touched.
- One price per product per store: variants are priced separately (one SKU, one base price), there
  are no quantity breaks.
- Sales take a percentage off. Fixed sale prices per product can be set by hand as fixed prices.
- A price update that fails for some products isn't retried on its own: the history lists them, and
  the next update tries them again.
- The counts of an update reflect what Shopify confirmed. If an update was retried after a network
  error, prices Shopify had already applied the first time count as "already right".
