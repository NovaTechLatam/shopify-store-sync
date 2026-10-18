# Setting up Shopify

Store Sync needs permission to read your products and to read and change stock in each of your
stores. You give it that permission with a small private app that only you use. Nothing is
published on the Shopify App Store.

The catalog, prices and reports need a few more permissions. They are optional, and you can add
them now or later: see [Permissions for the extra features](#permissions-for-the-extra-features).

There are two ways to do this:

- **Option A: one Dev Dashboard app for all your stores (recommended).** Use it for new setups.
- **Option B: an existing custom app.** Use it only if a store already has a custom app that was
  made in its admin before Shopify stopped allowing new ones.

You can mix them: some stores on option A, others on option B.

## Before you start

You need:

- To be the **store owner** of every store.
- The **myshopify.com address** of each store, for example `mybrand.myshopify.com`. To find it,
  open the store's admin. The web address looks like `admin.shopify.com/store/mybrand`. Your
  address is then `mybrand.myshopify.com`.
- About 15 minutes.

Check your products:

- The same product has the **same SKU** in every store. Upper/lower case and spaces don't matter.
- A SKU is used **only once** in each store.
- **Track quantity** is turned on for the products you want to sync.
- **No other stock sync app** is running on these stores. Two sync apps would fight over the
  numbers.

You can fix SKUs later: the **Matching** page in Store Sync lists everything that didn't match.

## Option A: one Dev Dashboard app (recommended)

### Step 1: Put your stores in one organization

The app can only connect to stores that belong to the same Shopify organization as the app.

**On Shopify Plus?** Your stores are already in one organization. Go to step 2.

**Otherwise**, group your stores:

1. Open the admin of one of your stores.
2. Go to **Settings > General > Store transfer**.
3. Choose **Transfer to an organization you own**.
4. Give the organization a name, add your other stores and confirm.

This only works if:

- You are the store owner of every store.
- You have at least 2 stores.
- All stores pay their Shopify bill in the **same currency**. You can't change this later.

Moving stores into an organization moves billing permissions to the organization owner. Staff
lose any organization-level roles they had, so check your staff's access afterwards.

A store that can't join (for example, it is billed in another currency) can still be connected. See
[Stores in different organizations](#stores-in-different-organizations).

### Step 2: Create the app

1. Go to [dev.shopify.com/dashboard](https://dev.shopify.com/dashboard). You can also get there
   from a store's admin: **Settings > Apps and sales channels > Develop apps**.
2. At the top of the page, check that the organization is the one that holds your stores.
3. Click **Apps > Create app > Start from Dev Dashboard**.
4. Name it `Store Sync` and click **Create**.

### Step 3: Give the app its permissions

1. In the app, open **Versions** and create a new version.
2. **App URL**: leave the default.
3. **Webhooks API version**: choose `2026-10`.
4. **Scopes**: add these four:
   - `read_products`
   - `read_inventory`
   - `write_inventory`
   - `read_locations`
5. If you want the extra features, add their scopes too (see
   [Permissions for the extra features](#permissions-for-the-extra-features)). You can also add
   them later.
6. Click **Release**.

### Step 4: Install the app on every store

1. Open the app's home page and find the **Installs** card.
2. Click **Install app**. A new browser tab opens.
3. Choose your first store and click **Install**.
4. Repeat for every other store.

### Step 5: Copy the app's keys

1. In the app, open **Settings**.
2. Copy the **Client ID** and the **Client secret**.

The same two keys work for all your stores. Treat the client secret like a password: anyone who
has it can change your stock.

### Step 6: Add each store to Store Sync

1. In the Store Sync dashboard, go to **Stores > Add store**.
2. Choose **Dev Dashboard app (recommended)**.
3. **Name**: the brand name you want to see in Store Sync.
4. **Store address**: for example `mybrand.myshopify.com`.
5. Paste the **Client ID** and the **Client secret**.
6. Click to add the store. Store Sync tests the connection first and tells you if something is
   wrong (see [Troubleshooting](#troubleshooting)).
7. Repeat for every store, with the same Client ID and Client secret.

That's it. Store Sync now reads each store's products and locations. It also asks Shopify to send
it a notification whenever stock changes. You don't need to set up anything under
**Settings > Notifications** in Shopify.

Shopify gives the app a new access pass every 24 hours. Store Sync renews it automatically, so
you never have to do anything.

### Later: when a new permission is needed

If a future version of Store Sync needs a new permission, or you want to turn on an
[extra feature](#permissions-for-the-extra-features):

1. In the Dev Dashboard, create a new app version with the new scope, as well as every scope the
   app already has, and click **Release**.
2. Open the admin of **each** store and approve the new permission. Shopify does not approve it for
   you.
3. In Store Sync, open each store and click **Test connection**. Store Sync also notices on its
   own within 15 minutes.

### Stores in different organizations

If a store can't join your organization, create a second app in the same way, inside that store's
own organization. Use that app's Client ID and Client secret when you add that store. Test
connection tells you right away whether it works.

## Permissions for the extra features

Syncing stock only needs the four scopes above. The catalog, prices and reports need more. They
are optional: without them a feature is simply off for that store, and stock keeps syncing. You can
give them to some stores and not others. Each store's page in Store Sync shows, under
**Permissions for extra features**, what its app allows and what's missing.

| Scope                | What it turns on                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write_products`     | **Catalog**: publish the products you write in Store Sync to the store (titles, descriptions, images, variants, prices). **Prices**: update the store's prices from your price rules, fixed prices and sales.          |
| `write_publications` | Show the products you publish in the store's **Online Store** sales channel (it includes `read_publications`, which Store Sync uses to find that channel). Without it, publishing still works: you show them yourself. |
| `read_orders`        | **Reports**, **reorder suggestions** and **reorder alerts**: Store Sync reads the store's orders (products, quantities and amounts; never customers' names, addresses, emails or phone numbers).                       |
| `read_all_orders`    | Optional, on top of `read_orders`: sales history older than 60 days. Needs Shopify's approval first (see below).                                                                                                       |

Purchasing needs no extra permission: receiving a delivery changes the shared stock, which syncing
already writes, and copying costs to Shopify uses `write_inventory`, which every store has.

**Adding them.** For a Dev Dashboard app (option A), follow
[Later: when a new permission is needed](#later-when-a-new-permission-is-needed). For an existing
custom app (option B), add them to the app's **Admin API scopes** in the store's admin and save,
then click **Test connection** in Store Sync. Reports start importing the store's order history
within a minute of Store Sync seeing `read_orders`.

**Order history older than 60 days.** With `read_orders` alone, Shopify only lets apps read the
orders of the last 60 days, so Reports and the sales pace start with those. `read_all_orders`
removes the limit, but Shopify must approve your app for it first: request it under **API access
requests** in your app's settings (Dev Dashboard or Partner Dashboard). Until it's approved, an
app version that includes it can't be released, so add it to the scopes only once Shopify has said
yes. Then click **Import again…** for each store on the Reports page (see
[Reports](reports.md#how-far-back-sales-go)).

### Live sales updates and customer data

With `read_orders`, Store Sync also asks Shopify to tell it about new orders, edits, cancellations
and refunds as they happen. Orders contain customer information ("protected customer data"), so
Shopify may refuse until the app says how it uses that data. Store Sync then raises the alert
“Shopify didn't allow live sales updates for …” (**No live sales updates** on the Alerts page).

Nothing breaks meanwhile: Reports and reorder suggestions still work, because Store Sync checks
every store for changed orders every 15 minutes. New orders just show up within 15 minutes instead
of right away.

To fix it, for a Dev Dashboard app:

1. Open the app in the Dev Dashboard and go to **API access > Protected customer data access**.
2. Request access to protected customer data **without** the name, email, phone and address fields:
   Store Sync never reads them.
3. Describe the use: sales reports and stock planning for your own stores. Store Sync reads each
   order's products, quantities, amounts and dates, keeps them on your own server, and shares them
   with no one.
4. Release the new app version and approve it in each store's admin.

Store Sync tries again every 15 minutes (or click **Reconnect live updates** on the store's page),
and the alert goes away once Shopify accepts. Shopify's forms and rules for this differ by app type
and change from time to time: this is what we expect for a Dev Dashboard app, so follow what your
app's settings show. An existing custom app (option B) usually has this access already.

## Option B: an existing custom app (legacy)

Shopify no longer lets you create custom apps in the store admin, but existing ones keep working.
Use this option only for a store that already has one.

1. Open the store's admin and go to **Settings > Apps and sales channels > Develop apps**. On some
   stores the list is called **Legacy custom apps**.
2. Open your app and check its **Admin API scopes**. It needs `read_products`, `read_inventory`,
   `write_inventory` and `read_locations`. Add any that are missing and save. For the extra
   features, also add [their scopes](#permissions-for-the-extra-features), now or later.
3. Open **API credentials** and copy two things:
   - The **Admin API access token**.
   - The **API secret key**. Store Sync uses it to check that stock notifications really come from
     Shopify. Without it, the store's notifications are ignored and changes are only picked up by
     the 15-minute check.
4. In Store Sync, go to **Stores > Add store** and choose **Existing custom app (legacy)**.
5. Paste the access token and the API secret key, then add the store.

> **Never delete this app in Shopify.** It can't be created again.

If the access token isn't shown any more, the only way to get a new one is to uninstall and
reinstall the app in Shopify. Syncing for that store stops until you paste the new token in Store
Sync, in the store's page.

## Troubleshooting

| What you see                                                                  | What it means                                                                                                  | What to do                                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shop_not_permitted` or "Client credentials cannot be performed on this shop" | The store is not in the same organization as the app.                                                          | Do [step 1](#step-1-put-your-stores-in-one-organization), or create a [separate app](#stores-in-different-organizations) for that store.                                                    |
| "The app is missing these permissions: …"                                     | The app's version doesn't have all four scopes, or the store hasn't approved them yet.                         | Add the scopes in a new app version and release it. Approve them in **each** store's admin. Then click **Test connection**.                                                                 |
| “… hasn't given Store Sync permission to …”                                   | A feature (catalog, prices, reports) needs a permission that store's app doesn't have.                         | Add the scope named in the message ([extra features](#permissions-for-the-extra-features)), approve it in that store's admin, then click **Test connection**.                               |
| Alert: “Shopify didn't allow live sales updates for …”                        | Shopify refused to send order notifications, usually because the app hasn't declared its customer data use.    | Reports keep working with a 15-minute delay. See [Live sales updates and customer data](#live-sales-updates-and-customer-data).                                                             |
| Releasing an app version fails because of `read_all_orders`                   | Shopify hasn't approved your app for that permission yet.                                                      | Remove it from the scopes, release, and add it back once Shopify approves your request (see [extra features](#permissions-for-the-extra-features)).                                         |
| Alert: "Order history not imported"                                           | Shopify's export of a store's orders failed or expired.                                                        | Nothing to do: Store Sync reads the orders page by page instead. You can also click **Import again…** on the Reports page. See [operations](operations.md#order-history-import).            |
| Alert: "Publishing failed" or "Prices not updated"                            | Shopify refused a product or a price, or the store was paused or missing a permission.                         | The alert says why. See [the catalog](catalog.md#what-to-watch-out-for) and [prices](pricing.md#updating-prices-in-your-stores).                                                            |
| Alert: "Costs not sent to Shopify"                                            | The app isn't allowed to change that store's inventory items.                                                  | Check the store's connection with **Test connection**. Costs are only sent with **Settings > Costs > Copy costs to Shopify** on.                                                            |
| "Invalid API key or access token", or a 401 error                             | The keys are wrong or no longer valid (the client secret was changed, or the app was reinstalled).             | Copy the keys again and paste them in the store's page in Store Sync.                                                                                                                       |
| The store's status is **Error**                                               | Shopify refused the keys, or the store was unavailable.                                                        | Store Sync tests the store again every 5 minutes and resumes on its own once it works. If the keys changed, paste the new ones in the store's page.                                         |
| The store's status is **Disconnected**                                        | The app was uninstalled from that store.                                                                       | Install the app again (option A: **Installs** card; option B: reinstall it in the store admin). Paste new keys if they changed, then resume the store from its page.                        |
| Alert: "Shopify had stopped sending stock updates for …"                      | Shopify deletes an app's notifications after many failed deliveries, for example while Store Sync was offline. | Nothing to do: Store Sync checks every 15 minutes and creates them again, and the regular stock check catches anything missed. If it keeps happening, check that `PUBLIC_URL` is reachable. |
| Alert: "Shopify did not notify us about … stock changes"                      | Changes were found by the 15-minute check instead of a notification.                                           | They are already synced. If it happens often, check that `PUBLIC_URL` is reachable from the internet.                                                                                       |
| Server log: "no API secret key is saved for this store"                       | A legacy store was added without its API secret key.                                                           | Paste the API secret key in the store's page in Store Sync.                                                                                                                                 |
| Alert: "Choose which location of … holds the shared stock"                    | The store has more than one location, so Store Sync can't guess which one to use.                              | Open the store's page in Store Sync and pick the location that holds the shared stock.                                                                                                      |
| "SKU … is not stocked at the synced location of …"                            | The product isn't set up to be stocked at that location in Shopify.                                            | Store Sync normally fixes this itself. If it stays, open the product in Shopify and turn on that location in its inventory settings.                                                        |
| A product doesn't sync                                                        | It has no SKU, its SKU is used twice in one store, it's a bundle, or **Track quantity** is off.                | Open **Matching** and **Products** in Store Sync: they show the reason.                                                                                                                     |
| Shopify's inventory history shows "Correction" changes made by the app        | That's Store Sync updating the number.                                                                         | Nothing to do. This is normal.                                                                                                                                                              |
