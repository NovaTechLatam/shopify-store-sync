/**
 * Errors of catalog requests, with messages for the merchant. `statusCode` makes the HTTP layer
 * answer with that status and the message (src/http/server.ts).
 */

export class CatalogInputError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CatalogInputError';
  }
}

export class CatalogConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'CatalogConflictError';
  }
}

export class CatalogNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = 'CatalogNotFoundError';
  }
}

/** A Shopify product couldn't be read for an import; `statusCode` 502 like other Shopify failures. */
export class CatalogShopifyError extends Error {
  readonly statusCode = 502;
  constructor(message: string) {
    super(message);
    this.name = 'CatalogShopifyError';
  }
}
