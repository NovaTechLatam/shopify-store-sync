import { ApiError, api } from './api.js';
import { confirmDialog, formDialog } from './dialog.js';
import { h } from './dom.js';
import { days, pace, plural } from './format.js';
import { badge, field, input } from './ui.js';

/** Pieces shared by the purchasing pages (views/purchasing.js, views/purchase-order.js) and the
 * product page section (item-sections/purchasing.js). */

export const ORDER_STATUS = {
  draft: { label: 'Draft', tone: 'neutral', icon: 'edit' },
  ordered: { label: 'Ordered', tone: 'info', icon: 'truck' },
  partial: { label: 'Partly received', tone: 'warning', icon: 'clock' },
  received: { label: 'Received', tone: 'success', icon: 'check' },
  closed: { label: 'Closed', tone: 'neutral', icon: 'check' },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: 'close' },
};

export function orderStatusBadge(status) {
  const s = ORDER_STATUS[status] ?? { label: status, tone: 'neutral', icon: 'info' };
  return badge(s.label, s.tone, s.icon);
}

export const overdueBadge = () => badge('Overdue', 'critical', 'alert');

/**
 * A random id for a request that must not be booked twice (a delivery). crypto.randomUUID needs
 * a secure context (https or localhost); getRandomValues works everywhere.
 */
export function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** "3 a day" ("3/day" short), "0.5 a day", "None" (rounded like Reports: see `pace`). */
export function perDay(velocity, { short = false } = {}) {
  if (velocity === null || velocity === undefined) return '—';
  if (velocity === 0) return 'None';
  return short ? `${pace(velocity)}/day` : `${pace(velocity)} a day`;
}

/**
 * A unit cost for a text box: at least the currency's decimals, up to the 4 stored ("6.40",
 * "1.005", "41900" for CLP), no thousands separators.
 */
export function costText(value, currencyCode) {
  if (value === null || value === undefined || value === '') return '';
  let decimals = 2;
  try {
    decimals = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    // Not a currency code (yet): 2 decimals.
  }
  return Number(value).toLocaleString('en-US', {
    useGrouping: false,
    minimumFractionDigits: decimals,
    maximumFractionDigits: Math.max(decimals, 4),
  });
}

/** "14 days (supplier)" style explanation of where a lead time comes from. */
export function leadTimeText(leadTimeDays, source, supplierName) {
  const text = days(leadTimeDays === 0 ? 0 : leadTimeDays).replace('less than a day', 'same day');
  if (source === 'item') return `${text} (this product)`;
  if (source === 'supplier') return `${text} (${supplierName ?? 'supplier'})`;
  return `${text} (default)`;
}

/** A decimal text box for money (unit costs): typed as text, so "2,50" can be read too. */
export function moneyInput(props = {}) {
  return input({
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    class: 'input input-money',
    ...props,
  });
}

/** "2.5", "2,50", "1,234.5" → 2.5 / 2.5 / 1234.5; '' → null; anything else → NaN. */
export function parseDecimal(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/\s/g, '');
  if (text === '') return null;
  // One comma and no dot is a decimal comma; otherwise commas group thousands.
  const normalized = /^\d*,\d+$/.test(text) ? text.replace(',', '.') : text.replace(/,/g, '');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}

export function wholeNumberInput(props = {}) {
  return input({
    type: 'number',
    min: 0,
    max: 1000000,
    step: 1,
    inputmode: 'numeric',
    class: 'input input-short',
    ...props,
  });
}

/** Reads an optional whole number field: '' → null, else the integer, or throws `message`. */
export function readWholeNumber(el, { min = 0, max = 1000000, message }) {
  const raw = el.value.trim();
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(message);
  return value;
}

/**
 * The add/edit supplier dialog. Resolves with the saved supplier (as the API returns it), or
 * null when cancelled.
 */
