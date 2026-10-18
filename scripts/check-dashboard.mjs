// End-to-end check of the dashboard (public/) in the pre-installed Chromium, against the mock API
// in ./dashboard-mock-api.mjs (no Postgres or Shopify needed):
//   - every page at phone (390px) and desktop (1280px) width, in light and dark mode, fails on
//     console errors, failed requests, horizontal scrolling, unlabeled controls and duplicate ids;
//   - the main flows (adjust stock, link a variant, add a store, onboarding, alerts, settings...);
//   - full-page screenshots of everything into $SCREENSHOT_DIR (default: <tmp>/dashboard-screens).
// Usage: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/check-dashboard.mjs
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import * as catalogChecks from './checks/catalog.mjs';
import * as pricingChecks from './checks/pricing.mjs';
import * as purchasingChecks from './checks/purchasing.mjs';
import * as salesChecks from './checks/sales.mjs';
import { createMockState, startMockServer } from './dashboard-mock-api.mjs';

const SCREENSHOT_DIR = path.resolve(
  process.env.SCREENSHOT_DIR ?? path.join(os.tmpdir(), 'dashboard-screens'),
);
const WIDTHS = [390, 1280];
const SCHEMES = ['light', 'dark'];
/** Each feature's pages and flows (scripts/checks/*.mjs). */
const FEATURES = [catalogChecks, pricingChecks, salesChecks, purchasingChecks];
const PAGES = [
  ['overview', '#/'],
  ['products', '#/items'],
  ['products-attention', '#/items?filter=issues'],
  ['product', '#/items/5'],
  ['product-oversold', '#/items/3'],
  ['matching', '#/mapping'],
  ['matching-conflicts', '#/mapping?tab=conflicts'],
  ['matching-ignored', '#/mapping?tab=ignored'],
  ['stores', '#/stores'],
  ['store-new', '#/stores/new'],
  ['store-error', '#/stores/3'],
  ['store', '#/stores/1'],
  ['store-currency', '#/stores/2'],
  ['onboarding', '#/onboarding'],
  ['activity', '#/activity'],
  ['alerts', '#/alerts'],
  ['settings', '#/settings'],
  ['not-found', '#/no-such-page'],
  ...FEATURES.flatMap((feature) => feature.PAGES),
];
// Stands in for Shopify's image CDN (product images): the sandboxed browser can't reach it.
const CDN_IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c9ced6"/></svg>';

// Browser-side checks, as strings so this Node script needs no DOM globals.
const READY = `!document.querySelector('.state-loading, [aria-busy="true"]') && !!document.querySelector('main h1')`;
const OVERFLOW = `document.documentElement.scrollWidth - document.documentElement.clientWidth`;
const UNLABELED = `[...document.querySelectorAll('input:not([type=hidden]), select, textarea, button, a[href]')]
  .filter((el) => el.getClientRects().length > 0)
  .filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
    || (el.labels && el.labels.length) || el.textContent.trim()))
  .map((el) => el.outerHTML.slice(0, 120))`;
const DUPLICATE_IDS = `[...document.querySelectorAll('[id]')].map((el) => el.id)
  .filter((id, i, all) => all.indexOf(id) !== i)`;

const failures = [];
const screenshots = [];
let allowHttpErrors = false;

function fail(message) {
  failures.push(message);
  console.error(`  ✗ ${message}`);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

async function newPage(browser, baseUrl, { width = 1280, scheme = 'light' } = {}) {
  const phone = width < 600;
  const context = await browser.newContext({
    viewport: { width, height: phone ? 844 : 900 },
    isMobile: phone,
    hasTouch: phone,
    colorScheme: scheme,
    reducedMotion: 'reduce',
  });
  await context.route('https://cdn.shopify.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: CDN_IMAGE }),
  );
  const page = await context.newPage();
  const label = `${width}px ${scheme}`;
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Chromium logs every non-2xx fetch; expected ones are allowed below.
    if (allowHttpErrors && msg.text().startsWith('Failed to load resource')) return;
    fail(`[${label}] console error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => fail(`[${label}] page error: ${err.message}`));
  page.on('requestfailed', (req) => {
    if (req.failure()?.errorText === 'net::ERR_ABORTED') return; // aborted on purpose
    fail(`[${label}] request failed: ${req.url()} ${req.failure()?.errorText}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !allowHttpErrors) {
      fail(`[${label}] HTTP ${res.status()} for ${res.request().method()} ${res.url()}`);
    }
  });
  return { context, page, open: (hash) => open(page, baseUrl, hash) };
}

