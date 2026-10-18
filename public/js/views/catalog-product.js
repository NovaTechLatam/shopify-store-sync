import { ApiError, api, apiUpload, latestOnly, qs } from '../api.js';
import { confirmDialog, formDialog } from '../dialog.js';
import { h, icon, replace, uid } from '../dom.js';
import { money, num, plural, timeAgo } from '../format.js';
import { toast } from '../toast.js';
import {
  badge,
  banner,
  button,
  card,
  field,
  input,
  loadInto,
  muted,
  pageHeader,
  replaceHeader,
  select,
  withBusy,
} from '../ui.js';
import {
  STATUS_LABELS,
  isBusy,
  renderSimpleHtml,
  stateBadge,
  statusBadge,
  takeImportWarnings,
  thumb,
} from './catalog-shared.js';

const WEIGHT_UNITS = [
  { value: 'GRAMS', label: 'g' },
  { value: 'KILOGRAMS', label: 'kg' },
  { value: 'OUNCES', label: 'oz' },
  { value: 'POUNDS', label: 'lb' },
];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_OPTIONS = 3;
const MAX_VARIANTS = 250;
const POLL_MS = 2500;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** #/catalog/new and #/catalog/:id: the product editor. */
export async function render({ root, params, signal, setTitle }) {
  const id = params[0] === undefined ? null : Number(params[0]);
  setTitle(id ? 'Product' : 'New product');
  const back = { href: '#/catalog', label: 'Catalog' };
  let header = pageHeader({ title: id ? 'Product' : 'New product', back });
  const body = h('div', { class: 'stack-lg catalog-editor' });
  root.append(header, body);

  const reload = latestOnly(signal, (reqSignal) =>
    loadInto(body, {
      signal: reqSignal,
      load: () =>
        Promise.all([
          id
            ? api(`/api/catalog/products/${id}`, { signal: reqSignal }).catch((err) => {
                if (err.status === 404) {
                  throw new ApiError(
                    404,
                    'This product isn’t in the catalog. It may have been removed.',
                  );
                }
                throw err;
              })
            : null,
          api('/api/stores', { signal: reqSignal }),
          api('/api/settings', { signal: reqSignal }),
        ]),
      render: ([product, stores, settings]) => {
        const editor = createEditor({ product, stores, settings, signal, reload, back });
        setTitle(editor.title);
        header = replaceHeader(header, editor.header);
        return editor.nodes;
      },
    }),
  );
  await reload();
}

// ---- the model ------------------------------------------------------------------------------

