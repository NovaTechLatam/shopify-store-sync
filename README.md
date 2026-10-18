# Store Sync

Store Sync keeps stock in step across several Shopify stores that sell the same products from one
shared stock. You might run one store per brand, each with its own prices, photos and product
names. When a unit sells, is refunded, is returned or is edited in any store, every other store
shows the new number within seconds. That way no store keeps selling something you no longer have.

Around that shared stock, it can also keep your products and prices in one place, show every
brand's sales together, and plan what to buy. These are optional, and you can turn them on one by
one.

The stock sync only ever changes the **available quantity**. Titles, descriptions, images, prices
and costs change only when you ask for it: when you publish a product from the **Catalog**, update
prices or plan a sale on the **Prices** page, or turn on copying costs to Shopify.

## Features

### Stock sync

- **One shared stock for all brand stores.** Online orders, cancellations, refunds, POS sales, staff
  edits and changes made by other apps in any store update every other store.
- **Never overwrites a sale.** Each update to a store only goes through if that store hasn't changed
  since we last looked. If it has, we count the new change first and try again.
- **Automatic product matching by SKU.** Matching ignores upper/lower case and spaces. You can link
  the rest by hand. A SKU used twice in the same store is flagged and never synced.
- **A safe start.** Before the first sync you choose where the starting numbers come from, and you
  see exactly what will change in each store.
- **Safety buffer per store.** A store can show a few units less than you have, so two stores are
  less likely to sell the last unit at the same time.
- **Catches what Shopify misses.** Every 15 minutes, every store is compared with the shared stock.
  The app also checks that Shopify is still sending it notifications, and sets them up again if
  they were removed.
- **Guardrails.** There is a pause switch for everything, a pause per store and a pause per product.
  If many products suddenly drop to zero (for example after a bad CSV import), the app pauses
  itself. Disconnecting a store never sets its stock to zero.
- **Alerts** for low stock, oversold products, store connection problems, missed notifications and
  deliveries that look like they were counted twice. They can go to Slack, or to any webhook (Zapier
  or Make can forward them to WhatsApp or email).
- **Activity log.** Every change is recorded with the store it came from and the number before and
  after.
- **Stock tools in the dashboard.** You can set the stock to a number, add units when a delivery
  arrives, remove units, or enter a shelf count (units sold but not shipped yet are subtracted for
  you).
- **Several warehouses**, if your stock is split across places.
- Runs anywhere Docker runs: one small server plus a Postgres database.

### Beyond stock (optional)

- **Catalog.** Write a product once and publish it to every brand, each with its own title,
  description, images, search listing and tags, while options, variants and SKUs stay identical.
  Import the products your stores already sell. A preview shows what each store gets first
  ([docs/catalog.md](docs/catalog.md)).
