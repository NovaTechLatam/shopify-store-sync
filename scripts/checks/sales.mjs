// Dashboard checks for the reports page, run by ../check-dashboard.mjs.

/** Pages visited at every width and colour scheme: [screenshot name, hash]. */
export const PAGES = [
  ['reports', '#/reports'],
  ['reports-one-store-90d', '#/reports?period=90d&stores=1&sort=daysLeft'],
];

const DAY_MS = 24 * 60 * 60_000;
/** A date `n` days from today, as the date inputs take it. */
const dayFromToday = (n) => new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
const statValue = (page, label) =>
  page.locator('.report-stats .stat').filter({ hasText: label }).locator('.stat-value');
const numberIn = (text) => Number(text.replace(/[^\d.]/g, ''));

/**
 * Flows at 1280px. `ctx` = { page, go, step, expect, shoot, toastText, waitUntil, settle, server,
 * createMockState, setAllowHttpErrors } (see check-dashboard.mjs for each).
 */
export async function flows(ctx) {
  const { page, go, step, expect, shoot, toastText, settle, server, createMockState } = ctx;

  await step('reports: a shorter period shows fewer sales, and stays in the address', async () => {
    await go('#/reports');
    const month = numberIn(await statValue(page, 'Orders').textContent());
    await page.getByRole('button', { name: 'Last 7 days' }).click();
    await settle(page);
    const week = numberIn(await statValue(page, 'Orders').textContent());
    expect(week > 0 && week < month, `7 days (${week}) has fewer orders than 30 (${month})`);
    expect(page.url().includes('period=7d'), 'period in the address');
    expect(
      (await page.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')) ===
        'true',
      'the chosen period is pressed',
    );
    const chart = page.locator('svg.chart[role="img"]');
    expect(
      ((await chart.getAttribute('aria-label')) ?? '').startsWith('Revenue by day'),
      'the chart has a summary label',
    );
    expect(
      (await page.locator('.chart-holder + .sr-only table tbody tr').count()) === 7,
      'a hidden table row per day',
    );
    await shoot(page, 'reports-7d-1280-light');
  });

  await step('reports: a custom range is checked before it is used', async () => {
    await go('#/reports');
    await page.getByRole('button', { name: 'Custom range' }).click();
    const form = page.locator('.report-range');
    await form.waitFor();
    await form.getByLabel('From').fill(dayFromToday(-3));
    await form.getByLabel('To').fill(dayFromToday(-10));
    let requests = 0;
    const count = (req) => {
      if (req.url().includes('/api/reports/')) requests++;
    };
    page.on('request', count);
    await form.getByRole('button', { name: 'Show' }).click();
    const error = form.locator('.field-error');
    await error.waitFor();
    expect(
      (await error.textContent()) === 'The start date must be on or before the end date.',
      'start after end is refused in words',
    );
    expect(requests === 0, 'nothing is asked of the server for an impossible range');
    expect(
      (await form.getByLabel('From').getAttribute('aria-invalid')) === 'true',
      'the dates are marked invalid',
    );
    await shoot(page, 'reports-range-error-1280-light', { fullPage: false });
    page.off('request', count);

    // Over 3 months: the chart shows weeks.
    await form.getByLabel('From').fill(dayFromToday(-200));
    await form.getByLabel('To').fill(dayFromToday(0));
    await form.getByRole('button', { name: 'Show' }).click();
    await settle(page);
    expect(await error.isHidden(), 'the error goes once the range is right');
    expect(page.url().includes(`from=${dayFromToday(-200)}`), 'custom dates in the address');
    expect(
      (await page.locator('.card-title').filter({ hasText: 'Revenue by' }).textContent()) ===
        'Revenue by week',
      'long periods are shown by week',
    );
    expect(
      (await page.locator('.report-issues').textContent()).includes(
        'Earlier days of this period have no sales from it.',
      ),
      'a period longer than the history says so',
    );
    await shoot(page, 'reports-custom-weeks-1280-light');
  });

  await step('reports: pick a store', async () => {
    await go('#/reports');
    await page.getByRole('button', { name: 'Little Fox Kids' }).click();
    await settle(page);
    expect(page.url().includes('stores=3'), 'store in the address');
    const rows = await page
      .locator('.card')
      .filter({ hasText: 'By store' })
      .locator('tbody tr')
      .allTextContents();
    expect(
      rows.length === 1 && rows[0].includes('Little Fox Kids'),
      `only that store, without a totals row (${rows.length} rows)`,
    );
    expect(
      (await page.getByRole('button', { name: 'All stores' }).getAttribute('aria-pressed')) ===
        'false',
      '“All stores” is no longer pressed',
    );
    await page.getByRole('button', { name: 'All stores' }).click();
    await settle(page);
    expect(!page.url().includes('stores='), 'back to every store');
  });

  await step('reports: sort and search the products, and the CSV follows', async () => {
    await go('#/reports');
    const table = page.locator('.card').filter({ hasText: 'By product' });
    await table.getByRole('button', { name: /^Units/ }).click();
    await settle(page);
    const header = table.locator('th[aria-sort]');
    expect((await header.textContent()).startsWith('Units'), 'units is the sorted column');
    expect((await header.getAttribute('aria-sort')) === 'descending', 'highest first');
    const units = (
      await table
        .locator('tbody td[data-label="Units"] .units-cell > span:first-child')
        .allTextContents()
    ).map((t) => Number.parseInt(t.replace(/,/g, ''), 10));
    expect(
      units.length > 1 && units.every((u, i) => i === 0 || units[i - 1] >= u),
      `rows go from most to fewest units (${units.slice(0, 5)})`,
    );
    await table.getByRole('button', { name: /^Units/ }).click();
    await settle(page);
    expect(
      (await table.locator('th[aria-sort]').getAttribute('aria-sort')) === 'ascending',
      'a second click turns the order round',
    );
    expect(
      page.url().includes('sort=units') && page.url().includes('dir=asc'),
      'sort in the address',
    );

    await table.getByLabel('Search products').fill('SOCK');
    await page.waitForTimeout(400);
    await settle(page);
    const skus = await table.locator('tbody .product-meta .mono').allTextContents();
    expect(skus.length > 0 && skus.every((s) => s.includes('SOCK')), 'search keeps matching SKUs');

    const href = await table.getByRole('link', { name: 'Download CSV' }).getAttribute('href');
    expect(
      href.startsWith('/api/reports/products.csv?') &&
        ['from=', 'to=', 'search=SOCK', 'sort=units', 'dir=asc'].every((p) => href.includes(p)),
      `the CSV link follows the report (${href})`,
    );
    const res = await page.request.get(new URL(href, page.url()).href);
    expect(
      res.status() === 200 && res.headers()['content-type'].startsWith('text/csv'),
      'the CSV downloads',
    );
    expect((await res.text()).split('\r\n')[0].includes('SKU,Product'), 'the CSV has its header');
    await shoot(page, 'reports-sorted-1280-light');
  });

  await step('reports: import a store’s history again', async () => {
    await go('#/reports');
    await page
      .getByRole('button', { name: 'Import the order history of Northwind Apparel again…' })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Import again' }).click();
    await dialog.waitFor({ state: 'detached' });
    expect(
      (await toastText(page)).includes('Importing the order history of Northwind Apparel'),
      'the toast says what happens next',
    );
    await settle(page);
    expect(
      (await page.locator('.coverage-list').textContent()).includes(
        'Northwind Apparel: importing the order history',
      ),
      'the store shows its import running',
    );
  });

  await step('reports: without permission, while importing, and without sales', async () => {
    server.state = createMockState();
    for (const store of server.state.stores) {
      store.features.sales = { available: false, missingScopes: ['read_orders'] };
      store.scopesCheckedAt = new Date().toISOString();
    }
    await go('#/');
    await go('#/reports');
    expect(
      (await page.locator('main .card-title').first().textContent()) ===
        'Store Sync can’t read your orders yet',
      'no permission: the steps to give it',
    );
    expect((await page.locator('main ol.steps li').count()) === 3, 'three steps');
    await shoot(page, 'reports-no-permission-1280-light');

    server.state = createMockState();
    server.state.sales.lines = [];
    server.state.sales.stores[1].backfill.status = 'running';
    await go('#/');
    await go('#/reports');
    expect(
      (await page.locator('main .state-title').textContent()) === 'Importing your order history',
      'nothing yet while the history is imported',
    );
    await shoot(page, 'reports-importing-1280-light');

    server.state = createMockState();
    await go('#/');
    await go('#/reports?period=custom&from=2020-01-01&to=2020-01-31');
    expect(
      (await page.locator('main .state-title').textContent()) === 'No sales in this period',
      'an empty period says so',
    );
    await shoot(page, 'reports-no-sales-1280-light', { fullPage: false });
  });

  await step('product page: sales by store for the last 30 days', async () => {
    server.state = createMockState();
    await go('#/items/1');
    const section = page.locator('[data-section="sales"]');
    await section.locator('.card').waitFor();
    expect(
      (await section.locator('.card-title').textContent()) === 'Sales in the last 30 days',
      'the sales section is on the product page',
    );
    const text = await section.textContent();
    expect(
      text.includes('Northwind Apparel') && text.includes('Days of stock left'),
      'sales by store, with days of stock left',
    );
    expect(
      (await section.getByRole('link', { name: 'Open in reports' }).getAttribute('href')) ===
        '#/reports?search=TEE-ORG-BLA-S',
      'links to the report for this product',
    );
  });
}

/** Flows at 390px (phone), same `ctx`. */
export async function phoneFlows(ctx) {
  const { page, go, step, expect, shoot, settle } = ctx;

  await step('phone: the report fits, tables become cards, the select sorts', async () => {
    await go('#/reports');
    const chart = await page.locator('svg.chart').boundingBox();
    expect(chart && chart.x >= 0 && chart.x + chart.width <= 390, 'the chart fits the screen');
    const label = await page
      .locator('svg.chart text')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(label >= 10, `chart labels stay readable (${label.toFixed(1)}px tall)`);
    const table = page.locator('.card').filter({ hasText: 'By product' });
    const display = await table
      .locator('tbody td')
      .first()
      .evaluate((el) => el.ownerDocument.defaultView.getComputedStyle(el).display);
    expect(display === 'flex', 'product rows are shown as cards');
    await shoot(page, 'reports-top-390-light', { fullPage: false });

    await table.getByLabel('Sort by').selectOption('daysLeft:asc');
    await settle(page);
    expect(page.url().includes('sort=daysLeft'), 'the select sorts');
    await table.scrollIntoViewIfNeeded();
    await shoot(page, 'reports-products-390-light', { fullPage: false });
  });

  await step('phone: custom range', async () => {
    await go('#/reports');
    await page.getByRole('button', { name: 'Custom range' }).click();
    const form = page.locator('.report-range');
    await form.waitFor();
    const box = await form.boundingBox();
    expect(box.x >= 0 && box.x + box.width <= 390, 'the date form fits the screen');
    await shoot(page, 'reports-range-390-light', { fullPage: false });
  });

  await step('phone: product page sales section', async () => {
    await go('#/items/5');
    const section = page.locator('[data-section="sales"]');
    await section.locator('.card').waitFor();
    await section.scrollIntoViewIfNeeded();
    await shoot(page, 'product-sales-390-light', { fullPage: false });
  });
}
