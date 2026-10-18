import { createHash } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { CatalogInputError } from './errors.js';
import { imageProblem, MAX_IMAGE_BYTES, safeFilename, sniffImage } from './images.js';

/**
 * Images uploaded from the dashboard (media_files): kept once per content (sha256), whatever
 * product or brand uses them, and uploaded to each store when a product is published there.
 */

export interface StoredImage {
  id: number;
  url: string;
  width: number | null;
  height: number | null;
}

/** Stores an uploaded image (validated by its bytes); the same bytes twice give the same id. */
export async function saveImage(
  db: Queryable,
  data: Buffer,
  filename: string | undefined,
): Promise<StoredImage> {
  if (data.length === 0) throw new CatalogInputError('The file is empty.');
  if (data.length > MAX_IMAGE_BYTES) {
    throw new CatalogInputError('This image is bigger than 20 MB, the most Shopify accepts.');
  }
  const image = sniffImage(data);
  if (!image) {
    throw new CatalogInputError(
      'This file isn’t a JPEG, PNG, WebP or GIF image. Save it in one of those formats and try again.',
    );
  }
  const problem = imageProblem(image);
  if (problem) throw new CatalogInputError(problem);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const inserted = await db.query<{ id: number; width: number | null; height: number | null }>(
    `INSERT INTO media_files (sha256, filename, mime_type, byte_size, width, height, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     -- The same file again: uploaded now (the clean-up of unused uploads counts from here).
     ON CONFLICT (sha256) DO UPDATE SET created_at = now()
     RETURNING id, width, height`,
    [
      sha256,
      safeFilename(filename, image.extension),
      image.mimeType,
      data.length,
      image.width,
      image.height,
      data,
    ],
  );
  const row = inserted.rows[0]!;
  return { id: row.id, url: `/api/catalog/media/${row.id}`, width: row.width, height: row.height };
}

export async function loadImage(
  db: Queryable,
  id: number,
): Promise<{ mimeType: string; data: Buffer } | null> {
  const { rows } = await db.query<{ mime_type: string; data: Buffer }>(
    'SELECT mime_type, data FROM media_files WHERE id = $1',
    [id],
  );
  return rows[0] ? { mimeType: rows[0].mime_type, data: rows[0].data } : null;
}

/**
 * Uploads no product uses (an editor closed without saving, an image removed) are deleted after a
 * day. Batched; an image a product starts using meanwhile is kept by the foreign key.
 */
export async function pruneUnusedImages(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM media_files f
      WHERE f.id IN (SELECT id FROM media_files m
                      WHERE m.created_at < now() - interval '1 day'
                        AND NOT EXISTS (SELECT 1 FROM master_media x WHERE x.file_id = m.id)
                      LIMIT 500)
        AND NOT EXISTS (SELECT 1 FROM master_media x WHERE x.file_id = f.id)`,
  );
  return rowCount ?? 0;
}