async function open(page, baseUrl, hash) {
  // When only the hash changes, goto() returns before the router has swapped the page: mark the
  // old view and wait for it to go, or the checks below would look at the previous page.
  const leaving = await page
    .evaluate(
      `(() => {
        const view = document.querySelector('#main > .view');
        if (!view || !location.hash || location.hash === ${JSON.stringify(hash)}) return false;
        view.dataset.leaving = '';
        return true;
      })()`,
    )
    .catch(() => false);
  await page.goto(`${baseUrl}/${hash}`);
  if (leaving) await waitUntil(page, `!document.querySelector('#main > .view[data-leaving]')`);
  await settle(page);
}

async function settle(page) {
  await page.waitForLoadState('networkidle');
  await waitUntil(page, READY);
}

/**
 * Polls a browser-side expression from Node. (page.waitForFunction evaluates its predicate with
 * eval, which the dashboard's Content-Security-Policy rightly forbids.)
 */
async function waitUntil(page, expression, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!(await page.evaluate(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function shoot(page, name, options = {}) {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  // Toasts are fixed to the viewport and would float over the middle of a full-page capture.
  await page.locator('#toasts').evaluate((el) => el.replaceChildren());
  await page.screenshot({ path: file, fullPage: true, ...options });
  screenshots.push(file);
}

async function checkPage(page, label) {
  const overflow = await page.evaluate(OVERFLOW);
  expect(overflow <= 0, `${label}: page scrolls sideways by ${overflow}px`);
  const unlabeled = await page.evaluate(UNLABELED);
  expect(unlabeled.length === 0, `${label}: controls without a label: ${unlabeled.join(' | ')}`);
  const duplicates = await page.evaluate(DUPLICATE_IDS);
  expect(duplicates.length === 0, `${label}: duplicate ids: ${duplicates.join(', ')}`);
  const headings = await page.locator('main h1').count();
  expect(headings === 1, `${label}: expected one h1, found ${headings}`);
}

async function visitEveryPage(browser, baseUrl, server) {
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      server.state = createMockState();
      const { context, open: go, page } = await newPage(browser, baseUrl, { width, scheme });
      for (const [name, hash] of PAGES) {
        const label = `${name} @ ${width}px ${scheme}`;
        await go(hash);
        await checkPage(page, label);
        await shoot(page, `${name}-${width}-${scheme}`);
      }
      await context.close();
    }
  }
}

async function step(name, fn) {
  console.log(`- ${name}`);
  try {
    await fn();
  } catch (err) {
    fail(`${name}: ${err.message.split('\n')[0]}`);
  }
}

const toastText = (page) => page.locator('.toast').last().textContent();

/** What feature checks get (scripts/checks/*.mjs). */
function featureContext(page, go, server) {
  return {
    page,
    go,
    step,
    expect,
    shoot,
    toastText,
    waitUntil,
    settle,
    server,
    createMockState,
    /** Expected 4xx/5xx responses (e.g. a validation error) don't fail the check meanwhile. */
    setAllowHttpErrors: (allow) => {
      allowHttpErrors = allow;
    },
  };
}

/**
 * Runs one feature's flows from a fresh mock state, so what one feature's flows change (or leave
 * allowed) never shows up in another's.
 */
async function featureFlows(run, page, go, server) {
  server.state = createMockState();
  allowHttpErrors = false;
  await run(featureContext(page, go, server));
  allowHttpErrors = false;
}

async function flows(browser, baseUrl, server) {
  server.state = createMockState();
  const { context, page, open: go } = await newPage(browser, baseUrl);

  await step('overview shows store problems and refreshes in place', async () => {
    await go('#/');
    expect((await page.locator('.tile').count()) === 3, 'overview: three store tiles');
    expect(
      (await page.locator('.banner-large .banner-title').textContent()) === 'Needs attention',
      'overview: a store in error means "Needs attention"',
    );
    await page.getByRole('button', { name: 'Refresh' }).click();
    await settle(page);
    expect(
      (await page.locator('.tile').count()) === 3,
      'overview: still three tiles after refresh',
    );
  });

  await step('keyboard: skip link is the first stop and focuses the content', async () => {
    await go('#/');
    await page.reload();
    await settle(page);
    await page.keyboard.press('Tab');
    expect(
      (await page.evaluate('document.activeElement.textContent')) === 'Skip to content',
      'first Tab reaches the skip link',
    );
    await page.keyboard.press('Enter');
    expect((await page.evaluate('document.activeElement.id')) === 'main', 'skip link focuses main');
  });

  await step('products: search, filter and open a product', async () => {
    await go('#/items');
    await page.getByLabel('Search products').fill('HOOD');
    await page.waitForTimeout(400);
    await settle(page);
    const skus = await page.locator('.product-meta .mono').allTextContents();
    expect(
      skus.length > 0 && skus.every((s) => s.includes('HOOD')),
      'search keeps only matching SKUs',
    );
    expect(page.url().includes('search=HOOD'), 'search is kept in the address');
    await page.getByLabel('Search products').fill('');
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Oversold' }).click();
    await settle(page);
    const badges = await page.locator('tbody .badge-critical').allTextContents();
    expect(badges.length > 0 && badges.every((b) => b.includes('oversold')), 'oversold filter');
    await page.locator('tbody .product-link').first().click();
    await settle(page);
    expect(/#\/items\/\d+$/.test(page.url()), 'row opens the product');
  });

  await step('product: set stock, invalid removal, pause', async () => {
    await go('#/items/5');
    await page.getByRole('button', { name: 'Set stock to…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Number of units').fill('40');
    await shoot(page, 'dialog-set-stock-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });
    expect((await toastText(page)).includes('Count of 40 saved'), 'stock count toast');
    await page.waitForTimeout(2800);
    await settle(page);
    expect(
      (await page.locator('.big-number-value').first().textContent()).includes('37'),
      'shared stock shows the count minus units waiting to ship',
    );

    await page.getByRole('button', { name: 'Add or remove units…' }).click();
    await dialog.getByText('Units left (remove)').click();
    await dialog.getByLabel('How many units').fill('999');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.locator('.form-error').waitFor();
    expect(
      (await dialog.locator('.form-error').textContent()).includes('You can remove at most 37'),
      'removing more than in stock is refused inline',
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Pause syncing' }).click();
    await dialog.getByRole('button', { name: 'Pause syncing' }).click();
    await dialog.waitFor({ state: 'detached' });
    await settle(page);
    expect(
      (await page.locator('.page-title-row .badge').textContent()).includes('Paused'),
      'paused badge',
    );
  });

  await step('matching: link an unmatched variant, see conflicts', async () => {
    await go('#/mapping');
    await page.getByRole('button', { name: 'Link to product…' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.picker-option').first().waitFor();
    await dialog.getByLabel('Search products').fill('TEE-ORG-BLA-M');
    await page.waitForTimeout(400);
    await waitUntil(page, `!document.querySelector('.picker-results[aria-busy]')`);
    const options = await dialog.locator('.picker-option .mono').allTextContents();
    expect(options[0] === 'TEE-ORG-BLA-M', `search finds the right product first (${options})`);
    await dialog.locator('.picker-option:not(.is-disabled)').first().click();
    await shoot(page, 'dialog-link-picker-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Link' }).click();
    await dialog.waitFor({ state: 'detached' });
    expect((await toastText(page)).includes('is now linked'), 'link toast');
    await page.getByRole('button', { name: /Duplicate SKUs/ }).click();
    await settle(page);
    expect((await page.locator('.conflict-group').count()) === 2, 'two duplicate-SKU groups');
  });

  await step('add store: connection errors shown inline, then success', async () => {
    await go('#/stores/new');
    const steps = await page.locator('ol.steps').first().textContent();
    expect(
      steps.includes('write_products') && steps.includes('For Catalog and Prices'),
      'setup steps list the optional permissions and what they are for',
    );
    await page.getByLabel('Name').fill('Ocean Row');
    await page.getByLabel('Shopify address').fill('ocean-row.myshopify.com');
    await page.getByLabel('Client ID').fill('scopes');
    await page.getByLabel('Client secret').fill('anything');
    allowHttpErrors = true;
    await page.getByRole('button', { name: 'Connect store' }).click();
    await page.locator('.form-error:not([hidden])').waitFor();
    const error = await page.locator('.form-error').textContent();
    expect(error.includes('write_inventory'), 'missing scopes are listed');
    await shoot(page, 'store-new-error-1280-light');
    await page.getByLabel('Client ID').fill('abc');
    await page.getByLabel('Client secret').fill('good-secret');
    allowHttpErrors = false;
    await page.getByRole('button', { name: 'Connect store' }).click();
    await page.waitForURL(/#\/stores\/4$/);
    await settle(page);
    expect((await page.locator('main h1').textContent()) === 'Ocean Row', 'new store page opens');
  });

  await step('store: location mapping asks first and refuses a second location', async () => {
    await go('#/stores/1');
    await page.getByLabel('Pop-up shop').selectOption({ label: 'Holds the shared stock' });
    await page.locator('.toast-error').waitFor();
    expect((await toastText(page)).includes('already holds'), 'second location refused');
    expect((await page.getByLabel('Pop-up shop').inputValue()) === '', 'select reverted');
    await page.getByLabel('Leeds warehouse').selectOption({ label: 'Not synced' });
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Stop syncing' }).click();
    await dialog.waitFor({ state: 'detached' });
    await settle(page);
    expect((await page.getByLabel('Leeds warehouse').inputValue()) === '', 'location unmapped');
  });

  await step('onboarding: preview, confirm, progress', async () => {
    server.state = createMockState();
    await go('#/onboarding');
    await page.getByRole('button', { name: /Choose starting numbers/ }).click();
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await settle(page);
    const start = page.getByRole('button', { name: /Start syncing \d+ product/ });
    expect(await start.isDisabled(), 'start needs the confirmation checkbox');
    await shoot(page, 'onboarding-preview-1280-light');
    await page.getByLabel('I understand that my stores’ stock numbers will be replaced.').check();
    await start.click();
    await page.getByText('Syncing has started').waitFor();
    await page.getByText('All set: your stores now share one stock').waitFor({ timeout: 15_000 });
    await shoot(page, 'onboarding-done-1280-light');
  });

  await step('activity: load more until the end', async () => {
    await go('#/activity');
    expect((await page.locator('.timeline-entry').count()) === 50, 'first page has 50 entries');
    await page.getByRole('button', { name: 'Load more' }).click();
    await waitUntil(page, `document.querySelectorAll('.timeline-entry').length === 100`);
    await page.getByRole('button', { name: 'Load more' }).click();
    await page.getByText('That’s everything.').waitFor();
  });

  await step('alerts: resolve one', async () => {
    await go('#/alerts');
    const before = await page.locator('.alert-item').count();
    await page.getByRole('button', { name: 'Resolve', exact: true }).first().click();
    await waitUntil(page, `document.querySelectorAll('.alert-item').length === ${before - 1}`);
    await waitUntil(
      page,
      `document.getElementById('alerts-count').textContent.includes('${before - 1}')`,
    );
  });

  await step('settings: save, test alert, pause and resume from another page', async () => {
    await go('#/settings');
    const save = page.getByRole('button', { name: 'Save settings' });
    expect(await save.isDisabled(), 'save starts disabled');
    await page.getByLabel('Default low-stock alert at').fill('7');
    await save.click();
    await page.locator('.toast', { hasText: 'Settings saved.' }).waitFor();
    await settle(page);
    await page.getByRole('button', { name: 'Send test alert' }).click();
    await page.getByText('Test alert sent').waitFor();
    await page.getByRole('button', { name: 'Pause all syncing' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reason').fill('Checking a stock count');
    await dialog.getByRole('button', { name: 'Pause syncing' }).click();
    await dialog.waitFor({ state: 'detached' });
    await go('#/items');
    await page.locator('.global-notice').waitFor();
    await shoot(page, 'paused-notice-1280-light', { fullPage: false });
    await page.locator('.global-notice').getByRole('button', { name: 'Resume sync' }).click();
    await page.locator('.global-notice').waitFor({ state: 'detached' });
  });

  await step('store: exchange rate shown for another currency, validated and saved', async () => {
    await go('#/stores/1');
    expect(
      (await page.getByLabel(/for 1 USD/).count()) === 0,
      'no exchange rate for a store in the base currency',
    );
    await go('#/stores/2');
    expect(
      (await page.locator('.fact', { hasText: 'Exchange rate' }).textContent()).includes(
        '1 USD = 4,100.00 COP',
      ),
      'exchange rate shown as 1 USD = 4,100.00 COP',
    );
    const rate = page.getByLabel('COP for 1 USD');
    await rate.fill('0');
    await page.getByRole('button', { name: 'Save rate' }).click();
    expect(
      (await page.locator('.field-error:not([hidden])').textContent()).includes('above 0'),
      'a zero rate is refused inline',
    );
    await rate.fill('4250.5');
    expect(
      (await page.locator('.preview-line').textContent()) === 'New rate: 1 USD = 4,250.50 COP',
      'live preview of the rate',
    );
    await page.getByRole('button', { name: 'Save rate' }).click();
    await page.locator('.toast', { hasText: 'Exchange rate saved' }).waitFor();
    await settle(page);
    expect(server.state.stores[1].exchangeRate === 4250.5, 'rate saved');
    const permissions = await page
      .locator('.card', { hasText: 'Permissions for extra features' })
      .textContent();
    expect(
      permissions.includes('read_orders') && permissions.includes('For Reports'),
      'missing permission listed with the feature it turns on',
    );
  });

  await step('settings: currency, reorder, sales history and cost settings', async () => {
    await go('#/settings');
    await page.getByLabel('Base currency').fill('eur');
    await page.getByLabel('Safety margin (days)').fill('10');
    await page.getByLabel('Report days follow the time zone').selectOption('America/Bogota');
    await page.getByLabel('When a delivery arrives, a product’s cost becomes').selectOption('last');
    await page.getByLabel('Copy costs to Shopify').check();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.locator('.toast', { hasText: 'Settings saved.' }).waitFor();
    expect(
      server.state.settings.baseCurrency === 'EUR' &&
        server.state.settings.reorderSafetyDays === 10 &&
        server.state.settings.reportTimezone === 'America/Bogota' &&
        server.state.settings.costMethod === 'last' &&
        server.state.settings.pushCostsToShopify === true,
      `new settings saved (${JSON.stringify(server.state.settings)})`,
    );
    await settle(page);
    await page.getByLabel('Order enough for (days)').fill('0');
    await page.getByRole('button', { name: 'Save settings' }).click();
    expect(
      await page.getByLabel('Order enough for (days)').evaluate((el) => !el.validity.valid),
      'cover days below 1 refused by the form',
    );
  });

  await step('new sections are in the menu', async () => {
    await go('#/');
    const nav = await page.locator('#sidebar .nav-list a').allTextContents();
    const expected = ['Overview', 'Products', 'Catalog', 'Prices', 'Purchasing', 'Reports'];
    expect(
      expected.every((label, i) => nav[i]?.trim() === label),
      `menu order (${nav.join(', ')})`,
    );
    await page.locator('#sidebar').getByRole('link', { name: 'Reports' }).click();
    // The address changes before the router has handled it: wait for the new page.
    await waitUntil(page, `document.querySelector('main h1')?.textContent === 'Reports'`);
    await settle(page);
    const current = await page.locator('#sidebar a[aria-current="page"]').allTextContents();
    expect(
      current.length === 1 && current[0].includes('Reports'),
      `Reports is highlighted (${current.join(', ')}, ${page.url()})`,
    );
    await go('#/purchasing/orders/5');
    expect((await page.locator('main h1').textContent()) === 'PO-0005', 'purchase order page');
    expect(
      (await page.locator('#sidebar a[aria-current="page"]').textContent()).includes('Purchasing'),
      'a purchase order highlights Purchasing',
    );
  });

  for (const feature of FEATURES) await featureFlows(feature.flows, page, go, server);
  server.state = createMockState();

  await step('signed out: every request fails with 401', async () => {
    server.state.signedOut = true;
    allowHttpErrors = true;
    await page.reload();
    await page.locator('.signed-out').waitFor();
    allowHttpErrors = false;
    server.state.signedOut = false;
  });

  await context.close();
}

async function phoneFlows(browser, baseUrl, server) {
  server.state = createMockState();
  const { context, page, open: go } = await newPage(browser, baseUrl, { width: 390 });
  await step(
    'phone: overview before onboarding, while paused, while loading, and empty',
    async () => {
      server.state.settings.onboardingCompleted = false;
      await go('#/');
      expect(
        (await page.locator('.banner-large .banner-title').textContent()) === 'Not syncing yet',
        'overview invites to start syncing',
      );
      await shoot(page, 'overview-not-started-390-light');
      Object.assign(server.state.settings, {
        syncPaused: true,
        pausedReason: 'Checking a stock count',
      });
      await page.reload();
      await settle(page);
      expect(
        (await page.locator('.banner-large .banner-title').textContent()) === 'Sync is paused',
        'overview shows the pause',
      );
      await shoot(page, 'overview-paused-390-light', { fullPage: false });
      server.state.delayMs = 1500;
      await page.reload();
      await page.locator('.state-loading').waitFor();
      await shoot(page, 'overview-loading-390-light', { fullPage: false });
      server.state = createMockState();
      Object.assign(server.state, { stores: [], items: [], variants: [], alerts: [], events: [] });
      await go('#/stores');
      await go('#/');
      await shoot(page, 'overview-empty-390-light', { fullPage: false });
      await go('#/items');
      await shoot(page, 'products-empty-390-light', { fullPage: false });
      server.state = createMockState();
    },
  );
  await step('phone: menu opens, navigates and closes', async () => {
    await go('#/');
    await page.getByRole('button', { name: 'Menu' }).click();
    await shoot(page, 'menu-open-390-light', { fullPage: false });
    await page.locator('#sidebar').getByRole('link', { name: 'Products' }).click();
    await page.locator('#sidebar').waitFor({ state: 'hidden', timeout: 2000 });
    await settle(page);
    expect(page.url().endsWith('#/items'), 'menu link navigates');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.mouse.click(195, 800); // below the open menu
    await page.locator('#sidebar').waitFor({ state: 'hidden', timeout: 2000 });
  });
  await step('phone: dialog fits the screen', async () => {
    await go('#/items/5');
    await page.getByRole('button', { name: 'Add or remove units…' }).click();
    await shoot(page, 'dialog-adjust-390-light', { fullPage: false });
    const box = await page.getByRole('dialog').boundingBox();
    expect(box.x >= 0 && box.x + box.width <= 390, 'dialog within the viewport');
    await page.keyboard.press('Escape');
  });
  for (const feature of FEATURES) await featureFlows(feature.phoneFlows, page, go, server);
  await context.close();
}

await mkdir(SCREENSHOT_DIR, { recursive: true });
const { server, url } = await startMockServer();
const browser = await chromium.launch();
try {
  console.log(`Every page at ${WIDTHS.join(' and ')}px, ${SCHEMES.join(' and ')}:`);
  await visitEveryPage(browser, url, server);
  console.log('Flows:');
  await flows(browser, url, server);
  await phoneFlows(browser, url, server);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${screenshots.length} screenshots in ${SCREENSHOT_DIR}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s) found.`);
  process.exit(1);
}
console.log('Dashboard check passed.');