- **Prices.** A base price per product and a rule per brand ("Brand B = base × 1.3, ending in
  .90", with its own currency), fixed prices, bulk edits, scheduled sales and price changes, and a
  preview before anything reaches your stores ([docs/pricing.md](docs/pricing.md)).
- **Reports.** Revenue, units, orders and margin across every brand, in each store's currency and
  combined, with sell-through and days of stock left per product
  ([docs/reports.md](docs/reports.md)).
- **Purchasing.** Suppliers and purchase orders; receive a delivery once (in full or in parts) and
  every store goes up. Average or last cost per product
  ([docs/purchasing.md](docs/purchasing.md)).
- **Reorder alerts.** From the sales pace in every store, the stock you have and what's on order:
  which products will run out before a new delivery could arrive, how many to order, and draft
  orders in one click ([docs/purchasing.md](docs/purchasing.md#reorder-suggestions)).

## Quick start

You need [Docker](https://docs.docker.com/get-docker/) installed.

1. Download this project and open a terminal in its folder.
2. Create your settings file:

   ```sh
   cp .env.example .env
   ```

3. Open `.env` in a text editor and fill in these values:
   - `ENCRYPTION_KEY`: paste the output of `openssl rand -base64 32`. Save a copy in your password
     manager.
   - `ADMIN_PASSWORD`: the dashboard password, at least 12 characters.
   - `POSTGRES_PASSWORD`: paste the output of `openssl rand -hex 24`.
   - `PUBLIC_URL`: the HTTPS address the app will have, for example `https://sync.mybrand.com`.
     To just look around on your computer, you can keep the example value.

4. Start it:

   ```sh
   docker compose up -d
   ```

5. Open <http://localhost:3000> and log in with `admin` and your password.

Shopify must be able to reach the app over HTTPS to send it stock notifications. For real use, run
it on a server: [docs/operations.md](docs/operations.md) explains how, step by step.

## First-time setup checklist

1. **Create the Shopify app and install it on every store.** Follow
   [docs/setup-shopify.md](docs/setup-shopify.md). It takes about 15 minutes.
2. **Connect your stores.** In the dashboard, go to **Stores > Add store** and add each store with
   the keys from step 1. **Test connection** tells you right away if something is missing.
3. **Choose the stock location.** In each store's page, pick the Shopify location that holds the
   shared stock. Stores with only one location are set up automatically.
4. **Match your products.** Open **Matching**. Products with the same SKU in different stores are
   matched for you. Link the rest by hand, and fix any SKU used twice in one store.
5. **Start syncing.** Open **Start syncing**. Choose where the starting numbers come from, check
   the preview, then confirm. This step overwrites store quantities, so read the preview carefully.
6. **Done.** Optionally, set where alerts go and the low-stock level in **Settings**, and add
   safety buffers in **Stores**.

New products you add later start syncing on their own. You can turn that off in **Settings**.

Then, if you want them, turn on the other features. Each one works without the others, and stock
keeps syncing whatever you choose:

1. **Give the extra permissions** (`write_products`, `write_publications`, `read_orders`) to each
   store's app: [Setting up Shopify](docs/setup-shopify.md#permissions-for-the-extra-features).
   With `read_orders`, Reports start importing each store's order history.
2. **Set your base currency** in **Settings > Currency**, and each store's exchange rate on its
   page in **Stores** when the store sells in another currency.
3. **Catalog**: import the products your stores already sell, then write new ones there
   ([the catalog](docs/catalog.md)).
4. **Prices**: enter base prices (or copy them from a store), set each store's rule, preview, and
   update ([prices](docs/pricing.md)).
5. **Purchasing**: add your suppliers and their lead times, and receive deliveries on purchase
   orders from now on ([purchasing](docs/purchasing.md)). Reorder alerts start once orders are read.

## Configuration

Set these as environment variables, or in `.env` when you use Docker Compose.
[.env.example](.env.example) has every variable with an explanation.

| Variable                           | Required | Default       | What it does                                                                          |
| ---------------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                       | yes      |               | Public HTTPS address of the app. Shopify sends notifications to `/webhooks/shopify`.  |
| `ENCRYPTION_KEY`                   | yes      |               | 32 random bytes in base64 (`openssl rand -base64 32`). Encrypts the stored keys.      |
| `ADMIN_PASSWORD`                   | yes      |               | Dashboard password, at least 12 characters.                                           |
| `ADMIN_USERNAME`                   | no       | `admin`       | Dashboard user name.                                                                  |
| `DATABASE_URL`                     | yes\*    |               | Postgres connection URL. \*Docker Compose sets it for you.                            |
| `POSTGRES_PASSWORD`                | compose  |               | Password of the bundled database (Docker Compose only).                               |
| `DATABASE_POOL_SIZE`               | no       | `10`          | Maximum database connections.                                                         |
| `SHOPIFY_API_VERSION`              | no       | `2026-10`     | Shopify Admin API version (see [operations](docs/operations.md#shopify-api-version)). |
| `WORKER_ENABLED`                   | no       | `true`        | Run the background sync in this process. `false` for extra web-only copies.           |
| `WORKER_CONCURRENCY`               | no       | `4`           | Products synced in parallel (1-64).                                                   |
| `RECONCILE_INTERVAL_MINUTES`       | no       | `15`          | How often every store is compared with the shared stock.                              |
| `CATALOG_REFRESH_INTERVAL_MINUTES` | no       | `360`         | How often every store's product list is re-read (at least 5).                         |
| `LOG_LEVEL`                        | no       | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                       |
| `NODE_ENV`                         | no       | `development` | `development`, `production` or `test`. The Docker image sets `production`.            |
| `HOST`                             | no       | `0.0.0.0`     | Address the web server listens on.                                                    |
| `PORT`                             | no       | `3000`        | Port the web server listens on.                                                       |
| `TRUST_PROXY`                      | no       | private nets  | Proxies trusted to report the visitor's address (used to lock out password guessing). |

The catalog, prices, reports and purchasing need no variables of their own. Everything else (pause
switch, alert destinations, low-stock level, safety buffers, base currency, exchange rates, reorder
planning, costs...) is set in the dashboard.

## Documentation

- [Setting up Shopify](docs/setup-shopify.md): create the app, install it on your stores, the
  optional permissions of the extra features, fix connection problems.
- [How sync works](docs/how-sync-works.md): the shared number, what happens on orders, refunds,
  returns, CSV imports, deliveries and new stores, and what the app never does.
- [The catalog](docs/catalog.md): write a product once, publish it to every brand, import the ones
  you have.
- [Prices](docs/pricing.md): base prices, rules per brand, fixed prices, sales and price changes.
- [Reports](docs/reports.md): sales across every brand, where the numbers come from and how far
  back they go.
- [Purchasing](docs/purchasing.md): suppliers, purchase orders, receiving, costs and reorder
  suggestions.
- [Operations](docs/operations.md): deploying, database size, backups, upgrades, monitoring,
  background work, and what to do when something looks wrong.
- [Roadmap](docs/roadmap.md): what's in this version, its known gaps, and the features worth
  adding next.

## Development

Requirements: Node.js 22.12 or newer, and PostgreSQL 16.

```sh
npm ci
cp .env.example .env                       # then set DATABASE_URL to your local database
npx tsx watch --env-file=.env src/main.ts  # runs the app and restarts it on changes
```

| Script                    | What it does                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev`             | Runs the app from source and restarts on changes (reads `process.env`).              |
| `npm run build`           | Compiles TypeScript to `dist/`.                                                      |
| `npm start`               | Runs the compiled app (`dist/main.js`).                                              |
| `npm run migrate`         | Applies database migrations (needs `DATABASE_URL`). The app also does this on start. |
| `npm test`                | Runs the test suite (needs Postgres, see below).                                     |
| `npm run test:watch`      | Runs the tests on every change.                                                      |
| `npm run typecheck`       | Type-checks everything, tests included.                                              |
| `npm run lint`            | ESLint.                                                                              |
| `npm run format`          | Formats every file with Prettier.                                                    |
| `npm run format:check`    | Checks formatting (what CI runs).                                                    |
| `npm run check:dashboard` | Checks every dashboard page in Chromium (see [below](#dashboard-check)).             |

### Tests

The tests run against a real Postgres database given by `TEST_DATABASE_URL` (default
`postgres://postgres:postgres@localhost:5432/storesync_test`). Shopify is replaced by an in-memory
fake.

> **Warning:** the tests delete everything in that database. Never point `TEST_DATABASE_URL` at a
> database you care about.

```sh
createdb storesync_test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/storesync_test npm test
```

CI (`.github/workflows/ci.yml`) runs lint, type check, format check, tests and build. It also
builds the Docker image and checks that it starts.

### Dashboard check

`npm run check:dashboard` opens every dashboard page at phone and desktop width, in light and dark
mode, against a mock API (`scripts/dashboard-mock-api.mjs`; no database or Shopify needed). It
runs the main flows of every feature and fails on console errors, failed requests, horizontal
scrolling, unlabelled controls and duplicate ids. Screenshots go to `$SCREENSHOT_DIR`. Install the
browser once with `npx playwright-core install chromium`.

### Layout

| Path                 | Contents                                                            |
| -------------------- | ------------------------------------------------------------------- |
| `src/sync/engine.ts` | The sync algorithm. Start here: the comment at the top explains it. |
| `src/sync/`          | Queue and worker, drift scan, store health checks, onboarding.      |
| `src/catalog/`       | Reading store catalogs and matching variants by SKU.                |
| `src/products/`      | The Catalog page: products, images, import, publishing.             |
| `src/pricing/`       | Prices: the formula (`compute.ts`), updates, bulk edits, sales.     |
| `src/sales/`         | Reports: reading orders, the history import, report queries.        |
| `src/purchasing/`    | Suppliers, purchase orders, receiving, costs, reorder suggestions.  |
| `src/webhooks/`      | Receiving Shopify webhooks and keeping subscriptions in place.      |
| `src/shopify/`       | Shopify Admin GraphQL client (tokens, rate limits, retries).        |
| `src/tasks/`         | Background tasks (catalog syncs, webhook checks, drift scans...).   |
| `src/scheduler.ts`   | Recurring work (each feature adds its own in its `jobs.ts`).        |
| `src/db/`            | Database pool, migrations, the list of advisory locks (`locks.ts`). |
| `src/http/`          | Admin API used by the dashboard.                                    |
| `src/alerts/`        | Alerts and their delivery to Slack or webhooks.                     |
| `public/`            | The dashboard (plain HTML, CSS and JavaScript, no build step).      |
| `scripts/`           | The [dashboard check](#dashboard-check) and its mock API.           |
| `migrations/`        | Database schema (`001`: stock sync; `002` to `005`: the rest).      |
| `test/`              | Tests, with an in-memory fake Shopify in `test/fakes/`.             |

The catalog, prices, reports and purchasing follow one pattern. Each has a folder in `src/`
(`products`, `pricing`, `sales`, `purchasing`) with its background tasks (`tasks.ts`) and recurring
jobs (`jobs.ts`); its routes in `src/http/api/` (`catalog.ts`, `prices.ts`, `reports.ts`,
`purchasing.ts`); its pages in `public/js/views/`; its section of the product page in
`public/js/item-sections/`; and its mock data and checks in `scripts/mock/` and `scripts/checks/`.
Note that `src/catalog/` is the stock sync's SKU matching: the Catalog page is `src/products/`.
