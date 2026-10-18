import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICE_RULE } from '../src/pricing/compute.js';
import {
  contentChanges,
  contentFromShopify,
  contentHash,
  desiredContent,
  optionsOf,
  priceToSend,
  stableJson,
  uniqueTags,
  variantDetailChanges,
  variantPricing,
} from '../src/products/desired.js';
import { imageProblem, safeFilename, sniffImage } from '../src/products/images.js';
import type { MasterProduct, MasterVariant, StoreContext } from '../src/products/model.js';
import { productAdminUrl } from '../src/products/model.js';
import { buildProductSetInput, PENDING_SOURCE, type PlanInput } from '../src/products/plan.js';
import { checkShape } from '../src/products/editor.js';
import type { ShopifyProduct, ShopifyProductVariant } from '../src/shopify/types.js';
import { PNG_1X1 } from './helpers/images.js';

// ---- fixtures ---------------------------------------------------------------------------------

function variant(overrides: Partial<MasterVariant> = {}): MasterVariant {
  const sku = overrides.sku ?? 'TEE-RED-S';
  return {
    id: 1,
    itemId: 1,
    sku,
    normalizedSku: sku.toUpperCase(),
    optionValues: ['Red', 'S'],
    barcode: null,
    weight: null,
    weightUnit: 'GRAMS',
    requiresShipping: true,
    taxable: true,
    position: 0,
    basePrice: 10,
    baseCompareAtPrice: null,
    cost: null,
    ...overrides,
  };
}

function product(overrides: Partial<MasterProduct> = {}): MasterProduct {
  return {
    id: 7,
    title: 'Linen tee',
    descriptionHtml: '<p>Soft linen.</p>',
    vendor: 'Northwind',
    productType: 'Tops',
    tags: ['linen', 'summer'],
    handle: null,
    seoTitle: null,
    seoDescription: null,
    status: 'ACTIVE',
    options: [
      { name: 'Color', values: ['Red', 'Blue'] },
      { name: 'Size', values: ['S', 'M'] },
    ],
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    version: '1',
    variants: [
      variant({ id: 1, itemId: 1, sku: 'TEE-RED-S', optionValues: ['Red', 'S'], position: 0 }),
      variant({ id: 2, itemId: 2, sku: 'tee-red-m', optionValues: ['Red', 'M'], position: 1 }),
      variant({ id: 3, itemId: 3, sku: 'TEE-BLU-S', optionValues: ['Blue', 'S'], position: 2 }),
    ],
    media: [],
    stores: new Map(),
    ...overrides,
  };
}

const store = (overrides: Partial<StoreContext> = {}): StoreContext => ({
  id: 1,
  name: 'Brand A',
  status: 'active',
  shopDomain: 'brand-a.myshopify.com',
  currencyCode: 'USD',
  exchangeRate: 1,
  exchangeRateUnset: false,
  catalogReading: false,
  grantedScopes: null,
  onlineStorePublicationId: null,
  productIdDefinitionAt: null,
  rule: { ...DEFAULT_PRICE_RULE, enabled: true },
  overrides: new Map(),
  locationIds: ['gid://shopify/Location/1'],
  ...overrides,
});

function brand(
  storeId: number,
  overrides: Partial<MasterProduct['stores'] extends Map<number, infer S> ? S : never> = {},
) {
  return {
    storeId,
    enabled: true,
    title: null,
    descriptionHtml: null,
    vendor: null,
    productType: null,
    handle: null,
    seoTitle: null,
    seoDescription: null,
    extraTags: [],
    status: null,
    publishToOnlineStore: true,
    shopifyProductId: null,
    publishState: 'never' as const,
    publishedHash: null,
    publishedAt: null,
    publishedSnapshot: null,
    lastError: null,
    warnings: [],
    mediaLinks: new Map<number, string>(),
    ...overrides,
  };
}

function liveVariant(overrides: Partial<ShopifyProductVariant> = {}): ShopifyProductVariant {
  return {
    id: 'gid://shopify/ProductVariant/11',
    sku: 'TEE-RED-S',
    title: 'Red / S',
    position: 1,
    barcode: null,
    price: 10,
    compareAtPrice: null,
    taxable: true,
    inventoryPolicy: 'DENY',
    selectedOptions: [
      { name: 'Color', value: 'Red' },
      { name: 'Size', value: 'S' },
    ],
    mediaId: null,
    inventoryItemId: 'gid://shopify/InventoryItem/11',
    tracked: true,
    requiresShipping: true,
    weight: null,
    unitCost: null,
    ...overrides,
  };
}

