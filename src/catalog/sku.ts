/**
 * SKUs are matched across stores case-insensitively and ignoring surrounding whitespace, so
 * "tee-blk-m " in one store and "TEE-BLK-M" in another are the same item. Blank SKUs never match.
 */
export function normalizeSku(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const sku = raw.trim().replace(/\s+/g, ' ').toUpperCase();
  return sku === '' ? null : sku;
}
