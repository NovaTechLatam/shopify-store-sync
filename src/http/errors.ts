/** An error with an HTTP status and a message that is safe to show to the dashboard user. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new HttpError(400, message, details);
export const conflict = (message: string) => new HttpError(409, message);

/** Parses a positive integer route/query parameter or throws 400. */
export function parseId(value: unknown, name = 'id'): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0)
    throw badRequest(`Invalid ${name}`);
  return n;
}