function live(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: 'gid://shopify/Product/100',
    title: 'Linen tee',
    handle: 'linen-tee',
    descriptionHtml: '<p>Soft linen.</p>',
    vendor: 'Northwind',
    productType: 'Tops',
    tags: ['linen', 'summer'],
    status: 'ACTIVE',
    seo: { title: null, description: null },
    options: [
      {
        id: 'gid://shopify/ProductOption/1',
        name: 'Color',
        position: 1,
        values: [
          { id: 'gid://shopify/ProductOptionValue/1', name: 'Red' },
          { id: 'gid://shopify/ProductOptionValue/2', name: 'Blue' },
        ],
      },
      {
        id: 'gid://shopify/ProductOption/2',
        name: 'Size',
        position: 2,
        values: [{ id: 'gid://shopify/ProductOptionValue/3', name: 'S' }],
      },
    ],
    media: [],
    variants: [liveVariant()],
    ...overrides,
  };
}

function plan(p: MasterProduct, overrides: Partial<PlanInput> = {}) {
  const s = store();
  const pricing = new Map(p.variants.map((v) => [v.normalizedSku, variantPricing(v, s, 'USD')]));
  return buildProductSetInput({
    content: desiredContent(p, s.id),
    pricing,
    currencyCode: 'USD',
    live: null,
    mediaLinks: new Map(),
    locationIds: s.locationIds,
    sources: new Map(),
    ...overrides,
  });
}

// ---- images -----------------------------------------------------------------------------------

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment, then a baseline frame header (SOF0) with the size.
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
  ]);
}

describe('sniffImage', () => {
  it('recognises a PNG by its signature and reads its size', () => {
    expect(sniffImage(PNG_1X1)).toEqual({
      mimeType: 'image/png',
      extension: 'png',
      width: 1,
      height: 1,
    });
  });

  it('reads a JPEG size from its frame header, past other segments', () => {
    expect(sniffImage(jpeg(1200, 800))).toMatchObject({
      mimeType: 'image/jpeg',
      width: 1200,
      height: 800,
    });
    // A JPEG cut before its frame header: still a JPEG, size unknown.
    expect(sniffImage(jpeg(1200, 800).subarray(0, 12))).toMatchObject({
      mimeType: 'image/jpeg',
      width: null,
      height: null,
    });
  });

  it('reads GIF and the three WebP flavours', () => {
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00])]);
    expect(sniffImage(gif)).toMatchObject({ mimeType: 'image/gif', width: 320, height: 240 });

    const riff = (chunk: string, body: number[]) =>
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0, 0, 0, 0]),
        Buffer.from('WEBP'),
        Buffer.from(chunk),
        Buffer.from([0, 0, 0, 0]),
        Buffer.from(body),
        Buffer.alloc(16),
      ]);
    // Lossy: frame tag (3 bytes), start code, 14-bit width/height.
    const lossy = riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]);
    expect(sniffImage(lossy)).toMatchObject({ mimeType: 'image/webp', width: 640, height: 480 });
    // Lossless: 0x2f, then (w-1) and (h-1) in 14 bits each: 100 × 50.
    const bits = 99 | (49 << 14);
    const lossless = riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, 0]);
    expect(sniffImage(lossless)).toMatchObject({ width: 100, height: 50 });
    // Extended: 4 flag bytes, then (w-1) and (h-1) in 24 bits: 2000 × 1000.
    const extended = riff('VP8X', [0, 0, 0, 0, 0xcf, 0x07, 0x00, 0xe7, 0x03, 0x00]);
    expect(sniffImage(extended)).toMatchObject({ width: 2000, height: 1000 });
  });

  it('refuses anything else, whatever its name or claimed type', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from('<script>alert(1)</script>'))).toBeNull();
    expect(sniffImage(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });

  it('says why Shopify would refuse an image', () => {
    const big = { mimeType: 'image/png' as const, extension: 'png' as const };
    expect(imageProblem({ ...big, width: 4472, height: 4472 })).toBeNull();
    expect(imageProblem({ ...big, width: 5000, height: 5000 })).toMatch(/20 megapixels/);
    expect(imageProblem({ ...big, width: 2000, height: 10 })).toMatch(/too narrow or too wide/);
    expect(imageProblem({ ...big, width: null, height: null })).toBeNull();
  });

  it('keeps file names to safe characters', () => {
    expect(safeFilename('Café photo (1).JPG', 'jpg')).toBe('Cafe-photo-1.jpg');
    expect(safeFilename('../../etc/passwd', 'png')).toBe('passwd.png');
    expect(safeFilename(undefined, 'webp')).toBe('image.webp');
    expect(safeFilename('<script>.png', 'png')).toBe('script.png');
  });
});

