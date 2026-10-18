/** Pure helpers of the order history import (no database, no Shopify). */

const DAY_MS = 24 * 60 * 60_000;

/** Shopify gives orders created in the last 60 days, unless the app has read_all_orders. */
export const SHOPIFY_ORDER_DAYS = 60;

/**
 * Where a store's history import starts: `salesHistoryDays` back from `now`, cut to Shopify's 60
 * days without the read_all_orders scope (`capped` then says the setting asked for more).
 */
export function historyWindow(
  now: Date,
  salesHistoryDays: number,
  grantedScopes: readonly string[] | null,
): { from: Date; days: number; capped: boolean } {
  const allOrders = grantedScopes?.includes('read_all_orders') ?? false;
  const days = allOrders ? salesHistoryDays : Math.min(salesHistoryDays, SHOPIFY_ORDER_DAYS);
  return { from: new Date(now.getTime() - days * DAY_MS), days, capped: days < salesHistoryDays };
}

/**
 * Splits a byte stream into text lines (a bulk export's JSONL), decoding UTF-8 across chunk
 * boundaries; a trailing '\r' is dropped. Never holds more than one chunk plus a partial line.
 */
export async function* readLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of body) {
    const parts = (rest + decoder.decode(chunk, { stream: true })).split('\n');
    rest = parts.pop() ?? '';
    for (const line of parts) yield line.endsWith('\r') ? line.slice(0, -1) : line;
  }
  rest += decoder.decode();
  if (rest) yield rest.endsWith('\r') ? rest.slice(0, -1) : rest;
}
