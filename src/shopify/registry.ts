import type { Logger } from 'pino';
import type { Db } from '../db/pool.js';
import type { ShopifyRegistry } from '../sync/engine.js';
import type { SecretBox } from '../util/crypto.js';
import type { FetchFn, TokenProvider } from './client.js';
import {
  ClientCredentialsTokenProvider,
  ShopifyGraphqlClient,
  StaticTokenProvider,
} from './client.js';
import { GraphqlShopifyAdmin } from './graphql-admin.js';
import type { ShopifyAdmin } from './types.js';

export interface StoreCredentials {
  shopDomain: string;
  authMode: 'access_token' | 'client_credentials';
  accessToken?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
}

export interface ShopifyClientFactoryOptions {
  apiVersion: string;
  logger: Logger;
  fetchFn?: FetchFn;
}

/** Builds an Admin API client for a set of credentials (used for "test connection" too). */
export function createShopifyAdmin(
  creds: StoreCredentials,
  opts: ShopifyClientFactoryOptions,
): ShopifyAdmin {
  let tokens: TokenProvider;
  if (creds.authMode === 'access_token') {
    if (!creds.accessToken) throw new Error('Missing access token');
    tokens = new StaticTokenProvider(creds.accessToken);
  } else {
    if (!creds.clientId || !creds.clientSecret)
      throw new Error('Missing client ID or client secret');
    tokens = new ClientCredentialsTokenProvider(
      creds.shopDomain,
      creds.clientId,
      creds.clientSecret,
      opts.fetchFn,
    );
  }
  const client = new ShopifyGraphqlClient({
    shopDomain: creds.shopDomain,
    apiVersion: opts.apiVersion,
    tokens,
    fetchFn: opts.fetchFn,
    logger: opts.logger.child({ shop: creds.shopDomain }),
  });
  return new GraphqlShopifyAdmin(client);
}

/**
 * Hands out one long-lived client per store, so the token cache and the rate-limit bucket state
 * are shared by every caller in this process. Call `invalidate` after credentials change.
 */
export class DbShopifyRegistry implements ShopifyRegistry {
  private readonly cache = new Map<number, Promise<ShopifyAdmin>>();

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    private readonly opts: ShopifyClientFactoryOptions,
  ) {}

  forStore(storeId: number): Promise<ShopifyAdmin> {
    let admin = this.cache.get(storeId);
    if (!admin) {
      admin = this.build(storeId);
      this.cache.set(storeId, admin);
      admin.catch(() => this.cache.delete(storeId));
    }
    return admin;
  }

  invalidate(storeId?: number): void {
    if (storeId === undefined) this.cache.clear();
    else this.cache.delete(storeId);
  }

  private async build(storeId: number): Promise<ShopifyAdmin> {
    const { rows } = await this.db.query<{
      shop_domain: string;
      auth_mode: 'access_token' | 'client_credentials';
      access_token_enc: string | null;
      client_id: string | null;
      client_secret_enc: string | null;
    }>(
      'SELECT shop_domain, auth_mode, access_token_enc, client_id, client_secret_enc FROM stores WHERE id = $1',
      [storeId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Store ${storeId} not found`);
    return createShopifyAdmin(
      {
        shopDomain: row.shop_domain,
        authMode: row.auth_mode,
        accessToken: row.access_token_enc ? this.secrets.decrypt(row.access_token_enc) : null,
        clientId: row.client_id,
        clientSecret: row.client_secret_enc ? this.secrets.decrypt(row.client_secret_enc) : null,
      },
      this.opts,
    );
  }
}
