// Mock API for Catalog (/api/catalog/...), plugged into ../dashboard-mock-api.mjs. Same routes and
// response shapes as src/http/api/catalog.ts, with products in every state: published, changed
// (content and prices), failed in one brand, a draft never published, archived, publishing now,
// and one imported from a store.

const CDN = 'https://cdn.shopify.com/s/files/1/0000/mock';
const STATUS = ['ACTIVE', 'DRAFT', 'ARCHIVED'];
const OVERLAY_KEYS = [
  'title',
  'descriptionHtml',
  'vendor',
  'productType',
  'handle',
  'seoTitle',
  'seoDescription',
  'status',
];
// How many reads a queued publish takes to finish (so the dashboard sees it progress).
const PUBLISH_READS = 2;

const decimals = (currency) => (currency === 'CLP' || currency === 'JPY' ? 0 : 2);
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Adds this feature's data to a fresh mock state (called at the end of createMockState()).
 * `tools` = { reply, HttpError, paginate, matches, findOr404, minutesAgo, random }.
 */
export function seed(state, { minutesAgo }) {
  const catalog = {
    products: [],
    files: new Map(),
    nextIds: { product: 1, variant: 1, media: 1, file: 1, item: 1000 },
  };
  state.catalog = catalog;
  const itemBySku = new Map(state.items.map((i) => [i.sku, i]));
  const now = minutesAgo(0);

  const add = (p) => {
    const id = catalog.nextIds.product++;
    const product = {
      id,
      descriptionHtml: '',
      vendor: '',
      productType: '',
      tags: [],
      handle: null,
      seoTitle: null,
      seoDescription: null,
      status: 'ACTIVE',
      options: [],
      createdAt: minutesAgo(60 * 24 * 20),
      updatedAt: minutesAgo(60 * 5),
      media: [],
      brands: {},
      ...p,
    };
    product.version = String(Date.parse(product.updatedAt));
    product.variants = p.variants.map((v, position) => {
      const item = itemBySku.get(v.sku);
      return {
        id: catalog.nextIds.variant++,
        itemId: item?.id ?? catalog.nextIds.item++,
        barcode: null,
        weight: null,
        weightUnit: 'GRAMS',
        requiresShipping: true,
        taxable: true,
        baseCompareAtPrice: null,
        cost: null,
        stock: item ? item.quantity : null,
        stockStarted: item ? item.quantity !== null : false,
        // New to Store Sync, or no store has it yet: its first publish starts it at 0.
        stockStartsAtZero:
          !item ||
          (item.quantity === null &&
            !state.variants.some((x) => x.itemId === item.id && !x.deleted)),
        position,
        ...v,
      };
    });
    product.media = (p.media ?? []).map((m, position) => ({
      id: catalog.nextIds.media++,
      storeId: null,
      position,
      alt: '',
      optionValue: null,
      fileId: null,
      url: m.sourceUrl,
      width: null,
      height: null,
      ...m,
    }));
    for (const store of state.stores) {
      const brand = product.brands[store.id] ?? { enabled: false };
      product.brands[store.id] = {
        enabled: false,
        overlay: {},
        extraTags: [],
        publishToOnlineStore: true,
        shopifyProductId: null,
        state: 'never',
        changedReason: null,
        publishedAt: null,
        lastError: null,
        warnings: [],
        previewExtras: null,
        ...brand,
      };
    }
    catalog.products.push(product);
    return product;
  };
  const published = (extra = {}) => ({
    enabled: true,
    state: 'published',
    shopifyProductId: `gid://shopify/Product/${8_000_000 + catalog.nextIds.variant}`,
    publishedAt: minutesAgo(60 * 3),
    ...extra,
  });

  const sizes = ['S', 'M', 'L'];
  add({
    title: 'Linen shirt',
    descriptionHtml:
      '<p>A relaxed shirt in <strong>washed linen</strong>, soft from the first wear.</p><ul><li>100% European linen</li><li>Mother-of-pearl buttons</li></ul>',
    vendor: 'Northwind',
    productType: 'Shirts',
    tags: ['linen', 'summer'],
    options: [
      { name: 'Color', values: ['White', 'Sand'] },
      { name: 'Size', values: sizes },
    ],
    variants: ['White', 'Sand'].flatMap((color) =>
      sizes.map((size) => ({
        sku: `SHIRT-LIN-${color.slice(0, 3).toUpperCase()}-${size}`,
        optionValues: [color, size],
        basePrice: 59,
        baseCompareAtPrice: 79,
        cost: 21.5,
        barcode: null,
        weight: 280,
      })),
    ),
    media: [
      {
        sourceUrl: `${CDN}/linen-white.jpg`,
        alt: 'White linen shirt, front',
        optionValue: 'White',
      },
      { sourceUrl: `${CDN}/linen-sand.jpg`, alt: 'Sand linen shirt, front', optionValue: 'Sand' },
      { sourceUrl: `${CDN}/linen-harbor.jpg`, alt: 'Harbor lookbook', storeId: 2 },
    ],
    brands: {
      1: published(),
      2: published({ overlay: { title: 'Harbor linen shirt' }, extraTags: ['harbor'] }),
    },
  });
  add({
    title: 'Organic Tee',
    descriptionHtml: '<p>Organic cotton jersey, garment dyed.</p>',
    vendor: 'Northwind',
    productType: 'T-shirts',
    tags: ['organic'],
    options: [
      { name: 'Color', values: ['Black', 'White', 'Sage'] },
      { name: 'Size', values: sizes },
    ],
    variants: ['Black', 'White', 'Sage'].flatMap((color) =>
      sizes.map((size) => ({
        sku: `TEE-ORG-${color.slice(0, 3).toUpperCase()}-${size}`,
        optionValues: [color, size],
        basePrice: 28,
        cost: 9.4,
      })),
    ),
    media: [
      { sourceUrl: `${CDN}/tee-black.jpg`, alt: 'Black tee', storeId: 1, optionValue: 'Black' },
    ],
    brands: {
      1: published(),
      2: published({
        state: 'changed',
        changedReason: 'content',
        overlay: { title: 'Organic Tee (Harbor)' },
        previewExtras: {
          fields: [
            {
              field: 'title',
              label: 'Title',
              from: 'Organic Tee',
              to: 'Organic Tee (Harbor)',
            },
          ],
        },
      }),
      3: published({
        state: 'failed',
        lastError:
          'Little Fox Kids refused the product: the web address (handle) is already used by another product in Little Fox Kids: choose another handle for this brand.',
      }),
    },
  });
  add({
    title: 'Waxed cap',
    descriptionHtml: '<p>Waxed cotton, adjustable strap.</p>',
    vendor: 'Northwind',
    productType: 'Hats',
    status: 'DRAFT',
    updatedAt: minutesAgo(30),
    variants: [{ sku: 'CAP-WAX-OLI-M', optionValues: [], basePrice: 32 }],
    brands: { 1: { enabled: true }, 2: { enabled: true } },
  });
  add({
    title: 'Merino socks',
    vendor: 'Northwind',
    productType: 'Socks',
    options: [
      { name: 'Color', values: ['Grey', 'Rust'] },
      { name: 'Size', values: sizes },
    ],
    variants: ['Grey', 'Rust'].flatMap((color) =>
      sizes.map((size) => ({
        sku: `SOCK-MER-${color.slice(0, 3).toUpperCase()}-${size}`,
        optionValues: [color, size],
        basePrice: 14,
      })),
    ),
    media: [{ sourceUrl: `${CDN}/socks.jpg`, alt: 'Merino socks' }],
    brands: {
      1: published({
        warnings: [
          'Northwind Apparel hasn’t given Store Sync permission to change what its Online Store shows (write_publications). Do it in Shopify, or add the permission.',
        ],
      }),
      2: published({
        state: 'changed',
        changedReason: 'prices',
        previewExtras: {
          variantsRemoved: [{ sku: 'SOCK-MER-RUS-XL', title: 'Rust / XL' }],
          imagesRemoved: [{ alt: 'Socks on a chair', url: `${CDN}/socks-chair.jpg` }],
        },
      }),
    },
  });
  add({
    title: 'Rain jacket',
    vendor: 'Northwind',
    productType: 'Outerwear',
    status: 'ARCHIVED',
    updatedAt: minutesAgo(60 * 24 * 9),
    options: [{ name: 'Color', values: ['Yellow', 'Black'] }],
    variants: [
      { sku: 'JKT-RAIN-YEL-M', optionValues: ['Yellow'], basePrice: 120 },
      { sku: 'JKT-RAIN-BLA-M', optionValues: ['Black'], basePrice: 120 },
    ],
    brands: { 1: published() },
  });
  add({
    title: 'Canvas tote',
    vendor: 'Northwind',
    productType: 'Bags',
    updatedAt: now,
    variants: [{ sku: 'TOTE-CNV-NAT-M', optionValues: [], basePrice: 24 }],
    media: [{ sourceUrl: `${CDN}/tote.jpg`, alt: 'Canvas tote' }],
    brands: {
      1: { enabled: true, state: 'publishing', readsLeft: PUBLISH_READS },
      2: { enabled: true, state: 'queued', readsLeft: PUBLISH_READS + 1 },
    },
  });
  // Never published: its item has no variant in any store (Products says "Not published yet").
  add({
    title: 'Wool beanie',
    vendor: 'Northwind',
    productType: 'Hats',
    updatedAt: minutesAgo(45),
    variants: [{ sku: 'BEANIE-WOL-RUS', optionValues: [], basePrice: 26, cost: 8 }],
    brands: { 1: { enabled: true }, 2: { enabled: true } },
  });
}

