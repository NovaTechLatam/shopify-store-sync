import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { setAlert } from '../../alerts/alerts.js';
import type { Queryable } from '../../db/pool.js';
import type { StoreCredentials } from '../../shopify/registry.js';
import { featureStatus, recordShopInfo } from '../../shopify/scopes.js';
import { inspectConnection } from '../../sync/health.js';
import { enqueuePoolLevels } from '../../sync/queue.js';
import { enqueueTask } from '../../tasks/queue.js';
import { registerStoreWebhooks } from '../../webhooks/register.js';
import { webhookUrl } from '../../webhooks/topics.js';
import { badRequest, conflict, notFound, parseId } from '../errors.js';
import type { AppDeps } from '../server.js';

const ShopDomain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
  .transform((v) => (v.includes('.') ? v : `${v}.myshopify.com`))
  .refine((v) => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(v), {
    message: 'Use the store’s myshopify.com address, e.g. my-brand.myshopify.com',
  });

const Secret = z.string().trim().min(1).max(500);

const CreateStoreBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    shopDomain: ShopDomain,
    authMode: z.enum(['access_token', 'client_credentials']),
    accessToken: Secret.optional(),
    clientId: z.string().trim().min(1).max(200).optional(),
    clientSecret: Secret.optional(),
    webhookSecret: Secret.optional(),
    safetyBuffer: z.number().int().min(0).max(100_000).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.authMode === 'access_token' && !b.accessToken) {
      ctx.addIssue({
        code: 'custom',
        path: ['accessToken'],
        message: 'The Admin API access token is required',
      });
    }
    if (b.authMode === 'access_token' && !b.webhookSecret) {
      ctx.addIssue({
        code: 'custom',
        path: ['webhookSecret'],
        message:
          'The API secret key is required: without it the store’s notifications can’t be verified',
      });
    }
    if (b.authMode === 'client_credentials' && (!b.clientId || !b.clientSecret)) {
      ctx.addIssue({
        code: 'custom',
        path: ['clientId'],
        message: 'Client ID and client secret are required',
      });
    }
  });

const UpdateStoreBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  safetyBuffer: z.number().int().min(0).max(100_000).optional(),
  status: z.enum(['active', 'paused']).optional(),
  /**
   * Units of the store's currency per 1 unit of the base currency. The column keeps 8 decimals:
   * anything smaller would be stored as 0, which its CHECK refuses.
   */
  exchangeRate: z.number().min(0.00000001).max(1_000_000_000).optional(),
  accessToken: Secret.optional(),
  clientId: z.string().trim().min(1).max(200).optional(),
  clientSecret: Secret.optional(),
  webhookSecret: Secret.nullable().optional(),
});

const MapLocationBody = z.object({ warehouseId: z.number().int().positive().nullable() });

interface StoreRow {
  id: number;
  name: string;
  shop_domain: string;
  auth_mode: 'access_token' | 'client_credentials';
  status: string;
  last_error: string | null;
  safety_buffer: number;
  has_webhook_secret: boolean;
  client_id: string | null;
  last_webhook_at: Date | null;
  webhooks_registered_at: Date | null;
  catalog_synced_at: Date | null;
  last_drift_scan_at: Date | null;
  last_drift_count: number | null;
  created_at: Date;
  currency_code: string | null;
  iana_timezone: string | null;
  exchange_rate: number;
  exchange_rate_set_at: Date | null;
  granted_scopes: string[] | null;
  scopes_checked_at: Date | null;
  variant_count: number;
  linked_count: number;
}

interface LocationRow {
  id: number;
  store_id: number;
  shopify_location_id: string;
  name: string;
  is_active: boolean;
  warehouse_id: number | null;
}

const STORE_SELECT = `
  SELECT s.id, s.name, s.shop_domain, s.auth_mode, s.status, s.last_error, s.safety_buffer,
         (s.webhook_secret_enc IS NOT NULL OR s.client_secret_enc IS NOT NULL) AS has_webhook_secret,
         s.client_id, s.last_webhook_at, s.webhooks_registered_at, s.catalog_synced_at,
         s.last_drift_scan_at, s.last_drift_count, s.created_at, s.currency_code, s.iana_timezone,
         s.exchange_rate, s.exchange_rate_set_at, s.granted_scopes, s.scopes_checked_at,
         (SELECT count(*)::int FROM variants v WHERE v.store_id = s.id AND v.deleted_at IS NULL) AS variant_count,
         (SELECT count(*)::int FROM variants v
           WHERE v.store_id = s.id AND v.deleted_at IS NULL AND v.item_id IS NOT NULL) AS linked_count
    FROM stores s`;

