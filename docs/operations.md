# Operations

How to run Store Sync in production: deploying, configuration, backups, upgrades, monitoring, and
what to do when something looks wrong.

## What you need

- **An always-on server or hosting plan.** Shopify expects an answer to every notification within 5
  seconds, and the background sync must keep running. Plans that put the app to sleep when nobody
  visits it won't work.
- **HTTPS on a public address.** Shopify only sends notifications to HTTPS addresses.
- **PostgreSQL 16** (what Store Sync is tested with). The database stays small.
- About 1 CPU and 1 GB of memory is plenty, even for several stores with thousands of products.

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
[.env.example](../.env.example). Changes take effect when the app restarts.

Everything that changes while you run your business (pausing sync, alert destinations, low-stock
level, safety buffers, the circuit breaker limit) is set in the dashboard and takes effect
immediately.

## Backups

Back up two things:

1. **The database.** It holds your store connections (with their keys encrypted), product
   matching, shared quantities, settings and the activity log.
2. **`ENCRYPTION_KEY`**, kept somewhere else, such as your password manager. Without it the store
   keys in a backup can't be read, and every store has to be connected again.

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

Then open **Onboarding** in the dashboard and start syncing again. Choose **Lowest number across
stores** if you aren't sure which store is right. Nothing is written to your stores until you
confirm. Your store connections, product matching and settings are kept.

You can skip this step only if the app was stopped when the backup was taken, and stayed stopped
until the restore.

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
  - stores that need a stock location chosen.
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

## Changing keys and passwords

- **Dashboard password:** change `ADMIN_PASSWORD` and restart.
- **Shopify client secret** (Dev Dashboard app):
  1. Create a new secret in the Dev Dashboard.
  2. Paste it in Store Sync, in the page of every store that uses this app.
  3. Revoke the old secret in the Dev Dashboard.

  Shopify keeps signing notifications with the old secret for up to an hour after you revoke it, so
  some notifications are rejected in the meantime. Shopify retries them, and the 15-minute check
  catches anything missed.

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
   `inventoryActivate`, inventory levels) and webhooks.
2. Test the new version on a development store: change `SHOPIFY_API_VERSION` and restart.
3. Change it in production and restart. Newer releases of Store Sync update the default.
4. In the Dev Dashboard, create and release an app version with the new **Webhooks API version**.

Existing webhook subscriptions keep the version they were created with. That's fine: Store Sync
only takes the product and location IDs from a notification, then reads the stock itself.

## When something looks wrong

Numbers jumping around, a store showing the wrong number, many products suddenly at zero:

1. **Pause sync.** In **Settings**, click **Pause sync**. Nothing is written to your stores any
   more. Stores keep selling with the numbers they show.
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

**If the server was down,** Shopify retries notifications for about 4 hours. When the app is back,
the regular 15-minute check catches up on everything it missed. While it's down, every store sells
on its own, so keep downtime short.

**To stop using Store Sync,** remove the stores in the dashboard and uninstall the app from each
store. Store quantities stay as they are; nothing is set to zero.