const comboKey = (values) => values.join('\u0001');
const comboLabel = (values) => (values.length ? values.join(' / ') : 'Default');
const splitList = (text) => [
  ...new Set(
    String(text ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];
const moneyText = (n) => (n === null || n === undefined ? '' : String(n));
const parseAmount = (text) => {
  const t = String(text ?? '').trim();
  if (t === '') return null;
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
};
const normalizeSku = (sku) => sku.trim().replace(/\s+/g, ' ').toUpperCase();
let rowKeys = 0;

function newVariant(optionValues) {
  return {
    key: ++rowKeys,
    id: undefined,
    sku: '',
    optionValues,
    barcode: '',
    weight: '',
    weightUnit: 'GRAMS',
    requiresShipping: true,
    taxable: true,
    basePrice: '',
    baseCompareAtPrice: '',
    cost: '',
    stock: null,
    stockStarted: false,
    saved: { basePrice: null, baseCompareAtPrice: null, cost: null },
  };
}

/** The editor's working copy (strings where the merchant types). */
function toModel(product, stores) {
  const storeViews = new Map((product?.stores ?? []).map((s) => [s.storeId, s]));
  return {
    id: product?.id ?? null,
    version: product?.version,
    title: product?.title ?? '',
    descriptionHtml: product?.descriptionHtml ?? '',
    vendor: product?.vendor ?? '',
    productType: product?.productType ?? '',
    tags: (product?.tags ?? []).join(', '),
    handle: product?.handle ?? '',
    seoTitle: product?.seoTitle ?? '',
    seoDescription: product?.seoDescription ?? '',
    status: product?.status ?? 'DRAFT',
    options: (product?.options ?? []).map((o) => ({ name: o.name, values: [...o.values] })),
    variants: product
      ? product.variants.map((v) => ({
          key: ++rowKeys,
          id: v.id,
          sku: v.sku,
          optionValues: [...v.optionValues],
          barcode: v.barcode ?? '',
          weight: v.weight === null ? '' : String(v.weight),
          weightUnit: v.weightUnit,
          requiresShipping: v.requiresShipping,
          taxable: v.taxable,
          basePrice: moneyText(v.basePrice),
          baseCompareAtPrice: moneyText(v.baseCompareAtPrice),
          cost: moneyText(v.cost),
          stock: v.stock,
          stockStarted: v.stockStarted,
          stockStartsAtZero: v.stockStartsAtZero,
          saved: {
            basePrice: v.basePrice,
            baseCompareAtPrice: v.baseCompareAtPrice,
            cost: v.cost,
          },
        }))
      : [newVariant([])],
    removedCombos: new Set(),
    media: (product?.media ?? []).map((m) => ({ key: ++rowKeys, ...m })),
    stores: stores.map((store) => {
      const view = storeViews.get(store.id);
      const overlay = view?.overlay ?? {};
      return {
        storeId: store.id,
        storeName: store.name,
        store,
        view,
        enabled: view ? view.enabled : store.status !== 'disconnected',
        publishToOnlineStore: view?.publishToOnlineStore ?? true,
        overlay: {
          title: overlay.title ?? '',
          descriptionHtml: overlay.descriptionHtml ?? '',
          vendor: overlay.vendor ?? '',
          productType: overlay.productType ?? '',
          handle: overlay.handle ?? '',
          seoTitle: overlay.seoTitle ?? '',
          seoDescription: overlay.seoDescription ?? '',
          extraTags: (overlay.extraTags ?? []).join(', '),
          status: overlay.status ?? '',
        },
      };
    }),
  };
}

/** Everything that is saved, to tell whether something changed. */
function snapshot(model) {
  return JSON.stringify({
    ...model,
    removedCombos: undefined,
    stores: model.stores.map((s) => ({ ...s, store: undefined, view: undefined })),
    variants: model.variants.map((v) => ({ ...v, key: undefined, stock: undefined })),
    media: model.media.map((m) => ({ ...m, key: undefined })),
  });
}

/** The request body (create or update). Prices only when they changed: the Prices page edits them too. */
function requestBody(model) {
  const blank = (v) => (String(v ?? '').trim() === '' ? null : String(v).trim());
  return {
    ...(model.id ? { version: model.version } : {}),
    title: model.title.trim(),
    descriptionHtml: model.descriptionHtml,
    vendor: model.vendor.trim(),
    productType: model.productType.trim(),
    tags: splitList(model.tags),
    handle: blank(model.handle),
    seoTitle: blank(model.seoTitle),
    seoDescription: blank(model.seoDescription),
    status: model.status,
    options: model.options,
    variants: model.variants.map((v) => {
      const out = {
        ...(v.id ? { id: v.id } : {}),
        sku: v.sku.trim(),
        optionValues: v.optionValues,
        barcode: blank(v.barcode),
        weight: parseAmount(v.weight),
        weightUnit: v.weightUnit,
        requiresShipping: v.requiresShipping,
        taxable: v.taxable,
      };
      for (const key of ['basePrice', 'baseCompareAtPrice', 'cost']) {
        const value = parseAmount(v[key]);
        // A new product sends what was typed; an existing one only what changed.
        if (model.id ? value !== v.saved[key] : value !== null) out[key] = value;
      }
      return out;
    }),
    stores: model.stores.map((s) => ({
      storeId: s.storeId,
      enabled: s.enabled,
      title: blank(s.overlay.title),
      descriptionHtml: blank(s.overlay.descriptionHtml),
      vendor: blank(s.overlay.vendor),
      productType: blank(s.overlay.productType),
      handle: blank(s.overlay.handle),
      seoTitle: blank(s.overlay.seoTitle),
      seoDescription: blank(s.overlay.seoDescription),
      extraTags: splitList(s.overlay.extraTags),
      status: s.overlay.status || null,
      publishToOnlineStore: s.publishToOnlineStore,
    })),
    media: model.media.map((m) => ({
      ...(m.id ? { id: m.id } : m.fileId ? { fileId: m.fileId } : { sourceUrl: m.sourceUrl }),
      storeId: m.storeId,
      alt: m.alt.trim(),
      optionValue: m.optionValue || null,
    })),
  };
}

/** The first problem with what was typed: { message, focus } (null = fine). */
function validate(model, form) {
  const at = (selector) => form.querySelector(selector);
  if (!model.title.trim())
    return { message: 'Give the product a title.', focus: at('[name=title]') };
  if (model.handle.trim() && !HANDLE.test(model.handle.trim())) {
    return {
      message: 'Use lowercase letters, numbers and hyphens for the web address, like linen-shirt.',
      focus: at('[name=handle]'),
    };
  }
  const names = new Set();
  for (const [i, o] of model.options.entries()) {
    if (!o.name.trim()) {
      return {
        message: `Give option ${i + 1} a name, like Size.`,
        focus: at(`[data-option-name="${i}"]`),
      };
    }
    if (names.has(o.name.trim().toLowerCase())) {
      return {
        message: `There are two options called “${o.name}”. Rename one.`,
        focus: at(`[data-option-name="${i}"]`),
      };
    }
    names.add(o.name.trim().toLowerCase());
    if (o.values.length === 0) {
      return {
        message: `Give ${o.name} at least one value, like S, M, L.`,
        focus: at(`[data-option-values="${i}"]`),
      };
    }
  }
  if (model.variants.length === 0) {
    return { message: 'Keep at least one variant.', focus: null };
  }
  const skus = new Map();
  for (const v of model.variants) {
    const label = comboLabel(v.optionValues);
    const sku = normalizeSku(v.sku);
    if (!sku) {
      return {
        message: `Enter a SKU for ${label}. It’s how each brand’s variant is matched to the shared stock.`,
        focus: at(`[data-row="${v.key}"][data-field=sku]`),
      };
    }
    if (skus.has(sku)) {
      return {
        message: `SKU ${v.sku.trim()} is used twice. Each variant needs its own SKU.`,
        focus: at(`[data-row="${v.key}"][data-field=sku]`),
      };
    }
    skus.set(sku, v);
    for (const [key, what] of [
      ['basePrice', 'price'],
      ['baseCompareAtPrice', 'compare-at price'],
      ['cost', 'cost'],
      ['weight', 'weight'],
    ]) {
      if (Number.isNaN(parseAmount(v[key]))) {
        return {
          message: `Enter the ${what} of ${v.sku.trim()} as a number, like 12.50 (or leave it empty).`,
          focus: at(`[data-row="${v.key}"][data-field=${key}]`),
        };
      }
    }
  }
  for (const s of model.stores) {
    const handle = s.overlay.handle.trim();
    if (handle && !HANDLE.test(handle)) {
      return {
        message: `Use lowercase letters, numbers and hyphens for ${s.storeName}’s web address.`,
        focus: at(`[name="handle-${s.storeId}"]`),
      };
    }
  }
  return null;
}

function cartesian(lists) {
  return lists.reduce(
    (acc, values) => acc.flatMap((prefix) => values.map((v) => [...prefix, v])),
    [[]],
  );
}

// ---- the editor -----------------------------------------------------------------------------

function createEditor({ product, stores, settings, signal, reload, back }) {
  const model = toModel(product, stores);
  const isNew = model.id === null;
  const baseCurrency = product?.baseCurrency ?? settings.baseCurrency;
  let saved = snapshot(model);
  const isDirty = () => isNew || snapshot(model) !== saved;
  // Closing or reloading the tab with unsaved edits asks first (the browser's own question).
  window.addEventListener(
    'beforeunload',
    (event) => {
      if (snapshot(model) !== saved) event.preventDefault();
    },
    { signal },
  );
  const stateSlots = new Map();

  const formError = h('div', {
    class: 'form-error form-error-large',
    role: 'alert',
    tabindex: '-1',
    hidden: true,
  });
  const showError = (message, focus) => {
    replace(formError, icon('error'), h('div', {}, h('p', {}, message)));
    formError.hidden = false;
    (focus ?? formError).focus();
    if (focus) focus.scrollIntoView({ block: 'center' });
  };

  // ---- header ----
  const publishButton =
    !isNew &&
    button('Publish…', {
      variant: 'primary',
      iconName: 'upload',
      onClick: () => {
        if (isDirty()) {
          toast('Save your changes first, then publish.', { tone: 'error' });
          return;
        }
        openPublish(publishButton).catch(() => {});
      },
    });
  const header = pageHeader({
    title: isNew ? 'New product' : product.title,
    subtitle: isNew
      ? 'Write it once: options, variants and SKUs are shared by every brand.'
      : h(
          'span',
          {},
          `${plural(product.variants.length, 'variant')} · saved `,
          timeAgo(product.updatedAt),
        ),
    back,
    badges: isNew ? [] : [statusBadge(product.status)],
    actions: publishButton ? [publishButton] : [],
  });

  // ---- basics ----
  const bind = (control, read) => {
    control.addEventListener('input', () => read(control));
    return control;
  };
  const titleInput = bind(input({ name: 'title', value: model.title, maxlength: 255 }), (c) => {
    model.title = c.value;
    refreshPlaceholders();
  });
  const preview = h('div', { class: 'html-preview', 'aria-live': 'polite' });
  const description = bind(
    h('textarea', {
      class: 'input textarea',
      name: 'descriptionHtml',
      rows: 6,
      value: model.descriptionHtml,
      spellcheck: 'true',
    }),
    (c) => {
      model.descriptionHtml = c.value;
      renderPreview();
      refreshPlaceholders();
    },
  );
  const renderPreview = () => {
    const content = renderSimpleHtml(model.descriptionHtml);
    if (content.childNodes.length === 0) replace(preview, muted('The description appears here.'));
    else replace(preview, content);
  };
  renderPreview();
  const vendor = bind(input({ name: 'vendor', value: model.vendor, maxlength: 255 }), (c) => {
    model.vendor = c.value;
    refreshPlaceholders();
  });
  const productType = bind(
    input({
      name: 'productType',
      value: model.productType,
      maxlength: 255,
      placeholder: 'e.g. T-shirts',
    }),
    (c) => {
      model.productType = c.value;
      refreshPlaceholders();
    },
  );
  const tags = bind(
    input({ name: 'tags', value: model.tags, placeholder: 'e.g. linen, summer' }),
    (c) => {
      model.tags = c.value;
    },
  );
  const status = select(
    Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
    { name: 'status', value: model.status },
  );
  status.addEventListener('change', () => {
    model.status = status.value;
    refreshPlaceholders();
  });
  const handle = bind(
    input({
      name: 'handle',
      value: model.handle,
      placeholder: 'Made from the title',
      autocomplete: 'off',
      spellcheck: 'false',
    }),
    (c) => {
      model.handle = c.value;
      refreshPlaceholders();
    },
  );
  const seoTitle = bind(input({ name: 'seoTitle', value: model.seoTitle, maxlength: 255 }), (c) => {
    model.seoTitle = c.value;
    refreshPlaceholders();
  });
  const seoDescription = bind(
    h('textarea', {
      class: 'input textarea',
      name: 'seoDescription',
      rows: 2,
      value: model.seoDescription,
      maxlength: 1000,
    }),
    (c) => {
      model.seoDescription = c.value;
      refreshPlaceholders();
    },
  );

  const basics = card(
    {
      title: 'Basics',
      description: 'The default for every brand. Each brand can use its own below.',
    },
    h(
      'div',
      { class: 'stack' },
      field({ label: 'Title', control: titleInput }),
      h(
        'div',
        { class: 'description-editor' },
        field({
          label: 'Description',
          control: description,
          hint: 'Simple HTML: <p>, <strong>, <em>, <ul>/<ol> with <li>, <a href="https://…">, <h2>–<h4>.',
        }),
        h(
          'div',
          { class: 'field' },
          h('p', { class: 'field-label', id: uid('preview') }, 'Preview'),
          preview,
        ),
      ),
      h(
        'div',
        { class: 'grid-2' },
        field({ label: 'Vendor', control: vendor, optional: true }),
        field({ label: 'Product type', control: productType, optional: true }),
      ),
      h(
        'div',
        { class: 'grid-2' },
        field({ label: 'Tags', control: tags, optional: true, hint: 'Separate tags with commas.' }),
        field({
          label: 'Status',
          control: status,
          hint: 'Draft products aren’t for sale. Archived ones are hidden in your Shopify admin.',
        }),
      ),
      h(
        'details',
        {
          class: 'disclosure',
          open: model.handle || model.seoTitle || model.seoDescription ? true : undefined,
        },
        h('summary', {}, 'Search engine listing and web address'),
        h(
          'div',
          { class: 'stack' },
          field({
            label: 'Web address (handle)',
            control: handle,
            optional: true,
            hint: 'The end of the product’s address, like linen-shirt. Empty: Shopify makes one from the title.',
          }),
          field({
            label: 'Page title',
            control: seoTitle,
            optional: true,
            hint: 'Empty: the product title.',
          }),
          field({ label: 'Meta description', control: seoDescription, optional: true }),
        ),
      ),
    ),
  );

  // ---- options and variants ----
  // An option edit still being applied (it may ask first): saving waits for it.
  let pendingOptions = Promise.resolve(true);
  const optionsList = h('div', { class: 'stack option-list' });
  const variantsBox = h('div', { class: 'stack' });
  const addOption = button('Add option', {
    size: 'small',
    iconName: 'plus',
    onClick: () => {
      if (model.options.length >= MAX_OPTIONS) return;
      const name = ['Size', 'Color', 'Material'].find(
        (n) => !model.options.some((o) => o.name.toLowerCase() === n.toLowerCase()),
      );
      applyOptions([...model.options, { name: name ?? '', values: [] }], { force: true }).then(
        () => {
          renderOptions();
          optionsList.querySelector(`[data-option-values="${model.options.length - 1}"]`)?.focus();
        },
      );
    },
  });

  function renderOptions() {
    replace(
      optionsList,
      model.options.length === 0
        ? muted(
            'No options: the product has a single variant. Add one, like Size, to sell several.',
          )
        : model.options.map((o, i) => optionRow(o, i)),
    );
    addOption.disabled = model.options.length >= MAX_OPTIONS;
  }

  function optionRow(o, i) {
    const name = input({ value: o.name, maxlength: 255, dataset: { optionName: String(i) } });
    const values = input({
      value: o.values.join(', '),
      placeholder: 'e.g. S, M, L',
      dataset: { optionValues: String(i) },
    });
    const commit = () => {
      const next = model.options.map((x, j) =>
        j === i ? { name: name.value.trim(), values: splitList(values.value) } : x,
      );
      pendingOptions = applyOptions(next);
      pendingOptions.then((ok) => {
        if (!ok) {
          name.value = model.options[i]?.name ?? '';
          values.value = (model.options[i]?.values ?? []).join(', ');
        }
      });
    };
    name.addEventListener('change', commit);
    values.addEventListener('change', commit);
    return h(
      'div',
      { class: 'option-row' },
      field({ label: `Option ${i + 1}`, control: name }),
      field({
        label: `${o.name || `Option ${i + 1}`} values`,
        control: values,
        hint: 'Separate values with commas.',
      }),
      button('Remove', {
        size: 'small',
        variant: 'plain-critical',
        attrs: { 'aria-label': `Remove the option ${o.name || i + 1}` },
        onClick: () =>
          applyOptions(model.options.filter((_, j) => j !== i)).then((ok) => ok && renderOptions()),
      }),
    );
  }

  /**
   * New options: the variants follow (one per combination of values, minus the ones removed on
   * purpose). Renamed values keep their variants. Asks before dropping variants with a SKU.
   */
  async function applyOptions(nextOptions, { force = false } = {}) {
    const old = model.options;
    let rows = model.variants.map((v) => ({ ...v, optionValues: [...v.optionValues] }));
    if (nextOptions.length === old.length) {
      nextOptions.forEach((o, i) => {
        const before = old[i].values;
        if (before.length !== o.values.length) return;
        const renames = new Map(before.map((v, j) => [v, o.values[j]]).filter(([a, b]) => a !== b));
        for (const r of rows)
          if (renames.has(r.optionValues[i])) r.optionValues[i] = renames.get(r.optionValues[i]);
      });
    } else if (nextOptions.length > old.length) {
      for (const r of rows) {
        while (r.optionValues.length < nextOptions.length) {
          const added = nextOptions[r.optionValues.length];
          r.optionValues.push(added.values[0] ?? '');
        }
      }
    } else {
      const kept = nextOptions.map((o) => old.indexOf(old.find((x) => x.name === o.name)));
      for (const r of rows) {
        r.optionValues = kept.every((k) => k >= 0)
          ? kept.map((k) => r.optionValues[k])
          : r.optionValues.slice(0, nextOptions.length);
      }
    }
    const combos = nextOptions.some((o) => o.values.length === 0)
      ? []
      : cartesian(nextOptions.map((o) => o.values));
    if (combos.length > MAX_VARIANTS) {
      showError(
        `That makes ${num(combos.length)} variants. A product can have at most ${MAX_VARIANTS}.`,
      );
      return false;
    }
    const byKey = new Map();
    for (const r of rows)
      if (!byKey.has(comboKey(r.optionValues))) byKey.set(comboKey(r.optionValues), r);
    const removed = new Set(
      [...model.removedCombos].filter((k) => combos.some((c) => comboKey(c) === k)),
    );
    let next = combos
      .filter((c) => !removed.has(comboKey(c)))
      .map((c) => byKey.get(comboKey(c)) ?? newVariant(c));
    // Options still being typed (an option without values): keep the variants as they are.
    if (combos.length === 0 && nextOptions.length > 0) next = rows;
    const dropped = rows.filter((r) => !next.includes(r) && (r.sku.trim() || r.id));
    if (dropped.length && !force) {
      const ok = await confirmDialog({
        title: dropped.length === 1 ? 'Remove a variant?' : `Remove ${dropped.length} variants?`,
        message: h(
          'div',
          { class: 'stack' },
          h('p', {}, 'With these options, these variants go:'),
          h(
            'ul',
            { class: 'plain-list' },
            dropped.map((r) => h('li', {}, `${comboLabel(r.optionValues)} · ${r.sku || 'no SKU'}`)),
          ),
          h(
            'p',
            { class: 'muted' },
            'Their SKUs and stock stay in Store Sync. Publishing deletes them in the brands that have them.',
          ),
        ),
        confirmLabel: 'Remove variants',
        tone: 'critical',
      });
      if (!ok) return false;
    }
    // Images shown for a value follow its renames; a value that's gone shows for all variants.
    const values = new Set(nextOptions.flatMap((o) => o.values));
    nextOptions.forEach((o, i) => {
      const before = old[i]?.values ?? [];
      if (before.length !== o.values.length) return;
      before.forEach((v, j) => {
        if (v === o.values[j]) return;
        for (const m of model.media) if (m.optionValue === v) m.optionValue = o.values[j];
      });
    });
    for (const m of model.media)
      if (m.optionValue && !values.has(m.optionValue)) m.optionValue = null;
    model.options = nextOptions;
    model.variants = next.length ? next : [newVariant(nextOptions.map((o) => o.values[0] ?? ''))];
    model.removedCombos = removed;
    renderVariants();
    renderAllImages();
    refreshDirty();
    return true;
  }

  function renderVariants() {
    const hasOptions = model.options.length > 0;
    const columns = [
      {
        label: 'Variant',
        render: (v) => h('span', { class: 'strong' }, comboLabel(v.optionValues)),
      },
      {
        label: 'SKU',
        render: (v) =>
          cellInput(v, 'sku', `SKU for ${comboLabel(v.optionValues)}`, {
            maxlength: 255,
            autocomplete: 'off',
            spellcheck: 'false',
            class: 'input input-sku',
          }),
      },
      {
        label: 'Barcode',
        render: (v) =>
          cellInput(v, 'barcode', `Barcode for ${comboLabel(v.optionValues)}`, {
            maxlength: 255,
            autocomplete: 'off',
            inputmode: 'numeric',
            class: 'input input-barcode',
          }),
      },
      { label: 'Weight', render: (v) => weightCell(v) },
      {
        label: `Price (${baseCurrency})`,
        render: (v) =>
          cellInput(v, 'basePrice', `Base price of ${comboLabel(v.optionValues)}`, moneyAttrs),
      },
      {
        label: 'Compare-at',
        render: (v) =>
          cellInput(
            v,
            'baseCompareAtPrice',
            `Compare-at price of ${comboLabel(v.optionValues)}`,
            moneyAttrs,
          ),
      },
      {
        label: 'Cost',
        render: (v) => cellInput(v, 'cost', `Cost of ${comboLabel(v.optionValues)}`, moneyAttrs),
      },
      { label: 'Stock', align: 'end', render: (v) => stockCell(v) },
      {
        label: 'Actions',
        header: h('span', { class: 'sr-only' }, 'Actions'),
        className: 'col-actions',
        render: (v) =>
          hasOptions &&
          button('', {
            size: 'small',
            variant: 'plain-critical',
            iconName: 'trash',
            disabled: model.variants.length <= 1,
            attrs: {
              'aria-label': `Remove the variant ${comboLabel(v.optionValues)}…`,
              title: 'Remove this variant',
            },
            onClick: () => removeVariant(v),
          }),
      },
    ];
    const removed = [...model.removedCombos].map((k) => k.split('\u0001'));
    replace(
      variantsBox,
      h(
        'div',
        { class: 'table-wrap variant-grid' },
        h(
          'table',
          { class: 'table', role: 'table' },
          h('caption', { class: 'sr-only' }, 'Variants'),
          h(
            'thead',
            { role: 'rowgroup' },
            h(
              'tr',
              { role: 'row' },
              columns.map((c) =>
                h(
                  'th',
                  {
                    scope: 'col',
                    role: 'columnheader',
                    class: [c.align && `align-${c.align}`, c.className],
                  },
                  c.header ?? c.label,
                ),
              ),
            ),
          ),
          h(
            'tbody',
            { role: 'rowgroup' },
            model.variants.map((v) =>
              h(
                'tr',
                { role: 'row' },
                columns.map((c, i) =>
                  h(
                    i === 0 ? 'th' : 'td',
                    {
                      role: i === 0 ? 'rowheader' : 'cell',
                      scope: i === 0 ? 'row' : null,
                      'data-label': c.label,
                      class: [c.align && `align-${c.align}`, c.className],
                    },
                    c.render(v),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      removed.length > 0 &&
        h(
          'p',
          { class: 'removed-combos small' },
          h('span', { class: 'muted' }, 'Not offered: '),
          removed.map((values) =>
            h(
              'span',
              { class: 'removed-combo' },
              comboLabel(values),
              ' ',
              button('Add back', {
                size: 'small',
                variant: 'plain',
                attrs: { 'aria-label': `Add back ${comboLabel(values)}` },
                onClick: () => {
                  model.removedCombos.delete(comboKey(values));
                  applyOptions(model.options, { force: true });
                },
              }),
            ),
          ),
        ),
      h(
        'p',
        { class: 'field-hint' },
        `Prices are base prices in ${baseCurrency}: each brand converts them with its exchange rate and price rule. A new SKU starts at 0 in stock when the product is first published; then add stock with a purchase order or “Add units” on its product page.`,
      ),
    );
  }

  const moneyAttrs = {
    inputmode: 'decimal',
    autocomplete: 'off',
    placeholder: '0.00',
    class: 'input input-money',
  };

  function cellInput(v, key, label, attrs = {}) {
    const control = input({
      value: v[key],
      'aria-label': label,
      dataset: { row: String(v.key), field: key },
      ...attrs,
    });
    control.addEventListener('input', () => {
      v[key] = control.value;
      refreshDirty();
    });
    return control;
  }

  function weightCell(v) {
    const unit = select(WEIGHT_UNITS, {
      value: v.weightUnit,
      'aria-label': `Weight unit of ${comboLabel(v.optionValues)}`,
      class: 'input select input-unit',
    });
    unit.addEventListener('change', () => {
      v.weightUnit = unit.value;
      refreshDirty();
    });
    return h(
      'div',
      { class: 'weight-cell' },
      cellInput(v, 'weight', `Weight of ${comboLabel(v.optionValues)}`, {
        inputmode: 'decimal',
        autocomplete: 'off',
        class: 'input input-money',
      }),
      unit,
    );
  }

  function stockCell(v) {
    if (v.stockStarted) return h('span', { class: 'num' }, num(v.stock));
    // A SKU new to Store Sync starts at 0 when the product is first published.
    if (!v.id || v.stockStartsAtZero) {
      return h(
        'span',
        { class: 'muted', title: 'Starts at 0 when the product is first published' },
        '0',
        h('span', { class: 'sr-only' }, ' (starts when published)'),
      );
    }
    return muted('Not started', 'Start it on the “Start syncing” page');
  }

  async function removeVariant(v) {
    if (model.variants.length <= 1) return;
    if (v.sku.trim() || v.id) {
      const ok = await confirmDialog({
        title: `Remove ${comboLabel(v.optionValues)}?`,
        message: h(
          'div',
          { class: 'stack' },
          h('p', {}, 'Publishing deletes this variant in the brands that have it.'),
          h(
            'p',
            { class: 'muted' },
            'Its SKU and stock stay in Store Sync. You can add it back below the variants.',
          ),
        ),
        confirmLabel: 'Remove variant',
        tone: 'critical',
      });
      if (!ok) return;
    }
    if (model.options.length) model.removedCombos.add(comboKey(v.optionValues));
    model.variants = model.variants.filter((x) => x !== v);
    renderVariants();
    refreshDirty();
  }

  const variantsCard = card(
    {
      title: 'Options and variants',
      description:
        'Shared by every brand: each combination of values is a variant with its own SKU.',
      actions: addOption,
    },
    h('div', { class: 'stack-lg' }, optionsList, variantsBox),
  );
  renderOptions();
  renderVariants();

  // ---- images ----
  const imageLists = [];
  function renderAllImages() {
    for (const render of imageLists) render();
  }

  function imagesEditor(storeId, label) {
    const list = h('ul', { class: 'image-list' });
    const progress = h('p', { class: 'small muted', role: 'status' });
    const fileInput = h('input', {
      type: 'file',
      accept: IMAGE_TYPES.join(','),
      multiple: true,
      hidden: true,
      'aria-label': `Choose images for ${label}`,
    });
    const addButton = button('Add images', {
      size: 'small',
      iconName: 'upload',
      onClick: () => fileInput.click(),
    });
    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      await withBusy(addButton, () => uploadImages(files, storeId, progress));
      // The shared list's "main image" note depends on the brands' own images.
      renderAllImages();
    });
    const render = () => {
      const items = model.media.filter((m) => m.storeId === storeId);
      replace(
        list,
        items.length === 0
          ? h(
              'li',
              { class: 'image-empty muted' },
              storeId === null ? 'No shared images yet.' : 'No images for this brand only.',
            )
          : items.map((m, i) => imageRow(m, i, items, render)),
      );
    };
    imageLists.push(render);
    render();
    return h(
      'div',
      { class: 'stack' },
      list,
      h('div', { class: 'row-actions' }, addButton, fileInput),
      progress,
    );
  }

  async function uploadImages(files, storeId, progress) {
    let done = 0;
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        toast(`${file.name} isn’t a JPEG, PNG, WebP or GIF image.`, { tone: 'error' });
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast(`${file.name} is bigger than 20 MB, the most Shopify accepts.`, { tone: 'error' });
        continue;
      }
      progress.textContent = `Uploading ${file.name}…`;
      try {
        const image = await apiUpload(`/api/catalog/media${qs({ filename: file.name })}`, file);
        model.media.push({
          key: ++rowKeys,
          fileId: image.id,
          url: image.url,
          alt: '',
          optionValue: null,
          storeId,
        });
        done++;
      } catch {
        // apiUpload showed the reason.
      }
    }
    progress.textContent = done
      ? `${plural(done, 'image')} added. Save to keep ${done === 1 ? 'it' : 'them'}.`
      : '';
    refreshDirty();
  }

  /** The first image of a brand is its main image: the brand's own first, else the shared one. */
  function mainImageLabel(m, n) {
    if (n !== 1) return `Image ${n}`;
    if (m.storeId !== null) return 'Image 1 · main image of this brand';
    return model.media.some((x) => x.storeId !== null)
      ? 'Image 1 · main image where a brand has none of its own'
      : 'Image 1 · main image';
  }

  function imageRow(m, i, items, render) {
    const n = i + 1;
    const alt = input({ value: m.alt, maxlength: 512, placeholder: 'What the image shows' });
    alt.addEventListener('input', () => {
      m.alt = alt.value;
      refreshDirty();
    });
    const values = model.options.flatMap((o) =>
      o.values.map((v) => ({ value: v, label: `${o.name}: ${v}` })),
    );
    const forValue = select([{ value: '', label: 'Every variant' }, ...values], {
      value: m.optionValue ?? '',
    });
    forValue.addEventListener('change', () => {
      m.optionValue = forValue.value || null;
      refreshDirty();
    });
    const move = (delta) => {
      const all = model.media;
      const other = items[i + delta];
      const a = all.indexOf(m);
      const b = all.indexOf(other);
      [all[a], all[b]] = [all[b], all[a]];
      render();
      refreshDirty();
      // Keep the keyboard on the image that moved.
      const moved = document.querySelector(`[data-image="${m.key}"]`);
      (
        moved?.querySelector(`[data-move="${delta < 0 ? 'up' : 'down'}"]:not(:disabled)`) ??
        moved?.querySelector('[data-move]:not(:disabled)')
      )?.focus();
    };
    return h(
      'li',
      { class: 'image-row', dataset: { image: String(m.key) } },
      h(
        'div',
        { class: 'image-head' },
        thumb(m.url, { size: 'lg' }),
        h('p', { class: 'small muted' }, mainImageLabel(m, n)),
        h(
          'div',
          { class: 'image-actions' },
          button('', {
            size: 'small',
            iconName: 'chevronLeft',
            disabled: i === 0,
            attrs: {
              'aria-label': `Move image ${n} up`,
              class: 'button button-secondary button-small move-up',
              'data-move': 'up',
            },
            onClick: () => move(-1),
          }),
          button('', {
            size: 'small',
            iconName: 'chevronRight',
            disabled: i === items.length - 1,
            attrs: {
              'aria-label': `Move image ${n} down`,
              class: 'button button-secondary button-small move-down',
              'data-move': 'down',
            },
            onClick: () => move(1),
          }),
          button('Remove', {
            size: 'small',
            variant: 'plain-critical',
            attrs: { 'aria-label': `Remove image ${n}` },
            onClick: () => {
              model.media = model.media.filter((x) => x !== m);
              renderAllImages();
              refreshDirty();
            },
          }),
        ),
      ),
      h(
        'div',
        { class: 'image-fields' },
        field({ label: 'Alt text', control: alt, hint: 'Read aloud by screen readers.' }),
        values.length > 0 && field({ label: 'Show for', control: forValue }),
      ),
    );
  }
  const imagesCard = card(
    {
      title: 'Shared images',
      description:
        'Shown in every brand, after the brand’s own images. The first image of a brand is its main image.',
    },
    imagesEditor(null, 'every brand'),
  );

  // ---- brands ----
  const placeholderSlots = [];
  function refreshPlaceholders() {
    for (const update of placeholderSlots) update();
  }

  function brandPanel(s) {
    const panel = h('section', { class: 'brand-panel', 'aria-labelledby': `brand-${s.storeId}` });
    const render = () => {
      const stateSlot = h(
        'span',
        { class: 'brand-state' },
        s.view ? stateBadge(s.view) : stateBadge({ state: 'never' }),
      );
      if (!s.enabled) replace(stateSlot, stateBadge({ enabled: false }));
      stateSlots.set(s.storeId, stateSlot);
      const enabled = input({ type: 'checkbox', checked: s.enabled, class: 'checkbox-input' });
      enabled.addEventListener('change', () => {
        s.enabled = enabled.checked;
        render();
        refreshDirty();
        panel.querySelector('input[type=checkbox]')?.focus();
      });
      const currency = s.store.currencyCode;
      replace(
        panel,
        h(
          'div',
          { class: 'brand-head' },
          h('h3', { id: `brand-${s.storeId}`, class: 'brand-title' }, s.storeName),
          currency && h('span', { class: 'muted small' }, currency),
          stateSlot,
          s.view?.adminUrl &&
            h(
              'a',
              {
                href: s.view.adminUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                class: 'small brand-link',
              },
              'View in Shopify',
              icon('external', { size: 14 }),
            ),
        ),
        h(
          'label',
          { class: 'checkbox' },
          enabled,
          h(
            'span',
            {},
            `Sell in ${s.storeName}`,
            h(
              'span',
              { class: 'field-hint block' },
              s.view?.shopifyProductId
                ? 'Turning it off stops updating the product there; it stays in the store as it is.'
                : 'Publishing creates the product there.',
            ),
          ),
        ),
        s.enabled && brandDetails(s),
      );
    };
    render();
    return panel;
  }

  function brandDetails(s) {
    const view = s.view;
    const nodes = [];
    const problems = view?.problems ?? storeProblems(s.store);
    if (problems.length) {
      nodes.push(
        banner(
          { tone: 'warning', title: `Can’t publish to ${s.storeName} yet` },
          h(
            'ul',
            { class: 'plain-list' },
            problems.map((p) => h('li', {}, p)),
          ),
        ),
      );
    }
    if (view?.state === 'failed' && view.lastError) {
      nodes.push(
        banner({ tone: 'critical', title: 'The last publish failed' }, h('p', {}, view.lastError)),
      );
    } else if (view?.lastError && (view.state === 'queued' || view.state === 'publishing')) {
      nodes.push(
        banner(
          { tone: 'info', title: 'Publishing is waiting to retry' },
          h('p', {}, view.lastError),
        ),
      );
    }
    if (view?.warnings?.length) {
      nodes.push(
        banner(
          { tone: 'warning', title: 'Notes from the last publish' },
          h(
            'ul',
            { class: 'plain-list' },
            view.warnings.map((w) => h('li', {}, w)),
          ),
        ),
      );
    }
    if (view?.publishedAt) {
      nodes.push(h('p', { class: 'small muted' }, 'Last published ', timeAgo(view.publishedAt)));
    }

    const o = s.overlay;
    const overlayInput = (key, attrs = {}) => {
      const control = input({
        value: o[key],
        maxlength: 255,
        name: `${key}-${s.storeId}`,
        ...attrs,
      });
      control.addEventListener('input', () => {
        o[key] = control.value;
        refreshDirty();
      });
      return control;
    };
    const title = overlayInput('title');
    const vendor = overlayInput('vendor');
    const productType = overlayInput('productType');
    const handle = overlayInput('handle', { autocomplete: 'off', spellcheck: 'false' });
    const seoTitle = overlayInput('seoTitle');
    const extraTags = overlayInput('extraTags', {
      maxlength: undefined,
      placeholder: 'e.g. harbor, new',
    });
    const descriptionArea = h('textarea', {
      class: 'input textarea',
      rows: 4,
      value: o.descriptionHtml,
      name: `descriptionHtml-${s.storeId}`,
    });
    descriptionArea.addEventListener('input', () => {
      o.descriptionHtml = descriptionArea.value;
      refreshDirty();
    });
    const seoDescription = h('textarea', {
      class: 'input textarea',
      rows: 2,
      value: o.seoDescription,
      maxlength: 1000,
      name: `seoDescription-${s.storeId}`,
    });
    seoDescription.addEventListener('input', () => {
      o.seoDescription = seoDescription.value;
      refreshDirty();
    });
    const statusSelect = select(
      [
        { value: '', label: 'Same as default' },
        ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
      ],
      { value: o.status },
    );
    statusSelect.addEventListener('change', () => {
      o.status = statusSelect.value;
      refreshDirty();
    });
    const onlineStore = input({
      type: 'checkbox',
      checked: s.publishToOnlineStore,
      class: 'checkbox-input',
    });
    onlineStore.addEventListener('change', () => {
      s.publishToOnlineStore = onlineStore.checked;
      refreshDirty();
    });

    // "Same as default: …" follows the default as it's typed.
    const placeholders = () => {
      const short = (text) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);
      title.placeholder = model.title
        ? `Same as default: ${short(model.title)}`
        : 'Same as default';
      vendor.placeholder = model.vendor
        ? `Same as default: ${short(model.vendor)}`
        : 'Same as default';
      productType.placeholder = model.productType
        ? `Same as default: ${short(model.productType)}`
        : 'Same as default';
      handle.placeholder = model.handle ? `Same as default: ${model.handle}` : 'Same as default';
      seoTitle.placeholder = model.seoTitle
        ? `Same as default: ${short(model.seoTitle)}`
        : 'Same as default';
      descriptionArea.placeholder = 'Same as default';
      seoDescription.placeholder = 'Same as default';
      statusSelect.options[0].textContent = `Same as default (${STATUS_LABELS[model.status]})`;
    };
    placeholders();
    placeholderSlots.push(placeholders);
    const customised = Object.values(o).some((v) => v !== '');

    nodes.push(
      h(
        'details',
        { class: 'disclosure', open: customised ? true : undefined },
        h('summary', {}, `Customise for ${s.storeName}`),
        h(
          'div',
          { class: 'stack' },
          h('p', { class: 'field-hint' }, 'Leave a field empty to use the default.'),
          field({ label: 'Title', control: title }),
          field({
            label: 'Description',
            control: descriptionArea,
            hint: 'Simple HTML, like the default description.',
          }),
          h(
            'div',
            { class: 'grid-2' },
            field({ label: 'Vendor', control: vendor }),
            field({ label: 'Product type', control: productType }),
          ),
          h(
            'div',
            { class: 'grid-2' },
            field({ label: 'Extra tags', control: extraTags, hint: 'Added to the default tags.' }),
            field({ label: 'Status', control: statusSelect }),
          ),
          field({ label: 'Web address (handle)', control: handle }),
          field({ label: 'Page title', control: seoTitle }),
          field({ label: 'Meta description', control: seoDescription }),
        ),
      ),
      h(
        'label',
        { class: 'checkbox' },
        onlineStore,
        h(
          'span',
          {},
          `Show in ${s.storeName}’s Online Store`,
          h(
            'span',
            { class: 'field-hint block' },
            view?.onlineStoreAsFound
              ? 'Imported: publishing leaves the product shown or hidden in the Online Store as it is in Shopify, until you change this setting.'
              : 'Active products are made visible in the Online Store sales channel when published.',
          ),
        ),
      ),
      h(
        'div',
        { class: 'stack' },
        h('h4', { class: 'brand-subtitle' }, `Images for ${s.storeName} only`),
        imagesEditor(s.storeId, s.storeName),
      ),
    );
    if (view) nodes.push(pricesTable(s, view));
    return h('div', { class: 'stack brand-details' }, nodes);
  }

  function pricesTable(s, view) {
    const currency = view.currencyCode ?? baseCurrency;
    const rows = view.prices.map((p) => {
      const t = p.target;
      let price;
      if (t.status === 'ok') {
        price = h(
          'span',
          {},
          money(t.price, currency),
          typeof t.compareAtPrice === 'number' &&
            h('span', { class: 'muted block small' }, `was ${money(t.compareAtPrice, currency)}`),
          t.source === 'override' && ' ',
          t.source === 'override' && badge('Fixed price', 'info'),
        );
      } else if (t.reason === 'no_base_price') {
        price = h('span', { class: 'text-warning' }, 'Set a base price');
      } else if (p.current) {
        price = muted('Left as it is (price rule off)');
      } else {
        price = p.fallback
          ? h('span', {}, money(p.fallback.price, currency), muted(' when created'))
          : h('span', { class: 'text-warning' }, 'Set a base price');
      }
      return h(
        'tr',
        { role: 'row' },
        h('th', { role: 'rowheader', scope: 'row', class: 'mono', 'data-label': 'SKU' }, p.sku),
        h('td', { role: 'cell', 'data-label': 'Publishing sends' }, price),
        h(
          'td',
          { role: 'cell', 'data-label': `Now in ${s.storeName}`, class: 'align-end' },
          p.current ? money(p.current.price, currency) : muted('—'),
        ),
      );
    });
    return h(
      'div',
      { class: 'stack' },
      h('h4', { class: 'brand-subtitle' }, `Prices in ${s.storeName}`),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'table table-compact', role: 'table' },
          h('caption', { class: 'sr-only' }, `Prices in ${s.storeName}`),
          h(
            'thead',
            { role: 'rowgroup' },
            h(
              'tr',
              { role: 'row' },
              h('th', { scope: 'col', role: 'columnheader' }, 'SKU'),
              h('th', { scope: 'col', role: 'columnheader' }, 'Publishing sends'),
              h(
                'th',
                { scope: 'col', role: 'columnheader', class: 'align-end' },
                `Now in ${s.storeName}`,
              ),
            ),
          ),
          h('tbody', { role: 'rowgroup' }, rows),
        ),
      ),
      h(
        'p',
        { class: 'field-hint' },
        'From the base prices and this brand’s price rule (see Prices), as last saved. Publishing sends them.',
      ),
    );
  }

  const brandsCard = card(
    {
      title: 'Brands',
      description: 'Where the product is sold, and what each brand shows differently.',
    },
    h(
      'div',
      { class: 'brand-list' },
      model.stores.length
        ? model.stores.map(brandPanel)
        : muted('Connect a store to publish products to it.'),
    ),
  );

  // ---- save ----
  const saveButton = button(isNew ? 'Create product' : 'Save changes', {
    type: 'submit',
    variant: 'primary',
  });
  const dirtyNote = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const actions = h('div', { class: 'form-actions save-bar' }, saveButton, dirtyNote);
  function refreshDirty() {
    const dirty = isDirty();
    saveButton.disabled = !dirty;
    actions.classList.toggle('is-dirty', dirty);
    dirtyNote.textContent = dirty && !isNew ? 'You have unsaved changes.' : '';
  }

  const form = h(
    'form',
    { class: 'stack-lg', novalidate: true },
    formError,
    importNotes(model.id),
    basics,
    variantsCard,
    imagesCard,
    brandsCard,
    actions,
  );
  form.addEventListener('input', refreshDirty);
  form.addEventListener('change', refreshDirty);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    withBusy(saveButton, save).catch(() => {});
  });
  refreshDirty();

  async function save() {
    formError.hidden = true;
    if (!(await pendingOptions)) return;
    const problem = validate(model, form);
    if (problem) {
      showError(problem.message, problem.focus);
      return;
    }
    try {
      const body = requestBody(model);
      if (isNew) {
        const created = await api('/api/catalog/products', {
          method: 'POST',
          body,
          toastErrors: false,
        });
        saved = snapshot(model);
        toast('Product created. Publish it to your brands when you’re ready.');
        location.hash = `#/catalog/${created.id}`;
        return;
      }
      await api(`/api/catalog/products/${model.id}`, { method: 'PATCH', body, toastErrors: false });
      saved = snapshot(model);
      toast('Changes saved. Publish to update your brands.');
      reload();
    } catch (err) {
      showError(err.message);
    }
  }

  // ---- publish ----
  async function openPublish(btn) {
    const preview = await withBusy(btn, () =>
      api(`/api/catalog/products/${model.id}/preview`, { signal }),
    );
    if (!preview) return;
    const choices = new Map();
    const blocks = preview.stores.map((p) => {
      const box = input({
        type: 'checkbox',
        class: 'checkbox-input',
        checked: (p.action === 'create' || p.action === 'update') && !p.upToDate,
        disabled: p.action === 'skip' || p.action === 'blocked',
      });
      choices.set(p.storeId, box);
      return previewBlock(p, box, model.variants.length);
    });
    const names = new Map(preview.stores.map((p) => [p.storeId, p.storeName]));
    const result = await formDialog({
      title: 'Publish to your brands?',
      intro: h(
        'p',
        {},
        'Each brand’s product is replaced with what you see here. Check what changes in each.',
      ),
      content: h('div', { class: 'publish-preview' }, blocks),
      submitLabel: 'Publish',
      onSubmit: async () => {
        const storeIds = [...choices]
          .filter(([, box]) => box.checked && !box.disabled)
          .map(([id]) => id);
        if (storeIds.length === 0) throw new Error('Choose at least one brand to publish to.');
        return api(`/api/catalog/products/${model.id}/publish`, {
          method: 'POST',
          body: { storeIds },
          toastErrors: false,
        });
      },
    });
    if (!result) return;
    const queued = result.queued.map((id) => names.get(id));
    toast(`Publishing to ${listNames(queued)}. This page updates when it’s done.`, {
      tone: 'info',
    });
    for (const id of result.queued) {
      const slot = stateSlots.get(id);
      if (slot) replace(slot, stateBadge({ state: 'queued' }));
    }
    watchPublishing(result.queued);
  }

  let watching = false;
  async function watchPublishing(storeIds) {
    if (watching) return;
    watching = true;
    try {
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (signal.aborted) return;
        let fresh;
        try {
          fresh = await api(`/api/catalog/products/${model.id}`, { signal });
        } catch {
          continue;
        }
        for (const s of fresh.stores) {
          const slot = stateSlots.get(s.storeId);
          if (slot) replace(slot, stateBadge(s));
        }
        if (fresh.stores.some(isBusy)) continue;
        const mine = fresh.stores.filter((s) => storeIds.includes(s.storeId));
        const failed = mine.filter((s) => s.state === 'failed').map((s) => s.storeName);
        const done = mine.filter((s) => s.state !== 'failed').map((s) => s.storeName);
        if (failed.length) {
          toast(`Couldn’t publish to ${listNames(failed)}. The reason is shown under the brand.`, {
            tone: 'error',
          });
        } else if (done.length) {
          toast(`Published to ${listNames(done)}.`);
        }
        // Show errors, warnings and links, unless the merchant is in the middle of an edit.
        if (!isDirty()) reload();
        return;
      }
    } finally {
      watching = false;
    }
  }
  if (!isNew && product.stores.some(isBusy)) {
    watchPublishing(product.stores.filter(isBusy).map((s) => s.storeId));
  }

  // ---- remove ----
  const dangerCard =
    !isNew &&
    card(
      { title: 'Remove from the catalog', className: 'card-danger' },
      h(
        'div',
        { class: 'stack' },
        h(
          'p',
          {},
          'Your stores keep the product as it is now, with its stock. Store Sync stops managing its texts, images and prices.',
        ),
        h(
          'div',
          {},
          button('Remove from catalog…', {
            variant: 'critical',
            iconName: 'trash',
            onClick: async () => {
              const removed = await confirmDialog({
                title: `Remove “${product.title}” from the catalog?`,
                message: h(
                  'div',
                  { class: 'stack' },
                  h(
                    'p',
                    {},
                    'Nothing changes in your stores: the product stays there, and its stock keeps syncing.',
                  ),
                  h('p', { class: 'muted' }, 'To bring it back, import it from a store.'),
                ),
                confirmLabel: 'Remove from catalog',
                tone: 'critical',
                onConfirm: () =>
                  api(`/api/catalog/products/${model.id}`, {
                    method: 'DELETE',
                    toastErrors: false,
                  }),
              });
              if (removed) {
                toast('Removed from the catalog. Your stores still have the product.');
                location.hash = '#/catalog';
              }
            },
          }),
        ),
      ),
    );

  return {
    title: isNew ? 'New product' : product.title,
    header,
    nodes: [form, dangerCard],
  };
}

