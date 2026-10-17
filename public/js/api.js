import { h } from './dom.js';
import { toast } from './toast.js';

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export const isAbort = (err) => err?.name === 'AbortError';

/**
 * Calls the admin API (same origin, so the browser sends the Basic auth login) and returns the
 * parsed JSON. Failed changes (non-GET requests) show an error toast unless `toastErrors: false`
 * (forms that show the error inline); failed reads are rendered by the view that asked.
 */
export async function api(path, { method = 'GET', body, signal, toastErrors } = {}) {
  // The server refuses changes without this header: another website can't add it to a form
  // post, so it can't act with the merchant's saved login (CSRF).
  const headers = { Accept: 'application/json', 'X-Requested-With': 'store-sync' };
  const init = { method, headers, signal, credentials: 'same-origin', cache: 'no-store' };
  // Only send a JSON content type with a body: Fastify rejects an empty JSON body.
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(path, init);
    if (res.status === 401) {
      showSignedOut();
      throw new ApiError(401, 'You are signed out. Reload the page to sign in again.');
    }
    const data = res.status === 204 ? null : await readJson(res);
    if (!res.ok) throw new ApiError(res.status, errorMessage(res.status, data), data);
    return data;
  } catch (err) {
    if (isAbort(err)) throw err;
    const error =
      err instanceof ApiError
        ? err
        : new ApiError(0, 'Can’t reach the server. Check your internet connection and try again.');
    if ((toastErrors ?? method !== 'GET') && error.status !== 401) {
      toast(error.message, { tone: 'error' });
    }
    throw error;
  }
}

/**
 * Wraps a loader so each call aborts the previous one still in flight: when filters change
 * quickly, or reloads overlap, only the newest response is rendered. `fn` gets the call's signal,
 * which is also aborted when `parent` is (the merchant left the page).
 */
export function latestOnly(parent, fn) {
  let current = null;
  return (...args) => {
    current?.abort();
    const controller = new AbortController();
    current = controller;
    if (parent.aborted) controller.abort();
    else {
      parent.addEventListener('abort', () => controller.abort(), {
        once: true,
        signal: controller.signal,
      });
    }
    return fn(controller.signal, ...args);
  };
}

/** Builds "?a=1&b=2" from the non-empty values. */
export function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(status, data) {
  if (typeof data?.error === 'string' && data.error) return data.error;
  if (status === 429) return 'Too many requests. Wait a minute and try again.';
  if (status >= 500) return 'Something went wrong on the server. Try again in a moment.';
  return `The request failed (error ${status}).`;
}

let signedOutShown = false;

/** The login (HTTP Basic) expired or changed: every further request would fail the same way. */
function showSignedOut() {
  if (signedOutShown) return;
  signedOutShown = true;
  document.body.append(
    h(
      'div',
      { class: 'signed-out', role: 'alert' },
      h('p', {}, 'You are signed out. Reload the page to sign in again.'),
      h(
        'button',
        { type: 'button', class: 'button button-primary', onclick: () => location.reload() },
        'Reload',
      ),
    ),
  );
}
