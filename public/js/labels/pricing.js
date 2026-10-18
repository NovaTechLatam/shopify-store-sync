/**
 * Labels for this feature's alert and activity kinds, merged into labels.js (these take effect
 * before the generic fallback; core kinds keep their own labels). Don't import labels.js here: it
 * imports this file.
 */

/**
 * Alert kind → { label, tone, link } (tone: neutral | success | warning | critical | info; link:
 * alert → { href, label } of the page where it's fixed, or null).
 */
export const ALERT_KINDS = {
  // A sale or a base price change couldn't start (src/pricing/schedules.ts).
  price_schedule_failed: {
    label: 'Sale or price change failed',
    tone: 'critical',
    link: () => ({ href: '#/prices?tab=sales', label: 'Open Sales & changes' }),
  },
  // A scheduled update couldn't write a store's prices (src/pricing/runs.ts).
  price_update_failed: {
    label: 'Prices not updated',
    tone: 'warning',
    link: () => ({ href: '#/prices?tab=history', label: 'Open the price history' }),
  },
};

/** Activity (inventory event) kind → label, also listed in the Activity page's filter. */
export const EVENT_KINDS = {};

/** { title, tone, icon } for an activity entry of this feature's kinds, else null. */
export function describeEvent(_e) {
  return null;
}