/** Before the product is saved: what the server would say stops a publish to this store. */
function storeProblems(store) {
  const out = [];
  if (store.status === 'paused') out.push(`${store.name} is paused. Resume it on its page first.`);
  if (store.status === 'error') {
    out.push(`${store.name} needs attention: we can’t reach it. Check it on its page first.`);
  }
  if (store.status === 'disconnected') {
    out.push(`${store.name} is disconnected. Reconnect it on its page first.`);
  }
  const catalog = store.features?.catalog;
  if (catalog && !catalog.available) {
    out.push(
      `${store.name} hasn’t given Store Sync permission to create and update its products (${catalog.missingScopes.join(', ')}).`,
    );
  }
  return out;
}

function importNotes(productId) {
  const warnings = productId ? takeImportWarnings(productId) : [];
  if (warnings.length === 0) return null;
  return banner(
    { tone: 'warning', title: 'Imported, with notes' },
    h(
      'ul',
      { class: 'plain-list' },
      warnings.map((w) => h('li', {}, w)),
    ),
  );
}

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** One brand in the publish dialog: what publishing does there. */
function previewBlock(p, box, variantCount) {
  const lines = [];
  const currency = p.currencyCode;
  const add = (text, tone) => lines.push(h('li', { class: tone ? `tone-${tone}` : null }, text));
  if (p.action === 'skip' || p.action === 'blocked') {
    for (const r of p.reasons) add(r, p.action === 'blocked' ? 'critical' : null);
  } else if (p.action === 'create') {
    add(
      `Creates the product with ${plural(variantCount, 'variant')}${p.imagesAdded ? ` and ${plural(p.imagesAdded, 'image')}` : ''}.`,
    );
  } else if (p.upToDate) {
    add('Already up to date.');
  }
  for (const n of p.notes) add(n);
  if (p.action === 'create' || p.action === 'update') {
    for (const f of p.fields) {
      if (f.field === 'descriptionHtml') add('Description changes.');
      else add(`${f.label}: ${f.from ?? '—'} → ${f.to ?? '—'}`);
    }
    if (p.action === 'update' && p.variantsAdded.length) add(`Adds ${p.variantsAdded.join(', ')}.`);
    if (p.variantsUpdated.length)
      add(`Updates barcode, weight or shipping of ${p.variantsUpdated.join(', ')}.`);
    if (p.variantsRemoved.length) {
      const one = p.variantsRemoved.length === 1;
      add(
        `Deletes ${plural(p.variantsRemoved.length, 'variant')} in ${p.storeName}, with ${one ? 'its' : 'their'} stock there: ${p.variantsRemoved
          .map((v) => `${v.sku ?? 'no SKU'} (${v.title})`)
          .join(', ')}.`,
        'critical',
      );
    }
    if (p.imagesAdded && p.action === 'update') add(`Uploads ${plural(p.imagesAdded, 'image')}.`);
    if (p.imagesRemoved?.length) {
      const named = p.imagesRemoved.some((i) => i.alt);
      add(
        `Deletes ${plural(p.imagesRemoved.length, 'image')} in ${p.storeName}${named ? `: ${p.imagesRemoved.map((i) => i.alt || 'no description').join(', ')}` : ''}.`,
        'warning',
      );
    }
    if (p.prices.length) {
      const shown = p.prices.slice(0, 5);
      lines.push(
        h(
          'li',
          {},
          p.action === 'create' ? 'Prices:' : 'Prices change:',
          h(
            'ul',
            { class: 'preview-prices' },
            shown.map((c) =>
              h(
                'li',
                {},
                h('span', { class: 'mono' }, c.sku),
                ` ${c.from ? `${money(c.from.price, currency)} → ` : ''}${money(c.to.price, currency)}`,
              ),
            ),
            p.prices.length > shown.length &&
              h('li', {}, `and ${p.prices.length - shown.length} more`),
          ),
        ),
      );
    }
  }
  for (const w of p.warnings) add(w, 'warning');
  return h(
    'div',
    { class: ['preview-store', `preview-${p.action}`] },
    h(
      'label',
      { class: 'checkbox' },
      box,
      h('span', { class: 'strong' }, `Publish to ${p.storeName}`),
    ),
    h('ul', { class: 'preview-lines' }, lines),
  );
}
