import { badge } from './ui.js';
import { signed } from './format.js';

/** Plain-language names for the codes the API returns. */

const STORE_STATUS = {
  active: { label: 'Active', tone: 'success', icon: 'check' },
  paused: { label: 'Paused', tone: 'neutral', icon: 'pause' },
  error: { label: 'Can’t connect', tone: 'critical', icon: 'error' },
  disconnected: { label: 'Disconnected', tone: 'critical', icon: 'error' },
};

export function storeStatusBadge(status) {
  const s = STORE_STATUS[status] ?? { label: status, tone: 'neutral', icon: 'info' };
  return badge(s.label, s.tone, s.icon);
}

export const hasMappedLocation = (store) =>
  store.locations.some((l) => l.isActive && l.warehouseId !== null);

/** What the merchant should do about a store, or null when it's healthy. */
export function storeProblem(store) {
  if (store.status === 'error') {
    return {
      tone: 'critical',
      title: 'We can’t connect to this store',
      hint: 'On the store’s page, click “Test connection”. If the app’s access was removed, enter new credentials under “Update credentials”.',
    };
  }
  if (store.status === 'disconnected') {
    return {
      tone: 'critical',
      title: 'The app was removed from this store',
      hint: 'Install the app on the store again in Shopify, enter the new credentials, then resume the store.',
    };
  }
  if (store.status === 'active' && !hasMappedLocation(store)) {
    return {
      tone: 'warning',
      title: 'No location chosen',
      hint: 'Choose which location of this store holds the shared stock.',
    };
  }
  if (store.status === 'active' && !store.hasWebhookSecret) {
    return {
      tone: 'warning',
      title: 'Live updates can’t be verified',
      hint: 'Add the API secret key under “Update credentials” so we can receive changes instantly.',
    };
  }
  return null;
}

const ALERT_KINDS = {
  low_stock: { label: 'Low stock', tone: 'warning' },
  oversold: { label: 'Oversold', tone: 'critical' },
  store_error: { label: 'Store problem', tone: 'critical' },
  store_unmapped: { label: 'Location not chosen', tone: 'warning' },
  webhook_gap: { label: 'Missed updates', tone: 'warning' },
  webhooks_recreated: { label: 'Updates reconnected', tone: 'info' },
  circuit_breaker: { label: 'Sync paused automatically', tone: 'critical' },
  possible_double_count: { label: 'Possible double count', tone: 'warning' },
  write_rejected: { label: 'Store refused an update', tone: 'critical' },
  stock_count_cancelled: { label: 'Stock count not applied', tone: 'warning' },
  test: { label: 'Test', tone: 'info' },
};

export function alertBadge(kind) {
  const a = ALERT_KINDS[kind] ?? { label: humanize(kind), tone: 'neutral' };
  return badge(
    a.label,
    a.tone,
    a.tone === 'critical' ? 'error' : a.tone === 'warning' ? 'alert' : 'info',
  );
}

export const EVENT_KINDS = {
  external_change: 'Change in a store',
  propagated: 'Stores updated',
  manual_set: 'Stock set',
  stock_count: 'Stock counted',
  stock_count_cancelled: 'Stock count cancelled',
  manual_adjust: 'Stock added or removed',
  initialized: 'Started syncing',
  initialize_failed: 'Could not start syncing',
  store_joined: 'Store joined',
  write_recovered: 'Update confirmed',
  drift_detected: 'Missed changes found',
};

/** Title, tone and icon of an activity entry; the API's own message adds the details. */
export function describeEvent(e) {
  const store = e.storeName ?? 'a store';
  switch (e.kind) {
    case 'external_change':
      return { title: `Change in ${store}`, tone: 'neutral', icon: 'store' };
    case 'propagated':
      return { title: 'Stores updated', tone: 'success', icon: 'refresh' };
    case 'manual_set':
      return { title: 'Stock set from the dashboard', tone: 'info', icon: 'sliders' };
    case 'stock_count':
      return { title: 'Stock counted', tone: 'info', icon: 'sliders' };
    case 'stock_count_cancelled':
      return { title: 'Stock count cancelled', tone: 'warning', icon: 'alert' };
    case 'manual_adjust':
      return {
        title: `${e.delta < 0 ? 'Units removed' : 'Units added'} from the dashboard`,
        tone: 'info',
        icon: 'sliders',
      };
    case 'initialized':
      return { title: 'Started syncing', tone: 'success', icon: 'play' };
    case 'initialize_failed':
      return { title: 'Could not start syncing', tone: 'critical', icon: 'error' };
    case 'store_joined':
      return { title: `${store} joined`, tone: 'info', icon: 'link' };
    case 'write_recovered':
      return { title: `Update to ${store} confirmed`, tone: 'neutral', icon: 'check' };
    case 'drift_detected':
      return { title: `Missed changes found in ${store}`, tone: 'warning', icon: 'alert' };
    default:
      return { title: humanize(e.kind), tone: 'neutral', icon: 'info' };
  }
}

// Sales are routine, so decreases stay neutral rather than alarming red.
export const deltaBadge = (delta) => badge(signed(delta), delta > 0 ? 'success' : 'neutral');

export function humanize(code) {
  const text = String(code ?? '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