// ---- desired content and its hash --------------------------------------------------------------

describe('desiredContent', () => {
  it('applies a brand’s overlay over the master, adding its tags', () => {
    const p = product();
    p.stores.set(
      2,
      brand(2, { title: 'Linen tee by Harbor', extraTags: ['harbor', 'Linen'], status: 'DRAFT' }),
    );
    const content = desiredContent(p, 2);
    expect(content.title).toBe('Linen tee by Harbor');
    expect(content.vendor).toBe('Northwind');
    expect(content.status).toBe('DRAFT');
    // Tags are case-insensitive in Shopify: "Linen" is the master's "linen". A set: in order.
    expect(content.tags).toEqual(['harbor', 'linen', 'summer']);
    expect(desiredContent(p, 3).title).toBe('Linen tee');
  });

  it('puts the brand’s own images before the shared ones, each in position order', () => {
    const media = (id: number, storeId: number | null, position: number) => ({
      id,
      storeId,
      position,
      alt: `image ${id}`,
      fileId: id,
      sourceUrl: null,
      optionValue: null,
      filename: 'x.png',
      mimeType: 'image/png',
      width: 1,
      height: 1,
    });
    const p = product({
      media: [media(1, null, 1), media(2, null, 0), media(3, 2, 1), media(4, 2, 0), media(5, 3, 0)],
    });
    expect(desiredContent(p, 2).images.map((i) => i.mediaId)).toEqual([4, 3, 2, 1]);
    expect(desiredContent(p, 9).images.map((i) => i.mediaId)).toEqual([2, 1]);
  });

  it('hashes the same content the same way, whatever the key order', () => {
    expect(stableJson({ b: 1, a: [2, { d: 1, c: null }] })).toBe(
      '{"a":[2,{"c":null,"d":1}],"b":1}',
    );
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([k, v]) => [k, reverseKeys(v)]),
            )
          : value;
    const a = desiredContent(product(), 1);
    const b = reverseKeys(a) as typeof a;
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
    expect(contentHash(b)).toBe(contentHash(a));
  });

  it('changes the hash for content, not for prices or costs', () => {
    const base = contentHash(desiredContent(product(), 1));
    const repriced = product();
    repriced.variants[0]!.basePrice = 99;
    repriced.variants[0]!.cost = 3;
    expect(contentHash(desiredContent(repriced, 1))).toBe(base);
    const renamed = product({ title: 'Linen T-shirt' });
    expect(contentHash(desiredContent(renamed, 1))).not.toBe(base);
    const reordered = product();
    reordered.variants.reverse().forEach((v, i) => (v.position = i));
    expect(contentHash(desiredContent(reordered, 1))).not.toBe(base);
  });

  it('dedupes tags case-insensitively, keeping the first spelling', () => {
    expect(uniqueTags([' Summer', 'summer', '', 'SALE', 'sale '])).toEqual(['Summer', 'SALE']);
  });

  it('ignores the order of tags (Shopify keeps a set, listed alphabetically)', () => {
    const p = product({ tags: ['summer', 'Linen'] });
    const sorted = product({ tags: ['Linen', 'summer'] });
    expect(desiredContent(p, 1).tags).toEqual(['Linen', 'summer']);
    expect(contentHash(desiredContent(p, 1))).toBe(contentHash(desiredContent(sorted, 1)));
  });
});