export async function supplierDialog(supplier, { baseCurrency }) {
  const name = input({ name: 'name', required: true, maxlength: 200, value: supplier?.name ?? '' });
  const contact = input({
    name: 'contactName',
    maxlength: 200,
    value: supplier?.contactName ?? '',
    autocomplete: 'off',
  });
  const email = input({
    type: 'email',
    name: 'email',
    maxlength: 254,
    value: supplier?.email ?? '',
    placeholder: 'e.g. orders@supplier.com',
  });
  const phone = input({ type: 'tel', name: 'phone', maxlength: 50, value: supplier?.phone ?? '' });
  const currency = input({
    name: 'currencyCode',
    required: true,
    maxlength: 3,
    value: supplier?.currencyCode ?? baseCurrency,
    class: 'input input-short input-currency',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const leadTime = wholeNumberInput({
    name: 'leadTimeDays',
    max: 365,
    value: supplier?.leadTimeDays ?? '',
  });
  const notes = h('textarea', {
    class: 'input textarea',
    name: 'notes',
    rows: 3,
    maxlength: 2000,
    value: supplier?.notes ?? '',
  });
  return formDialog({
    title: supplier ? `Edit “${supplier.name}”` : 'Add a supplier',
    content: [
      field({ label: 'Name', control: name }),
      h(
        'div',
        { class: 'po-fields' },
        field({ label: 'Contact person', control: contact, optional: true }),
        field({ label: 'Phone', control: phone, optional: true }),
      ),
      field({
        label: 'Email',
        control: email,
        optional: true,
        hint: 'Where you send purchase orders. Shown on printed orders.',
      }),
      h(
        'div',
        { class: 'po-fields' },
        field({
          label: 'Currency',
          control: currency,
          hint: `What they invoice in, e.g. ${baseCurrency} or EUR.`,
        }),
        field({
          label: 'Lead time (days)',
          control: leadTime,
          optional: true,
          hint: 'From ordering to delivery.',
        }),
      ),
      field({ label: 'Notes', control: notes, optional: true }),
    ],
    submitLabel: supplier ? 'Save' : 'Add supplier',
    onSubmit: async () => {
      const code = currency.value.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) throw new Error('Enter a 3-letter currency code, like USD.');
      const body = {
        name: name.value.trim(),
        contactName: contact.value.trim(),
        email: email.value.trim(),
        phone: phone.value.trim(),
        currencyCode: code,
        leadTimeDays: readWholeNumber(leadTime, {
          max: 365,
          message: 'Enter the lead time as a whole number of days (0 to 365), or leave it empty.',
        }),
        notes: notes.value.trim(),
      };
      if (!body.name) throw new Error('Enter the supplier’s name.');
      if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
        throw new Error('Enter an email address like orders@supplier.com, or leave it empty.');
      }
      if (!supplier) {
        return api('/api/purchasing/suppliers', { method: 'POST', body, toastErrors: false });
      }
      const save = (confirmCurrencyChange) =>
        api(`/api/purchasing/suppliers/${supplier.id}`, {
          method: 'PATCH',
          body: confirmCurrencyChange ? { ...body, confirmCurrencyChange } : body,
          toastErrors: false,
        });
      const changing = code !== supplier.currencyCode;
      if (changing && supplier.pricedItemCount > 0) {
        if (!(await confirmCurrencyChange(supplier, code, supplier.pricedItemCount))) {
          throw new Error('The currency wasn’t changed. Put it back, or confirm to change it.');
        }
        return save(true);
      }
      try {
        return await save(false);
      } catch (err) {
        // Prices were added since the page loaded: the server asks for the same confirmation.
        const priced = err instanceof ApiError && err.body?.currencyChange?.pricedItems;
        if (!changing || !priced) throw err;
        if (!(await confirmCurrencyChange(supplier, code, priced))) {
          throw new Error('The currency wasn’t changed. Put it back, or confirm to change it.', {
            cause: err,
          });
        }
        return save(true);
      }
    },
  });
}

/** Asks before a supplier's prices are read in another currency (they keep their numbers). */
function confirmCurrencyChange(supplier, code, priced) {
  return confirmDialog({
    title: `Change “${supplier.name}” to ${code}?`,
    message: [
      h(
        'p',
        {},
        `${supplier.name} has prices for ${plural(priced, 'product')} in ${supplier.currencyCode}. They stay as the same numbers, now in ${code}: a price of 12.50 ${supplier.currencyCode} becomes 12.50 ${code}.`,
      ),
      h(
        'p',
        { class: 'muted' },
        'Check them on the supplier’s page afterwards. Orders already made keep their own currency.',
      ),
    ],
    confirmLabel: `Change to ${code}`,
  });
}