export async function loadStores(db: Queryable, storeId?: number) {
  const { rows } = await db.query<StoreRow>(
    `${STORE_SELECT} ${storeId === undefined ? '' : 'WHERE s.id = $1'} ORDER BY s.id`,
    storeId === undefined ? [] : [storeId],
  );
  const locations = await db.query<LocationRow>(
    `SELECT id, store_id, shopify_location_id, name, is_active, warehouse_id FROM store_locations
      ${storeId === undefined ? '' : 'WHERE store_id = $1'} ORDER BY is_active DESC, name`,
    storeId === undefined ? [] : [storeId],
  );
  return rows.map((s) =>
    storeView(
      s,
      locations.rows.filter((l) => l.store_id === s.id),
    ),
  );
}

/** A store as every store route returns it. */
function storeView(s: StoreRow, locations: LocationRow[]) {
  return {
    id: s.id,
    name: s.name,
    shopDomain: s.shop_domain,
    authMode: s.auth_mode,
    status: s.status,
    lastError: s.last_error,
    safetyBuffer: s.safety_buffer,
    hasWebhookSecret: s.has_webhook_secret,
    clientId: s.client_id,
    lastWebhookAt: s.last_webhook_at,
    webhooksRegisteredAt: s.webhooks_registered_at,
    catalogSyncedAt: s.catalog_synced_at,
    lastDriftScanAt: s.last_drift_scan_at,
    lastDriftCount: s.last_drift_count,
    createdAt: s.created_at,
    variantCount: s.variant_count,
    linkedCount: s.linked_count,
    /** Read from Shopify; null until the store was checked once. */
    currencyCode: s.currency_code,
    timezone: s.iana_timezone,
    /** Units of the store's currency per 1 unit of the base currency (settings.baseCurrency). */
    exchangeRate: s.exchange_rate,
    /**
     * The merchant saved the rate (else it is the default 1, which counts as not set for a store
     * in another currency: see exchangeRateUnset).
     */
    exchangeRateSetAt: s.exchange_rate_set_at,
    /** When the app's permissions on the store were last read (null = never). */
    scopesCheckedAt: s.scopes_checked_at,
    /**
     * Which optional features the app's permissions allow (src/shopify/scopes.ts). Before the
     * permissions were read every feature counts as available: Shopify then has the last word.
     */
    features: featureStatus(s.granted_scopes),
    locations: locations.map((l) => ({
      id: l.id,
      shopifyLocationId: l.shopify_location_id,
      name: l.name,
      isActive: l.is_active,
      warehouseId: l.warehouse_id,
    })),
  };
}

async function loadStore(db: Queryable, storeId: number) {
  const [store] = await loadStores(db, storeId);
  if (!store) throw notFound('Store');
  return store;
}

