import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { SecretBox } from '../../src/util/crypto.js';
import type { Harness } from './harness.js';
import { silentLogger } from './harness.js';

const AUTH = `Basic ${Buffer.from('admin:correct-horse-battery').toString('base64')}`;

export type ApiCall = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) => Promise<{ status: number; body: any; text: string }>;

/** The dashboard API on top of a harness's database and fake stores, and a way to call it. */
export async function harnessApp(
  h: Harness,
  opts: { onWork?: () => void } = {},
): Promise<{ app: FastifyInstance; api: ApiCall }> {
  const app = await buildServer({
    db: h.db,
    secrets: new SecretBox(Buffer.alloc(32, 7).toString('base64')),
    shopify: Object.assign(h.registry, { invalidate: () => {} }),
    createAdmin: () => {
      throw new Error('not used');
    },
    logger: silentLogger,
    publicUrl: 'https://sync.example.com',
    adminUsername: 'admin',
    adminPassword: 'correct-horse-battery',
    onWork: opts.onWork,
  });
  const api: ApiCall = async (method, url, payload) => {
    const res = await app.inject({
      method,
      url,
      payload: payload as object,
      headers: { authorization: AUTH, 'x-requested-with': 'store-sync' },
    });
    const json = res.headers['content-type']?.toString().startsWith('application/json');
    return {
      status: res.statusCode,
      body: res.body && json ? JSON.parse(res.body) : undefined,
      text: res.body,
    };
  };
  return { app, api };
}
