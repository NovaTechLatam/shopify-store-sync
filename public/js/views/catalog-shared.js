import { api, isAbort, qs } from '../api.js';
import { formDialog } from '../dialog.js';
import { debounce, h, icon, replace, uid } from '../dom.js';
import { num, plural } from '../format.js';
import { toast } from '../toast.js';
import { badge, field, input, muted, select } from '../ui.js';

/** Pieces shared by the catalog list, the product editor and the product page's section. */

/** A brand's publish state as a badge (never by colour alone: there is always a word). */
export function stateBadge({ enabled = true, state, changedReason }) {
  if (!enabled) return badge('Not sold here', 'neutral');
  switch (state) {
    case 'queued':
      return badge('Waiting to publish', 'info', 'clock');
    case 'publishing':
      return badge('Publishing…', 'info', 'refresh');
    case 'published':
      return badge('Published', 'success', 'check');
    case 'failed':
      return badge('Failed', 'critical', 'error');
    case 'changed':
      return changedReason === 'prices'
        ? badge('Prices to update', 'warning', 'alert')
        : badge('Changes not published', 'warning', 'alert');
    default:
      return badge('Not published', 'neutral');
  }
}

export const isBusy = (s) => s.enabled && (s.state === 'queued' || s.state === 'publishing');

export const STATUS_LABELS = { ACTIVE: 'Active', DRAFT: 'Draft', ARCHIVED: 'Archived' };

export function statusBadge(status) {
  const tone = status === 'ACTIVE' ? 'success' : 'neutral';
  return badge(STATUS_LABELS[status] ?? status, tone);
}

/** A product image thumbnail, or an empty box with an icon. */
export function thumb(url, { alt = '', size } = {}) {
  const sizeClass = size ? `thumb-${size}` : null;
  if (!url) {
    return h(
      'span',
      { class: ['thumb', 'thumb-empty', sizeClass], 'aria-hidden': 'true' },
      icon('image', { size: size === 'lg' ? 28 : 18 }),
    );
  }
  const px = size === 'sm' ? 32 : size === 'lg' ? 96 : 48;
  return h('img', {
    class: ['thumb', sizeClass],
    src: url,
    alt,
    width: px,
    height: px,
    loading: 'lazy',
  });
}

// ---- description preview ------------------------------------------------------------------------

/** Tags the preview shows; anything else is unwrapped (its text kept). */
const ALLOWED = {
  P: 'p',
  BR: 'br',
  STRONG: 'strong',
  B: 'strong',
  EM: 'em',
  I: 'em',
  U: 'u',
  UL: 'ul',
  OL: 'ol',
  LI: 'li',
  A: 'a',
  H1: 'h2',
  H2: 'h2',
  H3: 'h3',
  H4: 'h4',
  H5: 'h4',
  H6: 'h4',
  BLOCKQUOTE: 'blockquote',
};
/** Tags whose content isn't text to show. */
const DROPPED = new Set([
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'NOSCRIPT',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'MATH',
  'TITLE',
  'HEAD',
  'SELECT',
  'TEXTAREA',
]);

/**
 * The description as safe DOM: the HTML is parsed into an inert document (nothing in it runs or
 * loads), then rebuilt with an allow-list of tags and no attributes but a web link's address.
 * It never goes through innerHTML.
 */
export function renderSimpleHtml(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  const out = document.createDocumentFragment();
  const walk = (node, parent) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        parent.append(child.textContent);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE || DROPPED.has(child.tagName)) continue;
      const tag = ALLOWED[child.tagName];
      if (!tag) {
        walk(child, parent);
        continue;
      }
      const el = document.createElement(tag);
      if (tag === 'a') {
        const href = (child.getAttribute('href') ?? '').trim();
        if (/^https?:\/\/[^\s]+$/i.test(href)) {
          el.setAttribute('href', href);
          el.setAttribute('rel', 'noopener noreferrer nofollow');
          el.setAttribute('target', '_blank');
        }
      }
      walk(child, el);
      parent.append(el);
    }
  };
  walk(doc.body, out);
  return out;
}

// ---- import ---------------------------------------------------------------------------------------

/** Warnings of the last import, shown once on the imported product's page. */
let lastImport = null;

export function takeImportWarnings(productId) {
  if (lastImport?.id !== productId) return [];
  const { warnings } = lastImport;
  lastImport = null;
  return warnings;
}

