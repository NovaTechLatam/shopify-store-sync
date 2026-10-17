import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Symmetric encryption for secrets stored in the database (Shopify access tokens,
 * client secrets, webhook secrets). AES-256-GCM with a random 12-byte IV.
 *
 * Ciphertext format: "v1:<iv b64>:<auth tag b64>:<ciphertext b64>".
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) {
      throw new Error(
        'ENCRYPTION_KEY must be 32 bytes encoded as base64 (e.g. `openssl rand -base64 32`)',
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const [version, ivB64, tagB64, dataB64] = payload.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || dataB64 === undefined) {
      throw new Error('Unsupported secret format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** Constant-time comparison of two strings (false when lengths differ). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verifies a Shopify webhook signature: base64(HMAC-SHA256(secret, rawBody)) must equal the
 * X-Shopify-Hmac-Sha256 header. The raw, unparsed request body must be used.
 */
export function verifyShopifyHmac(
  rawBody: Buffer,
  hmacHeader: string | undefined,
  secret: string,
): boolean {
  if (!hmacHeader) return false;
  const digest = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(digest, hmacHeader);
}
