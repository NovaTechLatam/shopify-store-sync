/**
 * A request the prices feature refuses, with a message for the dashboard. Its `statusCode` is
 * what the server answers (src/http/server.ts maps any error carrying one).
 */
export class PricingError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}
