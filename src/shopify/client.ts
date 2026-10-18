import type { Logger } from 'pino';

export type FetchFn = typeof fetch;

/**
 * Why a Shopify call failed, from the sync engine's point of view:
 * - `auth`: token rejected / missing scopes (store needs attention; retrying won't help).
 * - `store_unavailable`: shop frozen, closed, not found (402/403/404/423).
 * - `transient`: network error, timeout, 5xx, throttling after retries. Outcome of a mutation is UNKNOWN.
 * - `invalid`: our request was rejected as malformed (GraphQL validation errors). A bug.
 */
export type ShopifyErrorKind = 'auth' | 'store_unavailable' | 'transient' | 'invalid';

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly kind: ShopifyErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

export interface ShopifyUserError {
  code: string | null;
  field: string[] | null;
  message: string;
}

/**
 * Shopify understood the request but refused it (a mutation's userErrors: duplicate handle,
 * invalid barcode...). Nothing was changed; retrying the same request won't help.
 */
export class ShopifyUserErrors extends ShopifyApiError {
  constructor(
    message: string,
    readonly errors: ShopifyUserError[],
  ) {
    super(message, 'invalid');
    this.name = 'ShopifyUserErrors';
  }
}

/**
 * Shopify is already running as many bulk exports for our app on this store as it allows
 * (OPERATION_IN_PROGRESS, LIMIT_REACHED). Nothing was started; trying again later works, hence
 * `transient`.
 */
export class BulkOperationInProgressError extends ShopifyApiError {
  constructor(message: string) {
    super(message, 'transient');
    this.name = 'BulkOperationInProgressError';
  }
}

export interface TokenProvider {
  /** Returns a valid Admin API access token. `forceRefresh` discards any cached token. */
  getToken(forceRefresh?: boolean): Promise<string>;
}

/** A permanent Admin API access token (legacy custom app or OAuth offline token). */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
}

/**
 * Client credentials grant for Dev Dashboard apps installed on stores owned by the same
 * organization. Tokens live ~24h; we refresh 5 minutes before expiry or on a 401.
 */
export class ClientCredentialsTokenProvider implements TokenProvider {
  private cached?: { token: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(
    private readonly shopDomain: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && this.cached.expiresAt > this.now())
      return this.cached.token;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://${this.shopDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ShopifyApiError(`Token request failed: ${(err as Error).message}`, 'transient');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const kind: ShopifyErrorKind = res.status >= 500 || res.status === 429 ? 'transient' : 'auth';
      throw new ShopifyApiError(
        `Token request failed with HTTP ${res.status}: ${body.slice(0, 300)}`,
        kind,
        res.status,
      );
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new ShopifyApiError('Token response had no access_token', 'auth');
    const lifetimeMs = (json.expires_in ?? 86_399) * 1000;
    this.cached = {
      token: json.access_token,
      expiresAt: this.now() + Math.max(lifetimeMs - 5 * 60_000, 60_000),
    };
    return json.access_token;
  }
}

interface GraphqlError {
  message: string;
  extensions?: { code?: string };
}

interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: GraphqlError[];
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: ThrottleStatus } };
}

export interface ShopifyGraphqlClientOptions {
  shopDomain: string;
  apiVersion: string;
  tokens: TokenProvider;
  fetchFn?: FetchFn;
  logger?: Logger;
  /** Retries for throttling, 5xx and network errors. */
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Minimal GraphQL Admin API client with cost-based throttling: it remembers the last reported
 * bucket state and waits before sending a query that would be throttled, and retries THROTTLED,
 * 429, 5xx and network failures with backoff.
 *
 * Retrying a mutation is only safe because every mutation we send either carries an idempotency
 * key or writes absolute values / upserts by identifier (see the ShopifyAdmin methods).
 */
export class ShopifyGraphqlClient {
  readonly shopDomain: string;
  private readonly endpoint: string;
  /** Also used for uploads to Shopify's file storage (staged uploads), which take no token. */
  readonly fetchFn: FetchFn;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private bucket?: ThrottleStatus & { at: number };
  /** Points of requests sent but not answered yet. */
  private reserved = 0;
  private versionWarned = false;

