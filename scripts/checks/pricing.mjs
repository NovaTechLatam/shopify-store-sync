// Dashboard checks for the prices page, run by ../check-dashboard.mjs.

/** Pages visited at every width and colour scheme: [screenshot name, hash]. */
export const PAGES = [['prices', '#/prices']];

/**
 * Flows at 1280px. `ctx` = { page, go, step, expect, shoot, toastText, waitUntil, settle, server,
 * createMockState, setAllowHttpErrors } (see check-dashboard.mjs for each).
 */
export async function flows(_ctx) {}

/** Flows at 390px (phone), same `ctx`. */
export async function phoneFlows(_ctx) {}
