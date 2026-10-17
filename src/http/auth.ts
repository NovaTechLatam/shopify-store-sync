import type { FastifyReply, FastifyRequest } from 'fastify';
import { safeEqual } from '../util/crypto.js';

const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 20;

/**
 * HTTP Basic auth for the dashboard and admin API, with a small per-IP lockout after repeated
 * failures so the password can't be brute-forced.
 */
export function basicAuth(username: string, password: string) {
  const failures = new Map<string, { count: number; since: number }>();

  return async function check(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const ip = request.ip;
    const now = Date.now();
    if (failures.size > 10_000) {
      for (const [key, value] of failures) if (now - value.since > WINDOW_MS) failures.delete(key);
    }
    const record = failures.get(ip);
    if (record && now - record.since > WINDOW_MS) failures.delete(ip);
    if ((failures.get(ip)?.count ?? 0) >= MAX_FAILURES) {
      await reply
        .code(429)
        .send({ error: 'Too many failed login attempts. Try again in a few minutes.' });
      return;
    }

    if (credentialsMatch(request.headers.authorization, username, password)) {
      failures.delete(ip);
      return;
    }
    if (request.headers.authorization) {
      const current = failures.get(ip) ?? { count: 0, since: now };
      current.count++;
      failures.set(ip, current);
    }
    await reply
      .code(401)
      .header('WWW-Authenticate', 'Basic realm="Store Sync", charset="UTF-8"')
      .send({ error: 'Authentication required' });
  };
}

function credentialsMatch(header: string | undefined, username: string, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  // Evaluate both comparisons so timing doesn't reveal which one failed.
  const userOk = safeEqual(decoded.slice(0, sep), username);
  const passOk = safeEqual(decoded.slice(sep + 1), password);
  return userOk && passOk;
}
