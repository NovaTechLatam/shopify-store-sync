# Operations

How to run Store Sync in production: deploying, configuration, database size, backups, upgrades,
monitoring, background work, the order history import, and what to do when something looks wrong.

## What you need

- **An always-on server or hosting plan.** Shopify expects an answer to every notification within 5
  seconds, and the background sync must keep running. Plans that put the app to sleep when nobody
  visits it won't work.
- **HTTPS on a public address.** Shopify only sends notifications to HTTPS addresses.
- **PostgreSQL 16** (what Store Sync is tested with). For stock syncing alone the database stays
  small. Images you upload to the catalog and the order history of Reports make it grow: see
  [Database size](#database-size).
- About 1 CPU and 1 GB of memory is plenty, even for several stores with thousands of products.
  The first import of a store's order history holds the whole export in memory while it saves it:
  about 100 MB per 100,000 orders. For a store with more than a few hundred thousand orders in the
  history you import, give the app 2 GB.

## Deploying

### Option 1: your own server with Docker Compose (recommended)

This runs Store Sync, its database and [Caddy](https://caddyserver.com) on one small Linux server.
Caddy gets a free HTTPS certificate and renews it on its own.

1. **Rent a small server** with Ubuntu (1 CPU, 1-2 GB of memory), from any provider.
2. **Point a domain at it.** In your domain's DNS settings, add an `A` record such as
   `sync.mybrand.com` with the server's IP address.
3. **Install Docker** on the server:

   ```sh
   curl -fsSL https://get.docker.com | sh
   ```

4. **Get the code and create the settings file:**

   ```sh
   git clone <your copy of this repository> /opt/storesync
   cd /opt/storesync
   cp .env.example .env
   ```

5. **Fill in `.env`.** Set `PUBLIC_URL=https://sync.mybrand.com` (your domain), `ENCRYPTION_KEY`,
   `ADMIN_PASSWORD` and `POSTGRES_PASSWORD`. The comments in the file explain each one.
6. **Open ports 80 and 443** in the server's firewall, if it has one. Caddy needs both.
7. **Start everything:**

   ```sh
   docker compose --profile https up -d --build
   ```

8. Open `https://sync.mybrand.com` and log in. The certificate can take a minute the first time.

Port 3000 is only reachable from the server itself. Everyone else goes through Caddy, so the
dashboard password never travels unencrypted.

Useful commands (run them in `/opt/storesync`):

| Command                                        | What it does                                       |
| ---------------------------------------------- | -------------------------------------------------- |
| `docker compose ps`                            | Shows whether everything is running and healthy.   |
| `docker compose logs -f app`                   | Shows the app's log as it happens.                 |
| `docker compose --profile https up -d`         | Applies changes made to `.env` (restarts the app). |
| `docker compose --profile https up -d --build` | Rebuilds and restarts after updating the code.     |
| `docker compose --profile https down`          | Stops everything. Your data is kept.               |

### Option 2: Render

[render.yaml](../render.yaml) sets up a web service (Starter plan) built from the Dockerfile, and a
Postgres database (Basic 256 MB) that is not reachable from the internet.

1. Put this repository in your GitHub account.
2. In Render, choose **New > Blueprint** and pick the repository.
3. Render asks for two values:
   - `PUBLIC_URL`: your service's address, normally `https://storesync.onrender.com`. Once the
     service exists, check the real address at the top of its page. If it's different, update
     `PUBLIC_URL` in the service's **Environment** tab. Shopify notifications follow the new
     address on their own within 15 minutes.
   - `ADMIN_PASSWORD`: at least 12 characters.
4. Render generates `ENCRYPTION_KEY` for you. Open the service's **Environment** tab and copy it to
   your password manager: you need it to use a database backup.
5. To use your own domain, add it under the service's **Settings > Custom Domains**, then set
   `PUBLIC_URL` to it.

Render deploys again each time you push to the repository. Don't move the service to the free
plan: free services fall asleep.

### Other hosts (Railway, Fly.io...)

Any host that runs a Dockerfile, keeps it running and gives it HTTPS works. Set the variables from
[.env.example](../.env.example) (`DATABASE_URL`, `PUBLIC_URL`, `ENCRYPTION_KEY`, `ADMIN_PASSWORD`),
expose port 3000, and use `/healthz` as the health check.

- **Railway:** create a project from your GitHub repository (Railway uses the Dockerfile), add a
  PostgreSQL database and set `DATABASE_URL` to `${{Postgres.DATABASE_URL}}`. Generate a domain
  under **Settings > Networking** and use it as `PUBLIC_URL`. Leave app sleeping (serverless) off.
- **Fly.io:** run `fly launch --no-deploy`, create a Postgres database, and set the variables with
  `fly secrets set`. In `fly.toml`, set `internal_port = 3000`, `auto_stop_machines = "off"` and
  `min_machines_running = 1`, so the app never stops. Then run `fly deploy`.

## Configuration

Every variable is listed, with its default, in the [README](../README.md#configuration) and
[.env.example](../.env.example). Changes take effect when the app restarts. The catalog, prices,
reports and purchasing need no variables of their own.

Everything that changes while you run your business (pausing sync, alert destinations, low-stock
level, safety buffers, the circuit breaker limit, the base currency and each store's exchange
rate, reorder planning, how costs are worked out) is set in the dashboard and takes effect
immediately.

## Database size

Three things make the database grow:

- **Images you upload to the catalog** are stored in the database, at their full size (up to
  20 MB each), once per file however many products and brands use it. 1,000 photos of 2 MB take
  2 GB. An upload no product uses is deleted once it's a day old. Images imported from a store or
  added by web address aren't stored: Store Sync keeps their address only.
- **Order history** (Reports): about 1 KB per order of two products, indexes included, so
  100,000 orders take about 100 MB. It is never deleted: it is your sales history, and the oldest
  part can't be read from Shopify again without `read_all_orders`.
- **The activity log**, kept for 180 days by default (**Settings > History**).

Prices, suppliers and purchase orders stay small. To see how big the database is and what takes
the space:

```sh
docker compose exec -T db psql -U storesync -d storesync -c "
  SELECT relname AS table, pg_size_pretty(pg_total_relation_size(oid)) AS size
    FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
   ORDER BY pg_total_relation_size(oid) DESC LIMIT 8"
```

Leave room on the disk for the backups too (they grow with the images). On Render and other
managed databases, check the storage size of your plan and raise it before it fills up.

## Backups

Back up two things:

1. **The database.** It holds your store connections (with their keys encrypted), product
   matching, shared quantities, settings and the activity log, and also your catalog (with the
   images you uploaded), prices and price rules, suppliers, purchase orders, costs and sales
   history. Much of that exists nowhere else: not in Shopify, and not on your computer.
2. **`ENCRYPTION_KEY`**, kept somewhere else, such as your password manager. Without it the store
   keys in a backup can't be read, and every store has to be connected again.

Backups include the uploaded images, so a backup file is roughly as big as the database (images
don't compress). Check that 30 of them fit on the disk, or keep fewer.

With Docker Compose, this writes a backup file:

```sh
mkdir -p backups
docker compose exec -T db pg_dump -U storesync -d storesync --format=custom > backups/storesync-$(date +%F).dump
```

To make one every night at 3:00 and keep 30 days, add this with `crontab -e`:

```cron
0 3 * * * cd /opt/storesync && docker compose exec -T db pg_dump -U storesync -d storesync --format=custom > backups/storesync-$(date +\%F).dump && find backups -name '*.dump' -mtime +30 -delete
```

Copy the backups off the server regularly. A backup on the same disk doesn't help if the server is
lost. On Render, paid databases have automatic backups; check what your plan includes on the
database's page.

### Restoring

```sh
docker compose stop app
docker compose exec -T db pg_restore -U storesync -d storesync --clean --if-exists < backups/storesync-2026-10-17.dump
```

**If the app ran after the backup was taken** (the usual case after losing a server), the restored
baselines are out of date. Starting the app as it is would count some changes twice. Before
starting the app, clear the shared numbers so that they are read again from the stores:

```sh
docker compose exec -T db psql -U storesync -d storesync <<'SQL'
BEGIN;
DELETE FROM sync_queue;
DELETE FROM pending_writes;
DELETE FROM pool_adjustments WHERE applied_at IS NULL;
DELETE FROM store_levels;
UPDATE pool_levels SET quantity = NULL, updated_at = now();
INSERT INTO settings (key, value) VALUES ('onboarding_completed', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
COMMIT;
SQL
docker compose start app
```

Then open **Start syncing** in the dashboard and start syncing again. Choose **Lowest number across
stores** if you aren't sure which store is right. Nothing is written to your stores until you
confirm. Your store connections, product matching and settings are kept.

You can skip this step only if the app was stopped when the backup was taken, and stayed stopped
until the restore.

Everything else comes back as it was when the backup was taken. Some of it catches up on its own:

- **Reports** read every order changed since the backup within 15 minutes (as far back as
  Shopify's 60 days go, without `read_all_orders`).
- **Sales and price changes** that started or ended after the backup start or end again at once,
  which puts the same prices in place. A sale that both started and ended since is marked as failed
  instead, with an alert: its prices are already back to normal.

The rest you redo by hand:

- **Purchase orders and deliveries entered after the backup are gone.** The units those deliveries
  added are still in your stores, and starting again reads them from there: don't receive them
  again. Re-create the orders only if you want them on record, and close them.
- **Deliveries not yet in any store**: the clean-up above also removes stock waiting to be added,
  such as units received for a catalog product you hadn't published yet. Once the product is
  published, add them with **Add/remove units** on its page.
- **Catalog, price, supplier and settings changes** made after the backup: make them again, then
  publish or update prices. A catalog product created since can be imported again from a store.

## Upgrading

1. Make a [backup](#backups).
2. Get the new code and restart:

   ```sh
   git pull
   docker compose --profile https up -d --build
   ```

3. Check `docker compose logs -f app` and the dashboard's overview page.

Database changes (migrations) run automatically when the app starts. They are safe to run from
several copies at once. To run them on their own, without starting the app:

```sh
docker compose run --rm app node dist/db/migrate-cli.js
```

Migrations only go forward. To go back to an older version after one ran, restore the backup taken
before the upgrade.

## Monitoring

- **`/healthz`** answers `{"ok":true}` when the app is running and can reach its database, and
  `503` when it can't. It needs no login. Point an uptime monitor (such as UptimeRobot or Better
  Stack) at `https://<your domain>/healthz`. Docker uses it too: `docker compose ps` shows
  `healthy`.
- **Alerts** appear in the dashboard. In **Settings**, you can also send them to Slack or to any
  webhook (Zapier or Make can forward them to WhatsApp or email), then click **Send test alert**.
  You get alerts for:
  - stores with a connection problem, or that were disconnected;
  - Shopify notifications that stopped or went missing;
  - the circuit breaker pausing sync;
  - low stock and oversold products;
  - stock updates a store refused;
  - deliveries that look like they were entered in more than one store;
  - stores that need a stock location chosen;
  - a catalog product that couldn't be published to a store;
  - a sale or price change that couldn't start, or prices a scheduled update couldn't send;
  - live sales updates Shopify refused, and order history imports that failed;
  - products to reorder ("Time to reorder"), and costs a store refused.
- **The overview page** shows the work queue. If **failing** stays above zero, open **Activity**
  and **Alerts** to see why.
- **Logs** are one JSON line per event (`docker compose logs -f app`). Keys and passwords are never
  written to the log. Set `LOG_LEVEL=debug` for more detail.

## Scaling

One copy of the app is plenty. The limit is Shopify's API allowance for each store, not the
server, and Store Sync paces its requests to stay within it. To sync a large catalog faster, raise
`WORKER_CONCURRENCY`.

Running several copies is safe: each product is only ever synced by one copy at a time. It rarely
helps, though, because each copy tracks Shopify's allowance on its own, so more copies mostly means
more waiting. If you want extra copies only to serve the dashboard, set `WORKER_ENABLED=false` on
them.

`WORKER_CONCURRENCY` only applies to stock syncing. The other background work runs next to it in
each copy, in two lanes of two tasks at a time: the stock sync's own tasks (reading a store's
products, linking a new variant, re-testing a store), and the features' (publishing, price updates,
reading orders, reorder checks...). A long price update or order history import never holds up
stock.

## Background work

Everything below runs in the copies with `WORKER_ENABLED=true`, and is safe with several copies:
each piece of work is claimed by one copy.

| How often                   | What                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Every 15 minutes (default)  | Every store is compared with the shared stock (`RECONCILE_INTERVAL_MINUTES`).                                          |
| Every 15 minutes            | Shopify notifications are checked and set up again if needed; each store's permissions are read again.                 |
| Every 6 hours (default)     | Each store's product list is read again (`CATALOG_REFRESH_INTERVAL_MINUTES`).                                          |
| Every 5 minutes             | Stores with a connection problem are tested again.                                                                     |
| Every minute                | Alerts are delivered; old activity is pruned; unused catalog uploads older than a day are deleted.                     |
| Every minute                | Sales and price changes that are due start or end.                                                                     |
| Every 15 minutes, per store | Orders changed since the last look are read (Reports), in case a live update was missed.                               |
| Every minute                | Sales lines are matched to products once products change, and given a cost once the product has one.                   |
| Every hour                  | Reorder alerts are checked (once any order has been read), and right after a delivery or a purchase order change.      |
| When Shopify notifies       | An order created, edited, cancelled, refunded or deleted is read again (Reports).                                      |
| After you act               | Publishing, price updates, copying costs after a delivery, a store's order history import (once it has `read_orders`). |

## Order history import

When a store gets the `read_orders` permission, Store Sync asks Shopify for an export of its
orders (as far back as **Settings > Sales history** says, at most 60 days without
`read_all_orders`), waits for Shopify to prepare it, checking every 45 seconds, then downloads it
and saves the orders. It usually takes a few minutes, longer for a store with many orders.
**Reports > Sales history by store** shows how it's going. New orders are counted meanwhile.

**If it fails** (Shopify's export fails or expires, or the file can't be downloaded), you get the
alert "Order history not imported", and Store Sync reads the same orders page by page instead,
every 15 minutes, until it has them all. That's slower but needs nothing from you: the alert goes
away by itself once the whole history is read. To try the export again, click **Import again…**
for that store on the Reports page.

**Import again…** is also how you get older sales after Shopify approves `read_all_orders`, or after
you raise **Read sales from the last (days)**: changing the setting doesn't import anything by
itself. Sales already read stay in your reports while it runs.

If Reports keeps saying a store's import "starts within a minute" for more than a few minutes,
Shopify may be refusing to start the export. Store Sync keeps asking, and meanwhile only live
updates bring new orders in. Look for `sales_backfill` in the app's log
(`docker compose logs app | grep sales_backfill`): the error says why. A missing permission shows on
the Reports page itself.

## Removing a store

**Remove store** (at the bottom of a store's page) stops syncing it and leaves its stock in Shopify
as it is. It also deletes everything Store Sync keeps about that store, and connecting the store
again doesn't bring any of it back:

- that brand's own version of each catalog product (its title, description, tags and images), and
  the link to its products in Shopify;
- its price rule and fixed prices;
- its sales history: reports and the sales pace change, and without `read_all_orders` Shopify only
  gives the last 60 days of orders back.

The confirmation lists how much of each the store has. If you connect the store again and publish a
catalog product to it, its product in Shopify takes the catalog's texts and images (the preview
shows what changes). To stop syncing for a while, **pause** the store instead: nothing is deleted.

## Changing keys and passwords

- **Dashboard password:** change `ADMIN_PASSWORD` and restart.
- **Shopify client secret** (Dev Dashboard app):
  1. Create a new secret in the Dev Dashboard.
  2. Paste it in Store Sync, in the page of every store that uses this app.
  3. Revoke the old secret in the Dev Dashboard.

  Store Sync keeps accepting notifications signed with the previous secret for 7 days after you
  save the new one, so nothing is rejected while Shopify switches over. The 15-minute check catches
  anything missed either way.

- **Legacy access token:** reinstalling the app in the store admin creates a new token. Paste it
  in the store's page.
- **`ENCRYPTION_KEY`: changing it is not supported in this version.** Everything stored with the
  old key becomes unreadable. If the key leaked, treat your Shopify keys as leaked too:
  1. Create new Shopify keys.
  2. Set a new `ENCRYPTION_KEY` and restart.
  3. In every store's page, enter the new keys (and the API secret key, for legacy stores).

## Shopify API version

Shopify releases a new API version every three months and supports each one for a year.
Store Sync uses **2026-10** by default (`SHOPIFY_API_VERSION`), which Shopify supports until
October 2027. If a version expires, Shopify silently switches the app to the oldest version it
still supports. Don't let that happen.

Once a year:

1. Read Shopify's release notes for changes to inventory (`inventorySetQuantities`,
   `inventoryActivate`, inventory levels, `inventoryItemUpdate`) and webhooks. If you use the extra
   features, also for products (`productSet`, `productVariantsBulkUpdate`, staged uploads,
   `publishablePublish`), orders, bulk operations and protected customer data.
2. Test the new version on a development store: change `SHOPIFY_API_VERSION` and restart.
3. Change it in production and restart. Newer releases of Store Sync update the default.
4. In the Dev Dashboard, create and release an app version with the new **Webhooks API version**.

Existing webhook subscriptions keep the version they were created with. That's fine: Store Sync
only takes the product, location and order IDs from a notification, then reads the rest itself.

## When something looks wrong

Numbers jumping around, a store showing the wrong number, many products suddenly at zero:

1. **Pause sync.** In **Settings**, click **Pause all syncing**. No stock is written to your
   stores any more. Stores keep selling with the numbers they show.
2. **Look at what happened.** **Activity** lists every change, with the store it came from and the
   number before and after. Filter by store or product. **Alerts** shows problems Store Sync
   noticed. A product's page shows what each store shows, and any update still in progress.
3. **Find the cause.** Common ones: an inventory CSV import, another stock app, a delivery typed
   into every store, the wrong location chosen for a store, or a SKU used for two different
   products.
4. **Fix it in one place.** Use **Set stock to…** on the product page in Store Sync. Don't type the
   fix into every store: each store's change would be counted. If one store caused the problem
   (for example a bad import), putting that store's numbers back is enough.
5. **Resume sync** from **Settings**, and watch **Activity** for a few minutes.

If the circuit breaker paused sync, the alert explains what triggered it. See
[the circuit breaker](how-sync-works.md#the-circuit-breaker).

**Pausing all syncing only stops stock.** Publishing, price updates and planned sales keep
going. If prices are what looks wrong: the Prices page's **History** tab lists every update, with
why it ran and what each store refused. To stop a sale, cancel it or end it now on the **Sales &
changes** tab. To stop everything reaching one store, pause that store on its page.

**If the server was down,** Shopify retries notifications for about 4 hours. When the app is back,
the regular 15-minute check catches up on everything it missed. While it's down, every store sells
on its own, so keep downtime short.

**To stop using Store Sync,** remove the stores in the dashboard and uninstall the app from each
store. Store quantities stay as they are; nothing is set to zero. Products you published and prices
you set stay in your stores as they are. Download what you want to keep first (Reports and
purchase orders have **Download CSV**), and keep a last database backup.