describe('prices', () => {
  it('uses the store’s rule, or a fixed price for the store', () => {
    const v = variant({ basePrice: 12.34, baseCompareAtPrice: 20 });
    const cop = store({
      currencyCode: 'COP',
      exchangeRate: 4000,
      rule: {
        ...DEFAULT_PRICE_RULE,
        enabled: true,
        roundMode: 'ending',
        roundStep: 1000,
        roundEnding: 900,
        roundDirection: 'up',
      },
    });
    const pricing = variantPricing(v, cop, 'COP');
    expect(pricing.target).toMatchObject({ status: 'ok', price: 49_900, compareAtPrice: 80_900 });
    expect(priceToSend(pricing, true)).toEqual({ price: 49_900, compareAtPrice: 80_900 });

    const fixed = variantPricing(
      v,
      store({ overrides: new Map([[1, { price: 9.5, compareAtPrice: null }]]) }),
      'USD',
    );
    expect(priceToSend(fixed, true)).toEqual({ price: 9.5, compareAtPrice: null });
  });

  it('leaves an existing variant’s price alone when the rule is off', () => {
    const pricing = variantPricing(variant(), store({ rule: null }), 'USD');
    expect(priceToSend(pricing, true)).toBeUndefined();
    // A new variant still needs a price: the converted base price.
    expect(
      priceToSend(
        variantPricing(variant(), store({ rule: null, exchangeRate: 950 }), 'CLP'),
        false,
      ),
    ).toEqual({
      price: 9500,
      compareAtPrice: null,
    });
  });

  it('has no price for a new variant without a base price', () => {
    const pricing = variantPricing(variant({ basePrice: null }), store(), 'USD');
    expect(priceToSend(pricing, false)).toBeNull();
    expect(
      priceToSend(
        variantPricing(variant({ basePrice: null }), store({ rule: null }), 'USD'),
        false,
      ),
    ).toBeNull();
  });

  it('keeps the store’s compare-at price when the rule says so', () => {
    const keep = store({ rule: { ...DEFAULT_PRICE_RULE, enabled: true, compareAtMode: 'keep' } });
    expect(priceToSend(variantPricing(variant(), keep, 'USD'), true)).toEqual({
      price: 10,
      compareAtPrice: undefined,
    });
  });

  it('converts the cost to the store’s currency', () => {
    expect(variantPricing(variant({ cost: 2.5 }), store({ exchangeRate: 4100 }), 'COP').cost).toBe(
      10_250,
    );
  });
});

// ---- the productSet input -----------------------------------------------------------------------

describe('buildProductSetInput: a new product', () => {
  it('creates every variant tracked, at 0 in the synced locations, never selling out of stock', () => {
    const result = plan(product());
    expect(result.mode).toBe('create');
    expect(result.removedVariants).toEqual([]);
    expect(result.problems).toEqual([]);
    const v = result.input.variants![0]!;
    expect(v.id).toBeUndefined();
    expect(v.sku).toBe('TEE-RED-S');
    expect(v.inventoryPolicy).toBe('DENY');
    expect(v.inventoryQuantities).toEqual([
      { locationId: 'gid://shopify/Location/1', name: 'available', quantity: 0 },
    ]);
    expect(v.inventoryItem).toEqual({ tracked: true, requiresShipping: true });
    expect(v.barcodes).toEqual([]);
    expect(v.price).toBe('10.00');
    expect(v.optionValues).toEqual([
      { optionName: 'Color', name: 'Red' },
      { optionName: 'Size', name: 'S' },
    ]);
    // SKUs go as typed: Shopify keeps their case.
    expect(result.input.variants![1]!.sku).toBe('tee-red-m');
    expect(result.input.productOptions).toEqual([
      { name: 'Color', position: 1, values: [{ name: 'Red' }, { name: 'Blue' }] },
      { name: 'Size', position: 2, values: [{ name: 'S' }, { name: 'M' }] },
    ]);
    // Not managed: Shopify makes the handle from the title.
    expect(result.input.handle).toBeUndefined();
    expect(result.input.tags).toEqual(['linen', 'summer']);
  });

  it('gives a product without options Shopify’s default option', () => {
    const p = product({ options: [], variants: [variant({ optionValues: [] })] });
    const result = plan(p);
    expect(result.input.productOptions).toEqual([
      { name: 'Title', position: 1, values: [{ name: 'Default Title' }] },
    ]);
    expect(result.input.variants![0]!.optionValues).toEqual([
      { optionName: 'Title', name: 'Default Title' },
    ]);
  });

  it('sends the barcode, weight and cost', () => {
    const p = product({
      variants: [variant({ barcode: '4006381333931', weight: 250, weightUnit: 'GRAMS', cost: 4 })],
    });
    const v = plan(p).input.variants![0]!;
    expect(v.barcodes).toEqual([{ value: '4006381333931' }]);
    expect(v.inventoryItem).toEqual({
      tracked: true,
      requiresShipping: true,
      cost: '4.00',
      measurement: { weight: { unit: 'GRAMS', value: 250 } },
    });
  });

  it('refuses a new variant without any price', () => {
    const p = product({ variants: [variant({ basePrice: null })] });
    expect(plan(p).problems).toEqual([
      'SKU TEE-RED-S has no price for this store: set its base price first.',
    ]);
  });

  it('uploads images, and gives each variant the image of its option value', () => {
    const p = product({
      media: [
        {
          id: 5,
          storeId: null,
          position: 0,
          alt: 'Red tee',
          fileId: 9,
          sourceUrl: null,
          optionValue: 'Red',
          filename: 'red.png',
          mimeType: 'image/png',
          width: 1,
          height: 1,
        },
        {
          id: 6,
          storeId: null,
          position: 1,
          alt: 'Blue tee',
          fileId: null,
          sourceUrl: 'https://cdn.shopify.com/blue.jpg',
          optionValue: 'Blue',
          filename: null,
          mimeType: null,
          width: null,
          height: null,
        },
      ],
    });
    const sources = new Map([
      [5, { originalSource: 'https://staged.example/red.png', filename: 'red.png' }],
      [6, { originalSource: 'https://cdn.shopify.com/blue.jpg' }],
    ]);
    const result = plan(p, { sources });
    expect(result.newImages).toEqual([5, 6]);
    expect(result.input.files).toEqual([
      {
        originalSource: 'https://staged.example/red.png',
        alt: 'Red tee',
        contentType: 'IMAGE',
        filename: 'red.png',
      },
      { originalSource: 'https://cdn.shopify.com/blue.jpg', alt: 'Blue tee', contentType: 'IMAGE' },
    ]);
    // A variant's file is the same input as in `files` (Shopify requires it).
    expect(result.input.variants![0]!.file).toEqual(result.input.files![0]);
    expect(result.input.variants![2]!.file).toEqual(result.input.files![1]);
    // Without a source yet (a preview): a placeholder, never a real URL.
    expect(plan(p).input.files![0]!.originalSource).toBe(`${PENDING_SOURCE}/5`);
  });
});

