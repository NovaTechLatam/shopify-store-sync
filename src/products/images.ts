/**
 * Product images uploaded from the dashboard: what kind of file it really is (from its first
 * bytes, never from the Content-Type the browser sent) and its size in pixels. Pure functions.
 */

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface SniffedImage {
  mimeType: ImageType;
  extension: 'jpg' | 'png' | 'webp' | 'gif';
  /** null when the header doesn't say (cheaply). */
  width: number | null;
  height: number | null;
}

/** Shopify's limits for product images (manage-media guide). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 20_000_000; // 4472 × 4472

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image type and size of `data`, or null if it isn't a JPEG, PNG, WebP or GIF. */
export function sniffImage(data: Buffer): SniffedImage | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg', ...jpegSize(data) };
  }
  if (data.length >= 8 && PNG_SIGNATURE.every((b, i) => data[i] === b)) {
    // The first chunk is always IHDR: width and height, big-endian.
    const size =
      data.length >= 24 && data.toString('latin1', 12, 16) === 'IHDR'
        ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
        : { width: null, height: null };
    return { mimeType: 'image/png', extension: 'png', ...size };
  }
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.toString('latin1', 0, 6))) {
    const size =
      data.length >= 10
        ? { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
        : { width: null, height: null };
    return { mimeType: 'image/gif', extension: 'gif', ...size };
  }
  if (
    data.length >= 12 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: 'webp', ...webpSize(data) };
  }
  return null;
}

type Size = { width: number | null; height: number | null };
const UNKNOWN: Size = { width: null, height: null };

/** Walks the JPEG segments up to the first frame header (SOFn), which holds the size. */
function jpegSize(data: Buffer): Size {
  let at = 2;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) return UNKNOWN;
    const marker = data[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    // Markers without a length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return UNKNOWN; // end, or image data before a frame
    const length = data.readUInt16BE(at + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (at + 9 > data.length) return UNKNOWN;
      return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
    }
    if (length < 2) return UNKNOWN;
    at += 2 + length;
  }
  return UNKNOWN;
}

function webpSize(data: Buffer): Size {
  if (data.length < 30) return UNKNOWN;
  const chunk = data.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Lossy: a key frame starts with 9d 01 2a, then 14-bit width and height.
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return UNKNOWN;
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // Lossless: signature 0x2f, then (width − 1) and (height − 1) in 14 bits each.
    if (data[20] !== 0x2f) return UNKNOWN;
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Extended: canvas (width − 1) and (height − 1) in 24 bits each.
    return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  }
  return UNKNOWN;
}

/**
 * Why Shopify would refuse this image, in words for the merchant (null = fine). Only checks what
 * we know: unknown sizes pass.
 */
export function imageProblem(image: SniffedImage): string | null {
  const { width, height } = image;
  if (width === null || height === null) return null;
  if (width === 0 || height === 0) return 'This image has no pixels.';
  if (width * height > MAX_IMAGE_PIXELS) {
    return (
      `This image is ${width.toLocaleString('en-US')} × ${height.toLocaleString('en-US')} pixels. ` +
      'Shopify accepts up to 20 megapixels (for example 4472 × 4472): make it smaller and upload it again.'
    );
  }
  const ratio = width / height;
  if (ratio > 100 || ratio < 1 / 100) {
    return 'This image is too narrow or too wide for Shopify (at most 100 times wider than tall, or the other way round).';
  }
  return null;
}

/** A file name safe to keep and to send to Shopify: letters, digits, dots, dashes, underscores. */
export function safeFilename(raw: string | undefined, extension: string): string {
  const base = (raw ?? '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^.]*$/, '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${base || 'image'}.${extension}`;
}