/** Every pool level a store takes part in (its linked items, in the warehouses it maps). */
async function storePoolLevelIds(db: Queryable, storeId: number): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT DISTINCT pl.id FROM variants v
       JOIN store_locations sl ON sl.store_id = v.store_id AND sl.warehouse_id IS NOT NULL
       JOIN pool_levels pl ON pl.item_id = v.item_id AND pl.warehouse_id = sl.warehouse_id
      WHERE v.store_id = $1 AND v.item_id IS NOT NULL AND v.deleted_at IS NULL`,
    [storeId],
  );
  return rows.map((r) => r.id);
}

export async function registerStoreRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, secrets } = deps;

  async function testCredentials(creds: StoreCredentials) {
    let admin;
    try {
      admin = deps.createAdmin(creds);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    const { check, shop } = await inspectConnection(admin);
    if (!check.ok || !shop) {
      const scopes = check.missingScopes.length
        ? ` The app is missing these permissions: ${check.missingScopes.join(', ')}.`
        : '';
      throw badRequest(
        `Could not connect to ${creds.shopDomain}: ${check.error ?? 'unknown error'}.${scopes}`,
        {
          missingScopes: check.missingScopes,
        },
      );
    }
    return shop;
  }

  app.get('/api/stores', async () => loadStores(db));

  app.get('/api/stores/:id', async (request) =>
    loadStore(db, parseId((request.params as { id: string }).id)),
  );

  app.post('/api/stores', async (request, reply) => {
    const body = CreateStoreBody.parse(request.body);
    const existing = await db.query('SELECT 1 FROM stores WHERE shop_domain = $1', [
      body.shopDomain,
    ]);
    if (existing.rowCount) throw conflict(`${body.shopDomain} is already connected`);
    const shop = await testCredentials({
      shopDomain: body.shopDomain,
      authMode: body.authMode,
      accessToken: body.accessToken,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
    });
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO stores (name, shop_domain, auth_mode, access_token_enc, client_id, client_secret_enc,
                           webhook_secret_enc, safety_buffer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        body.name,
        body.shopDomain,
        body.authMode,
        body.authMode === 'access_token' && body.accessToken
          ? secrets.encrypt(body.accessToken)
          : null,
        body.authMode === 'client_credentials' ? body.clientId : null,
        body.authMode === 'client_credentials' && body.clientSecret
          ? secrets.encrypt(body.clientSecret)
          : null,
        body.webhookSecret ? secrets.encrypt(body.webhookSecret) : null,
        body.safetyBuffer ?? 0,
      ],
    );
    const storeId = rows[0]!.id;
    await recordShopInfo(db, storeId, shop);
    await enqueueTask(db, 'catalog_sync', { storeId });
    await enqueueTask(db, 'ensure_webhooks', { storeId });
    deps.onWork?.();
    return reply.code(201).send(await loadStore(db, storeId));
  });

  app.patch('/api/stores/:id', async (request) => {
    const storeId = parseId((request.params as { id: string }).id);
    const body = UpdateStoreBody.parse(request.body);
    const { rows } = await db.query<{
      shop_domain: string;
      auth_mode: 'access_token' | 'client_credentials';
      access_token_enc: string | null;
      client_id: string | null;
      client_secret_enc: string | null;
      safety_buffer: number;
      status: string;
    }>(
      `SELECT shop_domain, auth_mode, access_token_enc, client_id, client_secret_enc, safety_buffer, status
         FROM stores WHERE id = $1`,
      [storeId],
    );
    const current = rows[0];
    if (!current) throw notFound('Store');

    const credentialsChanged =
      body.accessToken !== undefined ||
      body.clientId !== undefined ||
      body.clientSecret !== undefined;
    if (credentialsChanged) {
      const creds: StoreCredentials = {
        shopDomain: current.shop_domain,
        authMode: current.auth_mode,
        accessToken:
          body.accessToken ??
          (current.access_token_enc ? secrets.decrypt(current.access_token_enc) : null),
        clientId: body.clientId ?? current.client_id,
        clientSecret:
          body.clientSecret ??
          (current.client_secret_enc ? secrets.decrypt(current.client_secret_enc) : null),
      };
      const shop = await testCredentials(creds);
      await recordShopInfo(db, storeId, shop);
      // Keep the old client secret for webhook signatures until Shopify stops using it.
      const rotated = body.clientSecret !== undefined && current.client_secret_enc !== null;
      if (rotated) {
        await db.query(
          `UPDATE stores SET previous_client_secret_enc = client_secret_enc,
                             client_secret_rotated_at = now()
            WHERE id = $1`,
          [storeId],
        );
      }
      await db.query(
        `UPDATE stores SET access_token_enc = $2, client_id = $3, client_secret_enc = $4, updated_at = now()
          WHERE id = $1`,
        [
          storeId,
          creds.authMode === 'access_token' && creds.accessToken
            ? secrets.encrypt(creds.accessToken)
            : null,
          creds.authMode === 'client_credentials' ? creds.clientId : null,
          creds.authMode === 'client_credentials' && creds.clientSecret
            ? secrets.encrypt(creds.clientSecret)
            : null,
        ],
      );
      deps.shopify.invalidate(storeId);
    }
    if (body.webhookSecret !== undefined) {
      await db.query(
        'UPDATE stores SET webhook_secret_enc = $2, updated_at = now() WHERE id = $1',
        [storeId, body.webhookSecret === null ? null : secrets.encrypt(body.webhookSecret)],
      );
    }
    if (body.name !== undefined) {
      await db.query('UPDATE stores SET name = $2, updated_at = now() WHERE id = $1', [
        storeId,
        body.name,
      ]);
    }
    // Only changes what prices are computed from: nothing is sent to Shopify until prices are
    // applied or a product is published.
    if (body.exchangeRate !== undefined) {
      await db.query(
        `UPDATE stores SET exchange_rate = $2, exchange_rate_set_at = now(), updated_at = now()
          WHERE id = $1`,
        [storeId, body.exchangeRate],
      );
    }
    if (body.safetyBuffer !== undefined && body.safetyBuffer !== current.safety_buffer) {
      await db.query('UPDATE stores SET safety_buffer = $2, updated_at = now() WHERE id = $1', [
        storeId,
        body.safetyBuffer,
      ]);
      await enqueuePoolLevels(db, await storePoolLevelIds(db, storeId), 'store_buffer_changed');
    }
    // Resuming a store, or fixing the credentials of one in error, brings it back. Its catalog is
    // re-read first (links may have changed meanwhile); the catalog sync then starts syncing it.
    const fixedError = credentialsChanged && current.status === 'error' && body.status !== 'paused';
    const nextStatus = body.status ?? (fixedError ? 'active' : current.status);
    if (nextStatus !== current.status) {
      const reactivate = nextStatus === 'active';
      await db.query(
        `UPDATE stores SET status = $2, last_error = NULL, updated_at = now(),
                           catalog_pending = catalog_pending OR $3
          WHERE id = $1`,
        [storeId, nextStatus, reactivate],
      );
      if (reactivate) {
        await setAlert(db, {
          open: false,
          kind: 'store_error',
          dedupeKey: `store_error:${storeId}`,
          message: '',
        });
        await enqueueTask(db, 'catalog_sync', { storeId });
        await enqueueTask(db, 'ensure_webhooks', { storeId });
      }
    }
    deps.onWork?.();
    return loadStore(db, storeId);
  });

  // What removing the store deletes with it, for the confirmation (none of it comes back when the
  // store is connected again).
  app.get('/api/stores/:id/removal', async (request) => {
    const storeId = parseId((request.params as { id: string }).id);
    await loadStore(db, storeId);
    const { rows } = await db.query<{
      brand_versions: number;
      brand_images: number;
      price_rule: boolean;
      fixed_prices: number;
      orders: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM master_product_stores mps
           WHERE mps.store_id = $1
             AND (mps.title IS NOT NULL OR mps.description_html IS NOT NULL OR mps.vendor IS NOT NULL
                  OR mps.product_type IS NOT NULL OR mps.handle IS NOT NULL
                  OR mps.seo_title IS NOT NULL OR mps.seo_description IS NOT NULL
                  OR mps.extra_tags <> '{}' OR mps.status IS NOT NULL
                  OR EXISTS (SELECT 1 FROM master_media m
                              WHERE m.master_product_id = mps.master_product_id
                                AND m.store_id = mps.store_id))) AS brand_versions,
         (SELECT count(*)::int FROM master_media WHERE store_id = $1) AS brand_images,
         EXISTS (SELECT 1 FROM price_rules WHERE store_id = $1 AND enabled) AS price_rule,
         (SELECT count(*)::int FROM price_overrides WHERE store_id = $1) AS fixed_prices,
         (SELECT count(*)::int FROM sales_orders WHERE store_id = $1 AND deleted_at IS NULL)
           AS orders`,
      [storeId],
    );
    const r = rows[0]!;
    return {
      brandVersions: r.brand_versions,
      brandImages: r.brand_images,
      priceRule: r.price_rule,
      fixedPrices: r.fixed_prices,
      orders: r.orders,
    };
  });

  app.delete('/api/stores/:id', async (request, reply) => {
    const storeId = parseId((request.params as { id: string }).id);
    await loadStore(db, storeId);
    // Best effort: stop Shopify from sending webhooks for this store.
    try {
      const admin = await deps.shopify.forStore(storeId);
      const url = webhookUrl(deps.publicUrl);
      const subs = await admin.listWebhookSubscriptions();
      for (const sub of subs.filter((s) => s.uri === url))
        await admin.deleteWebhookSubscription(sub.id);
    } catch (err) {
      request.log.warn({ err, storeId }, 'could not remove webhook subscriptions of deleted store');
    }
    await db.query('DELETE FROM stores WHERE id = $1', [storeId]);
    deps.shopify.invalidate(storeId);
    return reply.code(204).send();
  });

  app.post('/api/stores/:id/test', async (request) => {
    const storeId = parseId((request.params as { id: string }).id);
    await loadStore(db, storeId);
    deps.shopify.invalidate(storeId);
    let inspected;
    try {
      inspected = await inspectConnection(await deps.shopify.forStore(storeId));
    } catch (err) {
      return { ok: false, missingScopes: [], error: (err as Error).message };
    }
    // The permissions panel and currency on the store page come from what was read here.
    if (inspected.shop) await recordShopInfo(db, storeId, inspected.shop);
    return inspected.check;
  });

  app.post('/api/stores/:id/sync-catalog', async (request, reply) => {
    const storeId = parseId((request.params as { id: string }).id);
    await loadStore(db, storeId);
    await enqueueTask(db, 'catalog_sync', { storeId });
    deps.onWork?.();
    return reply.code(202).send({ queued: true });
  });

  app.post('/api/stores/:id/register-webhooks', async (request) => {
    const storeId = parseId((request.params as { id: string }).id);
    await loadStore(db, storeId);
    return registerStoreWebhooks(deps, storeId);
  });

  app.put('/api/stores/:id/locations/:locationId', async (request) => {
    const params = request.params as { id: string; locationId: string };
    const storeId = parseId(params.id);
    const locationId = parseId(params.locationId, 'location id');
    const body = MapLocationBody.parse(request.body);
    const loc = await db.query<{ warehouse_id: number | null }>(
      'SELECT warehouse_id FROM store_locations WHERE id = $1 AND store_id = $2',
      [locationId, storeId],
    );
    if (!loc.rows[0]) throw notFound('Location');
    const previous = loc.rows[0].warehouse_id;
    if (body.warehouseId !== null) {
      const wh = await db.query('SELECT 1 FROM warehouses WHERE id = $1', [body.warehouseId]);
      if (!wh.rowCount) throw notFound('Warehouse');
      const taken = await db.query<{ name: string }>(
        'SELECT name FROM store_locations WHERE store_id = $1 AND warehouse_id = $2 AND id <> $3',
        [storeId, body.warehouseId, locationId],
      );
      if (taken.rows[0]) {
        throw conflict(
          `“${taken.rows[0].name}” already holds this warehouse’s stock for this store. Unmap it first.`,
        );
      }
    }
    await db.query('UPDATE store_locations SET warehouse_id = $3 WHERE id = $1 AND store_id = $2', [
      locationId,
      storeId,
      body.warehouseId,
    ]);
    const mapped = await db.query(
      'SELECT 1 FROM store_locations WHERE store_id = $1 AND warehouse_id IS NOT NULL AND is_active',
      [storeId],
    );
    await setAlert(db, {
      open: !mapped.rowCount,
      kind: 'store_unmapped',
      dedupeKey: `store_unmapped:${storeId}`,
      storeId,
      message: 'Choose which location of this store holds the shared stock (Stores → locations).',
    });
    // Levels in the old and new warehouse change membership; the engine re-baselines them.
    const warehouses = [previous, body.warehouseId].filter((w): w is number => w !== null);
    if (warehouses.length) {
      const { rows } = await db.query<{ id: number }>(
        `SELECT DISTINCT pl.id FROM variants v JOIN pool_levels pl ON pl.item_id = v.item_id
          WHERE v.store_id = $1 AND v.deleted_at IS NULL AND pl.warehouse_id = ANY($2::bigint[])`,
        [storeId, warehouses],
      );
      await enqueuePoolLevels(
        db,
        rows.map((r) => r.id),
        'location_mapping_changed',
      );
      deps.onWork?.();
    }
    return loadStore(db, storeId);
  });
}