describe('buildProductSetInput: updating the store’s product', () => {
  it('keeps each existing variant (matched by SKU, any case) with its id', () => {
    const existing = live({
      variants: [
        liveVariant(),
        liveVariant({
          id: 'gid://shopify/ProductVariant/12',
          sku: 'TEE-RED-M',
          inventoryItemId: 'gid://shopify/InventoryItem/12',
        }),
      ],
    });
    const result = plan(product(), { live: existing });
    expect(result.mode).toBe('update');
    expect(result.input.variants!.map((v) => v.id)).toEqual([
      'gid://shopify/ProductVariant/11',
      'gid://shopify/ProductVariant/12',
      undefined,
    ]);
    // Existing variants: no stock or out-of-stock policy sent (that's the stock sync's job).
    expect(result.input.variants![0]!.inventoryQuantities).toBeUndefined();
    expect(result.input.variants![0]!.inventoryPolicy).toBeUndefined();
    expect(result.input.variants![2]!.inventoryQuantities).toHaveLength(1);
    expect(result.addedVariants).toEqual(['TEE-BLU-S']);
    expect(result.removedVariants).toEqual([]);
    // Options and values the product has go by id.
    expect(result.input.productOptions![0]).toEqual({
      id: 'gid://shopify/ProductOption/1',
      name: 'Color',
      position: 1,
      values: [
        { id: 'gid://shopify/ProductOptionValue/1', name: 'Red' },
        { id: 'gid://shopify/ProductOptionValue/2', name: 'Blue' },
      ],
    });
    expect(result.input.productOptions![1]!.values).toEqual([
      { id: 'gid://shopify/ProductOptionValue/3', name: 'S' },
      { name: 'M' },
    ]);
  });

  it('lists exactly the variants Shopify will delete: other SKUs, no SKU, a duplicate', () => {
    const existing = live({
      variants: [
        liveVariant(),
        liveVariant({
          id: 'v-dup',
          sku: 'tee-red-s',
          title: 'Red / S (copy)',
          inventoryItemId: 'i-dup',
        }),
        liveVariant({
          id: 'v-old',
          sku: 'TEE-GRN-S',
          title: 'Green / S',
          inventoryItemId: 'i-old',
        }),
        liveVariant({ id: 'v-none', sku: null, title: 'Sample', inventoryItemId: 'i-none' }),
      ],
    });
    const result = plan(product(), { live: existing });
    expect(result.removedVariants).toEqual([
      { id: 'v-dup', sku: 'tee-red-s', title: 'Red / S (copy)', inventoryItemId: 'i-dup' },
      { id: 'v-old', sku: 'TEE-GRN-S', title: 'Green / S', inventoryItemId: 'i-old' },
      { id: 'v-none', sku: null, title: 'Sample', inventoryItemId: 'i-none' },
    ]);
    expect(result.input.variants!.map((v) => v.id)).not.toContain('v-dup');
  });

  it('keeps linked images by id, re-adds images the store lost, and lists images it deletes', () => {
    const media = (id: number, alt: string) => ({
      id,
      storeId: null,
      position: id,
      alt,
      fileId: id,
      sourceUrl: null,
      optionValue: null,
      filename: 'a.png',
      mimeType: 'image/png',
      width: 1,
      height: 1,
    });
    const p = product({ media: [media(1, 'Front'), media(2, 'Back')] });
    const existing = live({
      media: [
        { id: 'gid://shopify/MediaImage/1', alt: 'Front', status: 'READY', url: 'https://cdn/1' },
        {
          id: 'gid://shopify/MediaImage/9',
          alt: 'Added in Shopify',
          status: 'READY',
          url: 'https://cdn/9',
        },
      ],
    });
    const links = new Map([
      [1, 'gid://shopify/MediaImage/1'],
      [2, 'gid://shopify/MediaImage/2'], // deleted in the store since
    ]);
    const result = plan(p, { live: existing, mediaLinks: links });
    expect(result.input.files![0]).toEqual({ id: 'gid://shopify/MediaImage/1', alt: 'Front' });
    expect(result.input.files![1]!.originalSource).toBe(`${PENDING_SOURCE}/2`);
    expect(result.keptImages).toEqual(new Map([[1, 'gid://shopify/MediaImage/1']]));
    expect(result.newImages).toEqual([2]);
    expect(result.removedImages).toEqual([
      { id: 'gid://shopify/MediaImage/9', alt: 'Added in Shopify', url: 'https://cdn/9' },
    ]);
  });

  it('sends again an image Shopify failed to process, and deletes the broken one', () => {
    const p = product({
      media: [
        {
          id: 1,
          storeId: null,
          position: 0,
          alt: 'Front',
          fileId: 1,
          sourceUrl: null,
          optionValue: null,
          filename: 'a.png',
          mimeType: 'image/png',
          width: 1,
          height: 1,
        },
      ],
    });
    const existing = live({
      media: [{ id: 'gid://shopify/MediaImage/1', alt: 'Front', status: 'FAILED', url: null }],
    });
    const result = plan(p, {
      live: existing,
      mediaLinks: new Map([[1, 'gid://shopify/MediaImage/1']]),
    });
    expect(result.newImages).toEqual([1]);
    expect(result.input.files![0]!.originalSource).toBe(`${PENDING_SOURCE}/1`);
    expect(result.removedImages).toEqual([
      { id: 'gid://shopify/MediaImage/1', alt: 'Front', url: null },
    ]);
  });

  it('leaves prices alone where the store has no rule, and says which prices change', () => {
    const existing = live({ variants: [liveVariant({ price: 12 })] });
    const off = buildProductSetInput({
      content: desiredContent(product(), 1),
      pricing: new Map(
        product().variants.map((v) => [
          v.normalizedSku,
          variantPricing(v, store({ rule: null }), 'USD'),
        ]),
      ),
      currencyCode: 'USD',
      live: existing,
      mediaLinks: new Map(),
      locationIds: [],
      sources: new Map(),
    });
    expect(off.input.variants![0]!.price).toBeUndefined();
    expect(off.input.variants![0]!.compareAtPrice).toBeUndefined();
    // The new ones still need one: base × rate.
    expect(off.input.variants![1]!.price).toBe('10.00');

    const on = plan(product(), { live: existing });
    expect(on.input.variants![0]!.price).toBe('10.00');
    expect(on.input.variants![0]!.compareAtPrice).toBeNull();
    expect(on.priceChanges[0]).toEqual({
      sku: 'TEE-RED-S',
      from: { price: 12, compareAtPrice: null },
      to: { price: 10, compareAtPrice: null },
    });
  });

  it('asks Shopify to redirect the old address when a managed handle changes', () => {
    const p = product({ handle: 'linen-tee-2026' });
    expect(plan(p, { live: live() }).input).toMatchObject({
      handle: 'linen-tee-2026',
      redirectNewHandle: true,
    });
    expect(plan(p).input.redirectNewHandle).toBeUndefined();
  });
});

