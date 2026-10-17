import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),

  /** Public HTTPS base URL of this service. Shopify sends webhooks to `${PUBLIC_URL}/webhooks/shopify`. */
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),

  /** 32 random bytes, base64. Encrypts Shopify credentials at rest. `openssl rand -base64 32` */
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required'),

  /**
   * Which proxies may tell us the client's IP (X-Forwarded-For), used by the login lockout.
   * Default: only proxies on this machine or a private network (Caddy, Render, Fly, Railway).
   * "true" trusts anyone (only safe if nothing can reach the app except your proxy), "false" none.
   */
  TRUST_PROXY: z
    .string()
    .default('loopback,linklocal,uniquelocal')
    .transform((v): boolean | string => (v === 'true' ? true : v === 'false' ? false : v)),

  /** Dashboard / admin API login (HTTP Basic auth). */
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters'),

  SHOPIFY_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default('2026-10'),

  /** Run the background sync worker in this process. Disable to run web-only replicas. */
  WORKER_ENABLED: bool.default(true),
  /** How many pool levels are reconciled in parallel. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Full drift scan of every store against our baselines. */
  RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(15),
  /** Re-reads the catalog (variants, SKUs, locations) of every store. */
  CATALOG_REFRESH_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(360),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
