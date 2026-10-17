# Store Sync

Store Sync keeps stock in step across several Shopify stores that sell the same products from one
shared stock. You might run one store per brand, each with its own prices, photos and product
names. When a unit sells, is refunded, is returned or is edited in any store, every other store
shows the new number within seconds. That way no store keeps selling something you no longer have.
Store Sync only ever changes the **available quantity**. It never touches prices, images, titles or
descriptions.

## Features

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
5. **Start syncing.** Open **Onboarding**. Choose where the starting numbers come from, check the
   preview, then confirm. This step overwrites store quantities, so read the preview carefully.
6. **Done.** Optionally, set where alerts go and the low-stock level in **Settings**, and add
   safety buffers in **Stores**.

New products you add later start syncing on their own. You can turn that off in **Settings**.

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

Everything else (pause switch, alert destinations, low-stock level, safety buffers...) is set in
the dashboard.

## Documentation

- [Setting up Shopify](docs/setup-shopify.md): create the app, install it on your stores, fix
  connection problems.
- [How sync works](docs/how-sync-works.md): the shared number, what happens on orders, refunds,
  returns, CSV imports and new stores, and what the app never does.
- [Operations](docs/operations.md): deploying, backups, upgrades, monitoring, and what to do when
  something looks wrong.
- [Roadmap](docs/roadmap.md): what's in this version and the features worth adding next.

## Development

Requirements: Node.js 22.12 or newer, and PostgreSQL 16.

```sh
npm ci
cp .env.example .env                       # then set DATABASE_URL to your local database
npx tsx watch --env-file=.env src/main.ts  # runs the app and restarts it on changes
```

| Script                 | What it does                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev`          | Runs the app from source and restarts on changes (reads `process.env`).              |
| `npm run build`        | Compiles TypeScript to `dist/`.                                                      |
| `npm start`            | Runs the compiled app (`dist/main.js`).                                              |
| `npm run migrate`      | Applies database migrations (needs `DATABASE_URL`). The app also does this on start. |
| `npm test`             | Runs the test suite (needs Postgres, see below).                                     |
| `npm run test:watch`   | Runs the tests on every change.                                                      |
| `npm run typecheck`    | Type-checks everything, tests included.                                              |
| `npm run lint`         | ESLint.                                                                              |
| `npm run format`       | Formats every file with Prettier.                                                    |
| `npm run format:check` | Checks formatting (what CI runs).                                                    |

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

### Layout

| Path                 | Contents                                                            |
| -------------------- | ------------------------------------------------------------------- |
| `src/sync/engine.ts` | The sync algorithm. Start here: the comment at the top explains it. |
| `src/sync/`          | Queue and worker, drift scan, store health checks, onboarding.      |
| `src/catalog/`       | Reading store catalogs and matching variants by SKU.                |
| `src/webhooks/`      | Receiving Shopify webhooks and keeping subscriptions in place.      |
| `src/shopify/`       | Shopify Admin GraphQL client (tokens, rate limits, retries).        |
| `src/tasks/`         | Background tasks (catalog syncs, webhook checks, drift scans...).   |
| `src/http/`          | Admin API used by the dashboard.                                    |
| `src/alerts/`        | Alerts and their delivery to Slack or webhooks.                     |
| `public/`            | The dashboard (plain HTML, CSS and JavaScript, no build step).      |
| `migrations/`        | Database schema.                                                    |
| `test/`              | Tests, with an in-memory fake Shopify in `test/fakes/`.             |