// ---- comparing with what the store has -----------------------------------------------------------

describe('contentFromShopify', () => {
  it('describes the store’s product like ours, so an import matches what we would send', () => {
    const shopify = live({
      variants: [liveVariant()],
      media: [
        { id: 'gid://shopify/MediaImage/1', alt: 'Front', status: 'READY', url: 'https://cdn/1' },
        { id: 'gid://shopify/MediaImage/2', alt: '', status: 'READY', url: 'https://cdn/2' },
      ],
    });
    const content = contentFromShopify(shopify, {
      images: new Map([['gid://shopify/MediaImage/1', { mediaId: 3, optionValue: 'Red' }]]),
      handleManaged: false,
      onlineStore: true,
    });
    expect(content.options).toEqual([
      { name: 'Color', values: ['Red'] },
      { name: 'Size', values: ['S'] },
    ]);
    expect(content.images).toEqual([{ mediaId: 3, alt: 'Front', optionValue: 'Red' }]);
    expect(content.handle).toBeNull();
    expect(content.variants).toEqual([
      {
        sku: 'TEE-RED-S',
        optionValues: ['Red', 'S'],
        barcode: null,
        weight: null,
        requiresShipping: true,
        taxable: true,
      },
    ]);
  });

  it('sees no options in Shopify’s lone “Title” option', () => {
    const single = live({
      options: [
        {
          id: 'o',
          name: 'Title',
          position: 1,
          values: [{ id: 'v', name: 'Default Title' }],
        },
      ],
      variants: [liveVariant({ selectedOptions: [{ name: 'Title', value: 'Default Title' }] })],
    });
    expect(optionsOf(single)).toEqual([]);
    expect(
      contentFromShopify(single, { images: new Map(), handleManaged: false, onlineStore: true })
        .variants[0]!.optionValues,
    ).toEqual([]);
  });

  it('lists the fields and variants that differ', () => {
    const before = desiredContent(product(), 1);
    const p = product({ title: 'Linen T-shirt', tags: ['linen'] });
    p.variants[0]!.barcode = '123';
    const after = desiredContent(p, 1);
    expect(contentChanges(before, after)).toEqual([
      { field: 'title', label: 'Title', from: 'Linen tee', to: 'Linen T-shirt' },
      { field: 'tags', label: 'Tags', from: 'linen, summer', to: 'linen' },
    ]);
    expect(variantDetailChanges(before, after)).toEqual(['TEE-RED-S']);
    expect(contentChanges(before, before)).toEqual([]);
  });
});

