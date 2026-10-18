/**
 * The price rule maths of src/pricing/compute.ts and src/util/money.ts, ported for live previews
 * on the Prices page (what a rule makes of a base price while the merchant edits it). It must give
 * exactly the server's results: both are checked against the same examples in
 * test/fixtures/pricing-vectors.json (test/pricing-vectors.test.ts). Change both together.
 */

const decimalsCache = new Map();

/** Decimals a currency is written with: USD 2, CLP and JPY 0, KWD 3. Unknown codes get 2. */
export function currencyDecimals(code) {
  let decimals = decimalsCache.get(code);
  if (decimals === undefined) {
    decimals = 2;
    try {
      const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
      decimals = format.resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      // Not a well-formed currency code: keep 2.
    }
    decimalsCache.set(code, decimals);
  }
  return decimals;
}

/** Half away from zero on the decimal representation (1.005 → 1.01), like the server. */
export function roundMoney(value, decimals) {
  if (!Number.isFinite(value)) return value;
  const decimal = Number(Math.abs(value).toPrecision(15));
  const magnitude = shift(Math.round(shift(decimal, decimals)), -decimals);
  return magnitude === 0 ? 0 : Math.sign(value) * magnitude;
}

function shift(value, by) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  return Number(`${mantissa}e${Number(exponent) + by}`);
}

const DIRECTIONS = { up: Math.ceil, nearest: Math.round, down: Math.floor };

const snap = (value) => Math.round(value * 1e9) / 1e9;

/** A rule's rounding (none | ending | multiple), then the currency's decimals. Never below 0. */
export function roundPrice(value, rule, currencyCode) {
  const decimals = currencyDecimals(currencyCode);
  if (rule.roundMode === 'none') return roundMoney(value, decimals);
  const step = rule.roundStep;
  const ending = rule.roundMode === 'ending' ? rule.roundEnding : 0;
  const quotient = snap((value - ending) / step);
  let result = DIRECTIONS[rule.roundDirection](quotient) * step + ending;
  if (result < 0) result = Math.ceil(quotient) * step + ending;
  return roundMoney(result, decimals);
}

const compareAtAbove = (compareAt, price) =>
  compareAt !== null && compareAt > price ? compareAt : null;

/**
 * { status: 'ok', source, price, compareAtPrice (number | null | 'keep') } or
 * { status: 'none', reason: 'rule_disabled' | 'no_base_price' }, from
 * { basePrice, baseCompareAtPrice, exchangeRate, rule, currencyCode, override }.
 */
export function computeTargetPrice(input) {
  const decimals = currencyDecimals(input.currencyCode);
  if (input.override) {
    const price = roundMoney(input.override.price, decimals);
    const compareAt = input.override.compareAtPrice;
    return {
      status: 'ok',
      source: 'override',
      price,
      compareAtPrice: compareAtAbove(
        compareAt === null ? null : roundMoney(compareAt, decimals),
        price,
      ),
    };
  }
  const { rule } = input;
  if (!rule || !rule.enabled) return { status: 'none', reason: 'rule_disabled' };
  if (input.basePrice === null) return { status: 'none', reason: 'no_base_price' };
  const convert = (base) =>
    Math.max(
      0,
      roundPrice(
        base * input.exchangeRate * rule.multiplier + rule.addAmount,
        rule,
        input.currencyCode,
      ),
    );
  const price = convert(input.basePrice);
  let compareAt;
  switch (rule.compareAtMode) {
    case 'none':
      compareAt = null;
      break;
    case 'keep':
      compareAt = 'keep';
      break;
    case 'from_base':
      compareAt = input.baseCompareAtPrice === null ? null : convert(input.baseCompareAtPrice);
      break;
    case 'markup':
      compareAt = roundPrice(price * rule.compareAtMarkup, rule, input.currencyCode);
      break;
  }
  return {
    status: 'ok',
    source: 'rule',
    price,
    compareAtPrice: compareAt === 'keep' ? 'keep' : compareAtAbove(compareAt, price),
  };
}
