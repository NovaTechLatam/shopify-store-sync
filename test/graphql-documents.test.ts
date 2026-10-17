import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  NoDeprecatedCustomRule,
  buildClientSchema,
  parse,
  validate,
  type IntrospectionQuery,
} from 'graphql';
import { describe, expect, it } from 'vitest';
import { GRAPHQL_DOCUMENTS } from '../src/shopify/graphql-admin.js';

// Introspection of the Admin API 2026-10 schema (from the @shopify/dev-mcp package).
const introspection = JSON.parse(
  gunzipSync(
    readFileSync(new URL('./fixtures/shopify-admin-2026-10.schema.json.gz', import.meta.url)),
  ).toString(),
) as { data?: IntrospectionQuery } & IntrospectionQuery;
const schema = buildClientSchema(introspection.data ?? introspection);

/**
 * Deprecated fields still in use, on purpose. The stock sync's variant reads use
 * ProductVariant.barcode (deprecated in 2026-10 for `barcodes`, still served, returns the first
 * barcode). Replacing it with `barcodes(first: 1)` adds a connection per variant: about 3 more
 * points each, which would push a 200-variant page past Shopify's 1,000-point query limit and
 * double what a catalog sync spends of the rate limit it shares with stock writes. Move them when
 * the field is removed (the next API version bump shows it), together with smaller pages.
 */
const ALLOWED_DEPRECATED: Record<string, string[]> = {
  variants: ['ProductVariant.barcode'],
  productVariants: ['ProductVariant.barcode'],
  inventoryItemVariants: ['ProductVariant.barcode'],
};

describe('GraphQL documents', () => {
  for (const [name, source] of Object.entries(GRAPHQL_DOCUMENTS)) {
    it(`${name} is valid against Admin API 2026-10`, () => {
      const errors = validate(schema, parse(source)).map((e) => e.message);
      expect(errors).toEqual([]);
    });

    it(`${name} uses no deprecated fields or values`, () => {
      const allowed = ALLOWED_DEPRECATED[name] ?? [];
      const errors = validate(schema, parse(source), [NoDeprecatedCustomRule])
        .map((e) => e.message)
        .filter((m) => !allowed.some((field) => m.startsWith(`The field ${field} is deprecated`)));
      expect(errors).toEqual([]);
    });
  }

  it('never uses inventory fields removed in 2026-04', () => {
    for (const source of Object.values(GRAPHQL_DOCUMENTS)) {
      expect(source).not.toMatch(/compareQuantity|ignoreCompareQuantity/);
    }
  });

  it('only allows deprecated fields that are actually used', () => {
    for (const [name, fields] of Object.entries(ALLOWED_DEPRECATED)) {
      const messages = validate(
        schema,
        parse(GRAPHQL_DOCUMENTS[name as keyof typeof GRAPHQL_DOCUMENTS]),
        [NoDeprecatedCustomRule],
      ).map((e) => e.message);
      for (const field of fields)
        expect(messages.some((m) => m.startsWith(`The field ${field} is deprecated`))).toBe(true);
    }
  });
});