  constructor(private readonly opts: ShopifyGraphqlClientOptions) {
    this.shopDomain = opts.shopDomain;
    this.endpoint = `https://${opts.shopDomain}/admin/api/${opts.apiVersion}/graphql.json`;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxRetries = opts.maxRetries ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /**
   * `once`: a request that must not reach Shopify twice (a product write that may create one). A
   * network error, a timeout, a 5xx answer or an unreadable one may mean it got through, so it
   * isn't sent again here: it fails as transient, and the caller looks before trying again. Only
   * throttling (429, THROTTLED), which Shopify refuses before doing anything, is retried.
   * `timeoutMs` overrides the client's for this request.
   */
  async request<T>(
    query: string,
    variables: Record<string, unknown> = {},
    estimatedCost = 10,
    opts: { once?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    // Retries of failures that may mean the request was carried out.
    const unsureRetries = opts.once ? 0 : this.maxRetries;
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      const release = await this.reserveBudget(estimatedCost);
      // Backing off gives the reserved points back first, so a retry wait doesn't hold them.
      const pause = (ms: number) => {
        release();
        return this.sleep(ms);
      };
      try {
        const token = await this.opts.tokens.getToken(false);
        let res: Response;
        try {
          res = await this.fetchFn(this.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-Shopify-Access-Token': token,
            },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
          });
        } catch (err) {
          if (attempt < unsureRetries) {
            await pause(backoffMs(attempt));
            continue;
          }
          throw new ShopifyApiError(
            `Network error calling Shopify: ${(err as Error).message}`,
            'transient',
          );
        }

        if (res.status === 401 && !authRetried) {
          // Expired/rotated token: refresh once (no-op for static tokens) and retry.
          authRetried = true;
          release();
          await this.opts.tokens.getToken(true);
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          throw new ShopifyApiError(
            `Shopify rejected the credentials (HTTP ${res.status}). Check the access token and API scopes.`,
            'auth',
            res.status,
          );
        }
        if (res.status === 402 || res.status === 404 || res.status === 423) {
          throw new ShopifyApiError(
            `Shop ${this.shopDomain} is unavailable (HTTP ${res.status}).`,
            'store_unavailable',
            res.status,
          );
        }
        if (res.status === 429 || res.status >= 500) {
          if (attempt < (res.status === 429 ? this.maxRetries : unsureRetries)) {
            const retryAfter = Number(res.headers.get('retry-after'));
            await pause(
              Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : backoffMs(attempt),
            );
            continue;
          }
          throw new ShopifyApiError(`Shopify returned HTTP ${res.status}`, 'transient', res.status);
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new ShopifyApiError(
            `Shopify returned HTTP ${res.status}: ${body.slice(0, 300)}`,
            'invalid',
            res.status,
          );
        }

        // Shopify silently serves a newer version once ours is retired; mutation semantics may differ.
        const served = res.headers.get('x-shopify-api-version');
        if (served && served !== this.opts.apiVersion && !this.versionWarned) {
          this.versionWarned = true;
          this.opts.logger?.warn(
            { requested: this.opts.apiVersion, served },
            'Shopify served a different API version; update SHOPIFY_API_VERSION',
          );
        }

        let json: GraphqlResponse<T>;
        try {
          json = (await res.json()) as GraphqlResponse<T>;
        } catch (err) {
          if (attempt < unsureRetries) {
            await pause(backoffMs(attempt));
            continue;
          }
          throw new ShopifyApiError(
            `Invalid JSON from Shopify: ${(err as Error).message}`,
            'transient',
          );
        }
        const throttle = json.extensions?.cost?.throttleStatus;
        if (throttle) this.bucket = { ...throttle, at: Date.now() };
        release();

        if (json.errors?.length) {
          const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED');
          if (throttled) {
            if (attempt < this.maxRetries + 5) {
              const needed = json.extensions?.cost?.requestedQueryCost ?? estimatedCost;
              await this.sleep(this.msUntilAvailable(needed) || backoffMs(attempt));
              continue;
            }
            throw new ShopifyApiError('Shopify API rate limit exceeded', 'transient', 200);
          }
          const internal = json.errors.some((e) => e.extensions?.code === 'INTERNAL_SERVER_ERROR');
          if (internal && attempt < unsureRetries) {
            await this.sleep(backoffMs(attempt));
            continue;
          }
          const access = json.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED');
          const message = json.errors.map((e) => e.message).join('; ');
          throw new ShopifyApiError(
            `Shopify GraphQL error: ${message}`,
            access ? 'auth' : internal ? 'transient' : 'invalid',
          );
        }
        if (json.data === undefined)
          throw new ShopifyApiError('Shopify response had no data', 'transient');
        return json.data;
      } finally {
        release();
      }
    }
  }

  /** Milliseconds until the bucket (as last reported, minus points reserved) holds `cost`. */
  private msUntilAvailable(cost: number): number {
    if (!this.bucket) return 0;
    const elapsed = (Date.now() - this.bucket.at) / 1000;
    const available =
      Math.min(
        this.bucket.maximumAvailable,
        this.bucket.currentlyAvailable + elapsed * this.bucket.restoreRate,
      ) - this.reserved;
    if (available >= cost) return 0;
    return Math.ceil(((cost - available) / Math.max(this.bucket.restoreRate, 1)) * 1000);
  }

  /**
   * Waits until the bucket can pay for a request, then reserves its estimated cost until the
   * response arrives, so concurrent callers sharing this client (workers, tasks) don't all spend
   * the same points and get throttled together. Returns the release function.
   */
  private async reserveBudget(cost: number): Promise<() => void> {
    const need = Math.min(cost, this.bucket?.maximumAvailable ?? cost);
    for (let i = 0, ms = this.msUntilAvailable(need); ms > 0 && i < 20; i++) {
      await this.sleep(ms);
      if (this.reserved === 0) break; // nothing else in flight: the wait above was enough
      ms = this.msUntilAvailable(need);
    }
    this.reserved += need;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved -= need;
    };
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}
