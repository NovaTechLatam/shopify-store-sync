// Mock API for Reports (/api/reports/...), plugged into ../dashboard-mock-api.mjs.

/**
 * Adds this feature's data to a fresh mock state (called at the end of createMockState()).
 * `tools` = { reply, HttpError, paginate, matches, findOr404, minutesAgo, random }.
 */
export function seed(_state, _tools) {}

/**
 * Answers this feature's routes, or returns undefined to let the mock answer 404. `req` =
 * { method, route ('GET /catalog/products/:id'), parts, id, subId, ids, query (URLSearchParams),
 * body (parsed JSON, or a Buffer for image uploads), contentType, state }. Return a body (200),
 * `tools.reply(status, body)`, or throw `new tools.HttpError(status, message, details)`.
 */
export function handle(_req, _tools) {
  return undefined;
}
