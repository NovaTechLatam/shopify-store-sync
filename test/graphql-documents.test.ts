import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildClientSchema, parse, validate, type IntrospectionQuery } from 'graphql';
import { describe, expect, it } from 'vitest';
import { GRAPHQL_DOCUMENTS } from '../src/shopify/graphql-admin.js';

// Introspection of the Admin API 2026-10 schema (from the @shopify/dev-mcp package).
const introspection = JSON.parse(
  gunzipSync(
    readFileSync(new URL('./fixtures/shopify-admin-2026-10.schema.json.gz', import.meta.url)),
  ).toString(),
) as { data?: IntrospectionQuery } & IntrospectionQuery;
const schema = buildClientSchema(introspection.data ?? introspection);

describe('GraphQL documents', () => {
  for (const [name, source] of Object.entries(GRAPHQL_DOCUMENTS)) {
    it(`${name} is valid against Admin API 2026-10`, () => {
      const errors = validate(schema, parse(source)).map((e) => e.message);
      expect(errors).toEqual([]);
    });
  }

  it('never uses inventory fields removed in 2026-04', () => {
    for (const source of Object.values(GRAPHQL_DOCUMENTS)) {
      expect(source).not.toMatch(/compareQuantity|ignoreCompareQuantity/);
    }
  });
});