describe('checkShape', () => {
  const opts = [{ name: 'Size', values: ['S', 'M'] }];
  const v = (sku: string, values: string[]) => ({ sku, optionValues: values });

  it('accepts a consistent product', () => {
    expect(() => checkShape(opts, [v('A', ['S']), v('B', ['M'])])).not.toThrow();
    expect(() => checkShape([], [v('A', [])])).not.toThrow();
  });

  it('names what to fix', () => {
    expect(() => checkShape(opts, [v('A', ['S']), v('a', ['M'])])).toThrow(
      'SKU a is used by two variants',
    );
    expect(() => checkShape(opts, [v('A', ['S']), v('B', ['S'])])).toThrow('Two variants are “S”');
    expect(() => checkShape(opts, [v('A', ['XL'])])).toThrow('“XL”, which isn’t one of the Size');
    expect(() => checkShape(opts, [v('A', [])])).toThrow('needs a value for each option');
    expect(() => checkShape([], [v('A', []), v('B', [])])).toThrow('single variant');
    expect(() =>
      checkShape([...opts, { name: 'size', values: ['x'] }], [v('A', ['S', 'x'])]),
    ).toThrow('two options called “size”');
    expect(() => checkShape([{ name: 'Size', values: ['S', 's'] }], [v('A', ['S'])])).toThrow(
      '“s” is listed twice',
    );
  });
});

describe('productAdminUrl', () => {
  it('links to the product in the store’s admin', () => {
    expect(productAdminUrl('brand.myshopify.com', 'gid://shopify/Product/123')).toBe(
      'https://brand.myshopify.com/admin/products/123',
    );
    expect(productAdminUrl('brand.myshopify.com', null)).toBeNull();
  });
});