/**
 * Answers this feature's routes, or returns undefined to let the mock answer 404. `req` =
 * { method, route ('GET /catalog/products/:id'), parts, id, subId, ids, query (URLSearchParams),
 * body (parsed JSON, or a Buffer for image uploads), contentType, state }. Return a body (200),
 * `tools.reply(status, body)`, or throw `new tools.HttpError(status, message, details)`.
 */
export function handle(req, tools) {
  const { route, state, query, body } = req;
  if (!route.includes(' /catalog/')) return undefined;
  const catalog = state.catalog;
  const { reply, HttpError, paginate, matches } = tools;
  const find = (id) => {
    const p = catalog.products.find((x) => x.id === Number(id));
    if (!p) throw new HttpError(404, 'Product not found');
    return p;
  };

  switch (route) {
    case 'GET /catalog/products': {
      const status = query.get('status');
      const search = query.get('search');
      const list = catalog.products
        .filter((p) => !status || status === 'all' || p.status === status)
        .filter((p) => matches(search, p.title, ...p.variants.map((v) => v.sku)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
      for (const p of list) advance(p);
      const { page, pageSize, slice } = paginate(list, query);
      return { total: list.length, page, pageSize, products: slice.map((p) => listRow(state, p)) };
    }
    case 'POST /catalog/products': {
      validate(state, body, null, HttpError);
      const product = createProduct(state, body);
      return reply(201, editorView(state, product));
    }
    case 'GET /catalog/products/:id': {
      const p = find(req.id);
      advance(p);
      return editorView(state, p);
    }
    case 'PATCH /catalog/products/:id': {
      const p = find(req.id);
      if (body.version !== undefined && body.version !== p.version) {
        throw new HttpError(
          409,
          'Someone saved this product after you opened it. Reload the page to see their changes, then make yours again.',
        );
      }
      validate(state, { ...p, ...body }, p.id, HttpError);
      updateProduct(state, p, body);
      return editorView(state, p);
    }
    case 'DELETE /catalog/products/:id': {
      const p = find(req.id);
      catalog.products = catalog.products.filter((x) => x !== p);
      return reply(204);
    }
    case 'GET /catalog/products/:id/preview': {
      const p = find(req.id);
      const ids = query.get('storeIds')?.split(',').map(Number);
      return {
        stores: state.stores
          .filter((s) => !ids || ids.includes(s.id))
          .map((s) => previewStore(state, p, s)),
      };
    }
    case 'POST /catalog/products/:id/publish': {
      const p = find(req.id);
      const queued = [];
      const skipped = [];
      for (const storeId of body.storeIds ?? []) {
        const store = state.stores.find((s) => s.id === storeId);
        if (!store)
          throw new HttpError(400, 'One of these stores doesn’t exist any more. Reload the page.');
        const brand = p.brands[storeId];
        if (!brand?.enabled) {
          skipped.push({ storeId, reason: `Not sold in ${store.name}.` });
          continue;
        }
        Object.assign(brand, { state: 'queued', lastError: null, readsLeft: PUBLISH_READS });
        queued.push(storeId);
      }
      return reply(202, { queued, skipped });
    }
    case 'POST /catalog/media': {
      if (!Buffer.isBuffer(body)) {
        throw new HttpError(400, 'Send the image file itself, with an image content type.');
      }
      const image = sniff(body);
      if (!image) {
        throw new HttpError(
          400,
          'This file isn’t a JPEG, PNG, WebP or GIF image. Save it in one of those formats and try again.',
        );
      }
      const id = catalog.nextIds.file++;
      catalog.files.set(id, { data: body, mimeType: image.mimeType });
      return reply(201, {
        id,
        url: `/api/catalog/media/${id}`,
        width: image.width,
        height: image.height,
      });
    }
    case 'GET /catalog/media/:id': {
      const file = catalog.files.get(Number(req.id));
      if (!file) throw new HttpError(404, 'Image not found');
      return reply(200, file.data, {
        'Content-Type': file.mimeType,
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
    }
    case 'GET /catalog/import/search': {
      const storeId = Number(query.get('storeId'));
      if (!state.stores.some((s) => s.id === storeId)) throw new HttpError(404, 'Store not found');
      const search = query.get('search');
      const found = storeProducts(state, storeId).filter((g) =>
        matches(search, g.title, ...g.skus),
      );
      return {
        total: found.length,
        products: found.slice(0, 30).map((g) => ({
          productId: g.productId,
          title: g.title,
          variants: g.variants.length,
          skus: g.skus,
          inCatalog: g.inCatalog,
        })),
      };
    }
    case 'POST /catalog/import': {
      const group = storeProducts(state, body.storeId).find((g) => g.productId === body.productId);
      if (!group) throw new HttpError(404, 'This product isn’t in the store any more.');
      if (group.inCatalog) {
        throw new HttpError(
          409,
          `“${group.title}” is already in the catalog as “${group.inCatalog.title}”.`,
        );
      }
      return reply(201, importGroup(state, body.storeId, group));
    }
    case 'GET /catalog/items/:id': {
      const itemId = Number(req.id);
      if (!state.items.some((i) => i.id === itemId)) throw new HttpError(404, 'Item not found');
      const product = catalog.products.find((p) => p.variants.some((v) => v.itemId === itemId));
      if (product) return { product: listRow(state, product), importable: [] };
      return {
        product: null,
        importable: state.variants
          .filter((v) => v.itemId === itemId && !v.deleted && !v.isBundle)
          .map((v) => ({
            storeId: v.storeId,
            storeName: state.stores.find((s) => s.id === v.storeId)?.name ?? '',
            productId: productIdOf(v),
            productTitle: v.productTitle,
          })),
      };
    }
    default:
      return undefined;
  }
}

// ---- read models -------------------------------------------------------------------------------

/** A publish in progress moves on each time the product is read. */
function advance(p) {
  for (const brand of Object.values(p.brands)) {
    if (brand.state !== 'queued' && brand.state !== 'publishing') continue;
    brand.readsLeft = (brand.readsLeft ?? 1) - 1;
    if (brand.readsLeft > 0) {
      brand.state = 'publishing';
      continue;
    }
    if (brand.failNext) {
      Object.assign(brand, { state: 'failed', lastError: brand.failNext, failNext: null });
    } else {
      Object.assign(brand, {
        state: 'published',
        changedReason: null,
        previewExtras: null,
        publishedAt: new Date().toISOString(),
        shopifyProductId: brand.shopifyProductId ?? `gid://shopify/Product/${9_000_000 + p.id}`,
      });
    }
  }
}

function listRow(state, p) {
  const image = [...p.media].sort(
    (a, b) =>
      (a.storeId === null ? 0 : 1) - (b.storeId === null ? 0 : 1) || a.position - b.position,
  )[0];
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    variants: p.variants.length,
    skus: p.variants.map((v) => v.sku),
    image: image ? { url: image.url, alt: image.alt } : null,
    updatedAt: p.updatedAt,
    stores: state.stores.map((s) => {
      const b = p.brands[s.id] ?? { enabled: false, state: 'never' };
      return {
        storeId: s.id,
        storeName: s.name,
        enabled: b.enabled,
        state: b.state,
        changedReason: b.changedReason ?? null,
        lastError: b.lastError ?? null,
      };
    }),
  };
}

function rule(store) {
  // Northwind: base price as is; Harbor & Pine: COP ending in 900; Little Fox Kids: no rule.
  if (store.id === 1) return { enabled: true, round: (n) => round(n, 2) };
  if (store.id === 2)
    return { enabled: true, round: (n) => Math.ceil((n - 900) / 1000) * 1000 + 900 };
  return null;
}

function prices(store, p, brand) {
  const currency = store.currencyCode ?? 'USD';
  const r = rule(store);
  return p.variants.map((v) => {
    let target;
    if (v.basePrice === null || v.basePrice === undefined) {
      target = r
        ? { status: 'none', reason: 'no_base_price' }
        : { status: 'none', reason: 'rule_disabled' };
    } else if (r) {
      const price = r.round(v.basePrice * store.exchangeRate);
      const compareAt = v.baseCompareAtPrice
        ? r.round(v.baseCompareAtPrice * store.exchangeRate)
        : null;
      target = {
        status: 'ok',
        source: 'rule',
        price,
        compareAtPrice: compareAt && compareAt > price ? compareAt : null,
      };
    } else {
      target = { status: 'none', reason: 'rule_disabled' };
    }
    const fallback =
      v.basePrice === null || v.basePrice === undefined
        ? null
        : {
            price: round(v.basePrice * store.exchangeRate, decimals(currency)),
            compareAtPrice: null,
          };
    let current = null;
    if (brand.shopifyProductId) {
      const now = target.status === 'ok' ? target.price : (fallback?.price ?? 0);
      current = {
        price: brand.changedReason === 'prices' ? round(now * 0.9, decimals(currency)) : now,
        compareAtPrice: null,
      };
    }
    return { variantId: v.id, sku: v.sku, target, fallback, current };
  });
}

function problems(store) {
  const out = [];
  if (store.status === 'paused')
    out.push(`${store.name} is paused. Resume it on its page, then publish again.`);
  if (store.status === 'error') {
    out.push(`${store.name} needs attention: we can’t reach it. Check it on its page first.`);
  }
  if (store.features && !store.features.catalog.available) {
    out.push(
      `“${store.name}” hasn’t given Store Sync permission to create and update its products (${store.features.catalog.missingScopes.join(', ')}). Add it to the app’s access scopes and approve the update in the store’s Shopify admin, then click “Test connection” on the store’s page.`,
    );
  }
  return out;
}

function effective(p, b) {
  const pick = (key) => b.overlay?.[key] ?? p[key];
  const tags = [...p.tags];
  for (const t of b.extraTags ?? [])
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
  return {
    title: pick('title'),
    descriptionHtml: pick('descriptionHtml'),
    vendor: pick('vendor'),
    productType: pick('productType'),
    handle: pick('handle'),
    seoTitle: pick('seoTitle'),
    seoDescription: pick('seoDescription'),
    tags,
    status: pick('status'),
  };
}

function editorView(state, p) {
  return {
    id: p.id,
    title: p.title,
    descriptionHtml: p.descriptionHtml,
    vendor: p.vendor,
    productType: p.productType,
    tags: p.tags,
    handle: p.handle,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    status: p.status,
    options: p.options,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    version: p.version,
    baseCurrency: state.settings.baseCurrency,
    variants: p.variants.map((v) => ({ ...v })),
    media: p.media.map((m) => ({ ...m })),
    stores: state.stores.map((s) => {
      const b = p.brands[s.id];
      return {
        storeId: s.id,
        storeName: s.name,
        storeStatus: s.status,
        currencyCode: s.currencyCode,
        exchangeRate: s.exchangeRate,
        enabled: b.enabled,
        publishToOnlineStore: b.publishToOnlineStore,
        onlineStoreAsFound: b.onlineStoreAsFound ?? false,
        overlay: {
          title: null,
          descriptionHtml: null,
          vendor: null,
          productType: null,
          handle: null,
          seoTitle: null,
          seoDescription: null,
          status: null,
          ...b.overlay,
          extraTags: b.extraTags ?? [],
        },
        effective: effective(p, b),
        shopifyProductId: b.shopifyProductId,
        adminUrl: b.shopifyProductId
          ? `https://${s.shopDomain}/admin/products/${b.shopifyProductId.split('/').pop()}`
          : null,
        state: b.state,
        changedReason: b.changedReason ?? null,
        publishedAt: b.publishedAt,
        lastError: b.lastError,
        warnings: b.warnings ?? [],
        features: {
          catalog: s.features?.catalog ?? { available: true, missingScopes: [] },
          publishing: s.features?.publishing ?? { available: true, missingScopes: [] },
        },
        problems: problems(s),
        prices: prices(s, p, b),
      };
    }),
  };
}

function previewStore(state, p, store) {
  const b = p.brands[store.id];
  const base = {
    storeId: store.id,
    storeName: store.name,
    currencyCode: store.currencyCode,
    title: effective(p, b).title,
    reasons: [],
    notes: [],
    warnings: [],
    fields: [],
    variantsAdded: [],
    variantsRemoved: [],
    variantsUpdated: [],
    imagesAdded: 0,
    imagesRemoved: [],
    prices: [],
    upToDate: false,
  };
  if (!b.enabled) {
    return {
      ...base,
      action: 'skip',
      reasons: [`Not sold in ${store.name}. Turn on “Sell in ${store.name}” to publish there.`],
    };
  }
  const blocked = problems(store);
  if (blocked.length) return { ...base, action: 'blocked', reasons: blocked };
  const images = p.media.filter((m) => m.storeId === null || m.storeId === store.id);
  const priceRows = prices(store, p, b).flatMap((row) => {
    const to =
      row.target.status === 'ok'
        ? row.target.price
        : b.shopifyProductId
          ? null
          : row.fallback?.price;
    if (to === null || to === undefined) return [];
    if (row.current && row.current.price === to) return [];
    return [{ sku: row.sku, from: row.current, to: { price: to, compareAtPrice: null } }];
  });
  if (!b.shopifyProductId) {
    return { ...base, action: 'create', imagesAdded: images.length, prices: priceRows };
  }
  const extras = b.previewExtras ?? {};
  const fields = extras.fields ?? [];
  const variantsRemoved = extras.variantsRemoved ?? [];
  const imagesRemoved = extras.imagesRemoved ?? [];
  return {
    ...base,
    action: 'update',
    fields,
    variantsRemoved,
    imagesRemoved,
    prices: priceRows,
    warnings:
      store.features?.publishing && !store.features.publishing.available
        ? ['The Online Store isn’t updated: permission missing.']
        : [],
    upToDate:
      b.state === 'published' &&
      fields.length === 0 &&
      variantsRemoved.length === 0 &&
      priceRows.length === 0,
  };
}

// ---- writes ------------------------------------------------------------------------------------

const normalize = (sku) =>
  String(sku ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();

function validate(state, body, productId, HttpError) {
  if (!String(body.title ?? '').trim())
    throw new HttpError(400, 'title: Too small: expected string to have >=1 characters');
  const seen = new Set();
  for (const v of body.variants ?? []) {
    const sku = normalize(v.sku);
    if (!sku) throw new HttpError(400, 'Every variant needs a SKU.');
    if (seen.has(sku)) {
      throw new HttpError(
        400,
        `SKU ${String(v.sku).trim()} is used by two variants. Each variant needs its own SKU.`,
      );
    }
    seen.add(sku);
    const owner = state.catalog.products.find(
      (p) => p.id !== productId && p.variants.some((x) => normalize(x.sku) === sku),
    );
    if (owner) {
      throw new HttpError(
        409,
        `SKU ${String(v.sku).trim()} is already in “${owner.title}” in the catalog. A SKU can only be in one catalog product.`,
      );
    }
  }
}

function applyVariants(state, p, variants) {
  const items = new Map(state.items.map((i) => [normalize(i.sku), i]));
  p.variants = variants.map((v, position) => {
    const was = p.variants?.find((x) =>
      v.id ? x.id === v.id : normalize(x.sku) === normalize(v.sku),
    );
    const item = items.get(normalize(v.sku));
    const pick = (key, fallback) => (v[key] !== undefined ? v[key] : (was?.[key] ?? fallback));
    return {
      id: was?.id ?? state.catalog.nextIds.variant++,
      itemId: was?.itemId ?? item?.id ?? state.catalog.nextIds.item++,
      sku: String(v.sku).trim(),
      optionValues: v.optionValues ?? [],
      barcode: pick('barcode', null),
      weight: pick('weight', null),
      weightUnit: pick('weightUnit', 'GRAMS'),
      requiresShipping: pick('requiresShipping', true),
      taxable: pick('taxable', true),
      basePrice: pick('basePrice', item ? null : null),
      baseCompareAtPrice: pick('baseCompareAtPrice', null),
      cost: pick('cost', null),
      stock: was?.stock ?? item?.quantity ?? null,
      stockStarted: was?.stockStarted ?? (item ? item.quantity !== null : false),
      stockStartsAtZero: was?.stockStartsAtZero ?? !item,
      position,
    };
  });
}

function applyMedia(state, p, media) {
  const positions = new Map();
  p.media = media.map((m) => {
    const was = m.id ? p.media.find((x) => x.id === m.id) : null;
    const storeId = m.storeId ?? null;
    const position = positions.get(storeId) ?? 0;
    positions.set(storeId, position + 1);
    const fileId = was?.fileId ?? m.fileId ?? null;
    const sourceUrl = was?.sourceUrl ?? (fileId ? null : m.sourceUrl);
    return {
      id: was?.id ?? state.catalog.nextIds.media++,
      storeId,
      position,
      alt: m.alt ?? '',
      optionValue: m.optionValue ?? null,
      fileId,
      sourceUrl,
      url: fileId ? `/api/catalog/media/${fileId}` : sourceUrl,
      width: null,
      height: null,
    };
  });
  p.media.sort((a, b) => a.position - b.position || a.id - b.id);
}

function applyStores(p, stores) {
  for (const s of stores ?? []) {
    const b = p.brands[s.storeId];
    if (!b) continue;
    if (s.enabled !== undefined) b.enabled = s.enabled;
    if (s.publishToOnlineStore !== undefined && s.publishToOnlineStore !== b.publishToOnlineStore) {
      b.publishToOnlineStore = s.publishToOnlineStore;
      b.onlineStoreAsFound = false;
    }
    if (s.extraTags !== undefined) b.extraTags = s.extraTags;
    for (const key of OVERLAY_KEYS) if (s[key] !== undefined) b.overlay[key] = s[key] || null;
  }
}

function touch(p) {
  p.updatedAt = new Date().toISOString();
  p.version = String(Date.now());
  for (const b of Object.values(p.brands)) {
    if (b.state === 'published') Object.assign(b, { state: 'changed', changedReason: 'content' });
  }
}

function createProduct(state, body) {
  const catalog = state.catalog;
  const p = {
    id: catalog.nextIds.product++,
    title: body.title.trim(),
    descriptionHtml: body.descriptionHtml ?? '',
    vendor: body.vendor ?? '',
    productType: body.productType ?? '',
    tags: body.tags ?? [],
    handle: body.handle ?? null,
    seoTitle: body.seoTitle ?? null,
    seoDescription: body.seoDescription ?? null,
    status: STATUS.includes(body.status) ? body.status : 'DRAFT',
    options: body.options ?? [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: String(Date.now()),
    variants: [],
    media: [],
    brands: {},
  };
  for (const s of state.stores) {
    p.brands[s.id] = {
      enabled: s.status !== 'disconnected',
      overlay: {},
      extraTags: [],
      publishToOnlineStore: true,
      shopifyProductId: null,
      state: 'never',
      changedReason: null,
      publishedAt: null,
      lastError: null,
      warnings: [],
    };
  }
  applyVariants(state, p, body.variants ?? []);
  applyMedia(state, p, body.media ?? []);
  applyStores(p, body.stores);
  catalog.products.push(p);
  return p;
}

function updateProduct(state, p, body) {
  for (const key of [
    'title',
    'descriptionHtml',
    'vendor',
    'productType',
    'tags',
    'handle',
    'seoTitle',
    'seoDescription',
    'status',
    'options',
  ]) {
    if (body[key] !== undefined) p[key] = body[key];
  }
  if (body.variants) applyVariants(state, p, body.variants);
  if (body.media) applyMedia(state, p, body.media);
  applyStores(p, body.stores);
  touch(p);
}

// ---- import ------------------------------------------------------------------------------------

function productIdOf(v) {
  let hash = 0;
  for (const c of `${v.storeId}:${v.productTitle}`)
    hash = (hash * 31 + c.charCodeAt(0)) % 1_000_000;
  return `gid://shopify/Product/${7_000_000 + hash}`;
}

/** A store's products, from its variants (grouped by product title in the mock). */
function storeProducts(state, storeId) {
  const groups = new Map();
  for (const v of state.variants) {
    if (v.storeId !== storeId || v.deleted || v.isBundle) continue;
    const id = productIdOf(v);
    const g = groups.get(id) ?? { productId: id, title: v.productTitle, variants: [], skus: [] };
    g.variants.push(v);
    if (v.sku) g.skus.push(v.sku);
    groups.set(id, g);
  }
  return [...groups.values()]
    .map((g) => {
      const owner = state.catalog.products.find((p) =>
        p.variants.some((x) => g.variants.some((v) => v.itemId !== null && v.itemId === x.itemId)),
      );
      return { ...g, inCatalog: owner ? { id: owner.id, title: owner.title } : null };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function importGroup(state, storeId, group) {
  const store = state.stores.find((s) => s.id === storeId);
  const split = (v) => (v.variantTitle === 'Default Title' ? [] : v.variantTitle.split(' / '));
  const width = Math.max(...group.variants.map((v) => split(v).length));
  const names = width === 2 ? ['Color', 'Size'] : width === 1 ? ['Size'] : [];
  const options = names.map((name, i) => ({
    name,
    values: [...new Set(group.variants.map((v) => split(v)[i]))],
  }));
  const p = createProduct(state, {
    title: group.title.replace(/ \(Harbor\)$/, ''),
    status: 'ACTIVE',
    options,
    variants: group.variants.map((v) => ({
      sku: v.sku,
      optionValues: split(v),
      barcode: v.barcode,
      basePrice: round(30 / store.exchangeRate, 2),
    })),
  });
  const warnings = [];
  const itemIds = new Set(group.variants.map((v) => v.itemId));
  for (const s of state.stores) {
    const sold = state.variants.filter(
      (v) => v.storeId === s.id && itemIds.has(v.itemId) && !v.deleted,
    );
    const b = p.brands[s.id];
    if (sold.length === 0) {
      b.enabled = false;
      continue;
    }
    Object.assign(b, {
      enabled: true,
      state: 'published',
      publishedAt: new Date().toISOString(),
      shopifyProductId: productIdOf(sold[0]),
      onlineStoreAsFound: true,
    });
    if (sold[0].productTitle !== p.title) b.overlay.title = sold[0].productTitle;
    if (s.id !== storeId && sold.length < group.variants.length) {
      Object.assign(b, { state: 'changed', changedReason: 'content' });
      warnings.push(
        `${s.name}’s “${sold[0].productTitle}” has ${sold.length} of the ${group.variants.length} variants: publishing to ${s.name} adds the others.`,
      );
    }
  }
  return { id: p.id, warnings };
}

// ---- images ------------------------------------------------------------------------------------

function sniff(data) {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { mimeType: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mimeType: 'image/jpeg', width: null, height: null };
  }
  if (data.length >= 10 && data.toString('latin1', 0, 4) === 'GIF8') {
    return { mimeType: 'image/gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (data.length >= 12 && data.toString('latin1', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', width: null, height: null };
  }
  return null;
}
