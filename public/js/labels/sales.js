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
  sales_import_failed: {
    label: 'Order history not imported',
    tone: 'warning',
    link: () => ({ href: '#/reports', label: 'Open Reports' }),
  },
};

/** Activity (inventory event) kind → label, also listed in the Activity page's filter. */
export const EVENT_KINDS = {};

/** { title, tone, icon } for an activity entry of this feature's kinds, else null. */
export function describeEvent(_e) {
  return null;
}
