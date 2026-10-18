import { h } from '../dom.js';

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
  reorder: { label: 'Time to reorder', tone: 'warning' },
  cost_push_failed: { label: 'Costs not sent to Shopify', tone: 'warning' },
};

/** Activity (inventory event) kind → label, also listed in the Activity page's filter. */
export const EVENT_KINDS = {
  po_received: 'Delivery received',
  po_receipt_reversed: 'Delivery undone',
};

/** "PO-0007" as a link to the order, when the event says which one. */
function orderLink(e) {
  const id = Number(e.details?.purchaseOrderId);
  const number = e.details?.number;
  if (!Number.isInteger(id) || id <= 0 || typeof number !== 'string') return null;
  return h('a', { href: `#/purchasing/orders/${id}` }, number);
}

/** { title, tone, icon } for an activity entry of this feature's kinds, else null. */
export function describeEvent(e) {
  if (e.kind === 'po_received') {
    const link = orderLink(e);
    return {
      title: link ? ['Delivery received · ', link] : 'Delivery received',
      tone: 'success',
      icon: 'truck',
    };
  }
  if (e.kind === 'po_receipt_reversed') {
    const link = orderLink(e);
    return {
      title: link ? ['Delivery undone · ', link] : 'Delivery undone',
      tone: 'warning',
      icon: 'truck',
    };
  }
  return null;
}