/**
 * "Import a product": choose a store, search its products (from Store Sync's copy of its
 * catalog), pick one. Opens the imported product on success.
 */
export async function importDialog({ stores, storeId, search = '' }) {
  const usable = stores.filter((s) => s.status !== 'disconnected');
  if (usable.length === 0) {
    toast('Connect a store first: products are imported from your stores.', { tone: 'error' });
    return;
  }
  const storeSelect = select(
    usable.map((s) => ({ value: s.id, label: s.name })),
    { value: String(storeId ?? usable[0].id) },
  );
  const searchInput = input({
    type: 'search',
    value: search,
    placeholder: 'Product name or SKU',
    autocomplete: 'off',
  });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const results = h('div', { class: 'picker-results' });
  const radioName = uid('product');
  let controller = null;

  const load = async () => {
    controller?.abort();
    controller = new AbortController();
    results.setAttribute('aria-busy', 'true');
    try {
      const data = await api(
        `/api/catalog/import/search${qs({ storeId: storeSelect.value, search: searchInput.value.trim() })}`,
        { signal: controller.signal },
      );
      const total = data.total ?? data.products.length;
      const cut = total > data.products.length;
      announcer.textContent = cut
        ? `${plural(total, 'product')} found, ${num(data.products.length)} listed`
        : `${plural(total, 'product')} found`;
      replace(
        results,
        data.products.length === 0
          ? muted(
              searchInput.value.trim()
                ? 'No products found. Try another name or SKU.'
                : 'We haven’t read any products from this store yet.',
            )
          : h(
              'fieldset',
              { class: 'picker' },
              h('legend', { class: 'sr-only' }, 'Products'),
              data.products.map((p) => importOption(p, radioName)),
            ),
        cut &&
          h(
            'p',
            { class: 'muted small picker-more' },
            `Showing ${num(data.products.length)} of ${num(total)}, by name. Search to find the others.`,
          ),
      );
    } catch (err) {
      if (!isAbort(err)) replace(results, h('p', { class: 'field-error' }, err.message));
    } finally {
      results.removeAttribute('aria-busy');
    }
  };
  searchInput.addEventListener('input', debounce(load, 250));
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      load();
    }
  });
  storeSelect.addEventListener('change', load);
  load();

  const result = await formDialog({
    title: 'Import a product',
    intro: h(
      'p',
      {},
      'Choose a product a store already sells. Its texts, options, prices and images become a catalog product, linked to the same product in your other brands (found by SKU). Nothing changes in your stores.',
    ),
    content: [
      field({ label: 'Store', control: storeSelect }),
      field({ label: 'Search its products', control: searchInput }),
      announcer,
      results,
    ],
    submitLabel: 'Import',
    initialFocus: () => searchInput,
    onSubmit: async (form) => {
      const chosen = form.querySelector(`input[name="${radioName}"]:checked`);
      if (!chosen) throw new Error('Choose a product from the list first.');
      const imported = await api('/api/catalog/import', {
        method: 'POST',
        body: { storeId: Number(storeSelect.value), productId: chosen.value },
        toastErrors: false,
      });
      return { ...imported, title: chosen.dataset.title };
    },
  });
  controller?.abort();
  if (!result) return;
  lastImport = { id: result.id, warnings: result.warnings };
  toast(
    result.warnings.length
      ? `“${result.title}” is in the catalog. Check the notes at the top of its page.`
      : `“${result.title}” is in the catalog, linked in every brand that sells it.`,
  );
  location.hash = `#/catalog/${result.id}`;
}

function importOption(p, radioName) {
  const id = uid('option');
  const skus = p.skus.slice(0, 4).join(', ') + (p.skus.length > 4 ? ', …' : '');
  return h(
    'label',
    { class: ['picker-option', p.inCatalog && 'is-disabled'], for: id },
    h('input', {
      type: 'radio',
      name: radioName,
      id,
      value: p.productId,
      disabled: Boolean(p.inCatalog),
      dataset: { title: p.title },
    }),
    h(
      'span',
      { class: 'picker-option-body' },
      h('span', { class: 'strong' }, p.title),
      h('span', { class: 'muted small' }, plural(p.variants, 'variant'), skus ? ` · ${skus}` : ''),
      p.inCatalog &&
        h(
          'span',
          { class: 'small text-warning' },
          `Already in the catalog as “${p.inCatalog.title}”`,
        ),
    ),
  );
}
