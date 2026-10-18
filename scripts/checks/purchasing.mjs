// Dashboard checks for the purchasing pages, run by ../check-dashboard.mjs.

/** Pages visited at every width and colour scheme: [screenshot name, hash]. */
export const PAGES = [
  ['purchasing', '#/purchasing'],
  ['purchasing-reorder', '#/purchasing?tab=reorder'],
  ['purchasing-suppliers', '#/purchasing?tab=suppliers'],
  ['purchasing-supplier', '#/purchasing?tab=suppliers&supplier=1'],
  ['purchase-order-new', '#/purchasing/orders/new'],
  ['purchase-order-draft', '#/purchasing/orders/7'],
  ['purchase-order-partial', '#/purchasing/orders/5'],
  ['purchase-order-received-cop', '#/purchasing/orders/4'],
];

const orderIdFromUrl = (url) => Number(/#\/purchasing\/orders\/(\d+)/.exec(url)?.[1]);

/**
 * Flows at 1280px. `ctx` = { page, go, step, expect, shoot, toastText, waitUntil, settle, server,
 * createMockState, setAllowHttpErrors } (see check-dashboard.mjs for each).
 */
export async function flows(ctx) {
  const { page, go, step, expect, shoot, toastText, waitUntil, settle, server } = ctx;
  let createdId = null;

  await step(
    'purchase order: refuses to save without a supplier or with a bad quantity',
    async () => {
      await go('#/purchasing/orders/new');
      await page.getByRole('button', { name: 'Save draft' }).click();
      const error = page.locator('.form-error-large');
      await error.waitFor();
      expect((await error.textContent()).includes('Choose the supplier.'), 'supplier required');
      expect(
        await page.getByRole('button', { name: 'Add products…' }).isDisabled(),
        'products can be added once a supplier is chosen',
      );
    },
  );

  await step('purchase order: create one with two lines from the item picker', async () => {
    await go('#/purchasing/orders/new');
    await page.getByLabel('Supplier', { exact: true }).selectOption({ label: 'Acme Textiles' });
    await page.getByRole('button', { name: 'Add products…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.picker-option').first().waitFor();
    await dialog.getByLabel('Search products').fill('HOOD-CLS-NAV');
    await page.waitForTimeout(400);
    await waitUntil(page, `!document.querySelector('.picker-results[aria-busy]')`);
    const options = dialog.locator('.picker-option:not(.is-disabled)');
    expect((await options.count()) >= 2, 'the search finds the navy hoodies');
    await options.nth(0).click();
    await options.nth(1).click();
    await shoot(page, 'dialog-po-picker-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Add to order' }).click();
    await dialog.waitFor({ state: 'detached' });
    const quantities = page.getByLabel(/^Quantity of /);
    expect((await quantities.count()) === 2, 'two lines added');
    await quantities.nth(0).fill('0');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.locator('.form-error-large', { hasText: 'at least 1' }).waitFor();
    await quantities.nth(0).fill('30');
    await quantities.nth(1).fill('20');
    await page
      .getByLabel(/^Unit cost of /)
      .nth(1)
      .fill('19.25');
    const total = await page.locator('.po-lines .table-totals').textContent();
    expect(total.includes('50') && total.includes('$940.00'), `totals update live (${total})`);
    await page.getByLabel('Notes').fill('Spring restock');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await waitUntil(page, `/#\\/purchasing\\/orders\\/\\d+$/.test(location.hash)`);
    await settle(page);
    createdId = orderIdFromUrl(page.url());
    expect((await toastText(page)).includes('Draft PO-0008 saved'), 'draft saved toast');
    expect((await page.locator('main h1').textContent()) === 'PO-0008', 'the new order opens');
    expect(
      (await page.locator('.page-title-row .badge').first().textContent()).includes('Draft'),
      'draft badge',
    );
  });

  await step('purchase order: mark as ordered, then receive part of it', async () => {
    await go(`#/purchasing/orders/${createdId}`);
    await page.getByRole('button', { name: 'Mark as ordered' }).click();
    await page.locator('.toast', { hasText: 'is marked as ordered' }).waitFor();
    await settle(page);
    await waitUntil(
      page,
      `document.querySelector('.page-title-row .badge')?.textContent === 'Ordered'`,
    );

    await page.getByRole('button', { name: 'Receive…' }).click();
    const dialog = page.getByRole('dialog');
    const rows = dialog.locator('.po-receive-line input');
    expect((await rows.nth(0).inputValue()) === '30', 'defaults to what is still to come');
    await rows.nth(0).fill('12');
    await rows.nth(1).fill('0');
    await dialog.getByLabel('Note').fill('Box 1 of 3');
    await shoot(page, 'dialog-po-receive-1280-light', { fullPage: false });
    // A double click must book the delivery once.
    await dialog.getByRole('button', { name: 'Receive units' }).dblclick();
    await dialog.waitFor({ state: 'detached' });
    expect((await toastText(page)).includes('Received 12 units on PO-0008'), 'receive toast');
    await settle(page);
    await waitUntil(
      page,
      `document.querySelector('.page-title-row .badge')?.textContent === 'Partly received'`,
    );
    const order = server.state.purchasing.orders.find((o) => o.id === createdId);
    expect(order.receipts.length === 1, `one delivery booked (${order.receipts.length})`);
    expect(order.lines[0].quantityReceived === 12, 'line received 12');
    expect((await page.locator('.po-receipt').count()) === 1, 'the delivery is listed');
  });

  await step('purchase order: a request sent twice books once (request id)', async () => {
    const result = await page.evaluate(`(async () => {
      const order = await (await fetch('/api/purchasing/orders/${createdId}')).json();
      const send = () => fetch('/api/purchasing/orders/${createdId}/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'store-sync' },
        body: JSON.stringify({
          requestId: '0f8b7c1e-3a2d-4c5b-9e6f-7a8b9c0d1e2f',
          lines: [{ lineId: order.lines[1].id, quantity: 2 }],
        }),
      });
      const [a, b] = await Promise.all([send(), send()]);
      const after = await (await fetch('/api/purchasing/orders/${createdId}')).json();
      return { statuses: [a.status, b.status].sort(), received: after.lines[1].quantityReceived,
               receipts: after.receipts.length };
    })()`);
    expect(
      result.statuses.join() === '200,201' && result.received === 2 && result.receipts === 2,
      `second copy is not booked again (${JSON.stringify(result)})`,
    );
  });

  await step(
    'purchase order: more than ordered asks first, then a delivery is undone',
    async () => {
      await go('#/purchasing/orders/5');
      await page.getByRole('button', { name: 'Receive…' }).click();
      const dialog = page.getByRole('dialog').first();
      const first = dialog.locator('.po-receive-line input').first();
      await first.fill('40'); // 24 still to come
      await dialog.getByRole('button', { name: 'Receive units' }).click();
      const confirm = page.getByRole('dialog', { name: 'Receive more than you ordered?' });
      await confirm.waitFor();
      await shoot(page, 'dialog-po-over-receipt-1280-light', { fullPage: false });
      await confirm.getByRole('button', { name: 'Receive them all' }).click();
      await page.locator('.toast', { hasText: 'Received 64 units on PO-0005' }).waitFor();
      await settle(page);
      await waitUntil(
        page,
        `[...document.querySelectorAll('.stat')].some((s) => s.textContent.includes('136 of 120'))`,
      );
      expect(
        (await page.locator('.stat', { hasText: 'Received' }).textContent()).includes('136 of 120'),
        'the over-delivery is counted',
      );

      const undo = page.getByRole('button', { name: /^Undo the delivery/ }).first();
      await undo.click();
      const sure = page.getByRole('dialog');
      await sure.getByRole('button', { name: 'Undo delivery' }).click();
      await sure.waitFor({ state: 'detached' });
      expect((await toastText(page)).includes('Delivery undone'), 'undo toast');
      await settle(page);
      expect(
        (await page.locator('.po-receipt.is-reversed').count()) === 2,
        'two undone deliveries',
      );
    },
  );

  await step('purchase order: close, print and download', async () => {
    await go('#/purchasing/orders/6');
    const csv = page.getByRole('link', { name: 'Download CSV' });
    expect(
      (await csv.getAttribute('href')) === '/api/purchasing/orders/6.csv',
      'CSV link points at the order',
    );
    const text = await page.evaluate(`fetch('/api/purchasing/orders/6.csv').then((r) => r.text())`);
    expect(text.startsWith('Order,Supplier,Status'), 'CSV has a header row');
    await page.emulateMedia({ media: 'print' });
    await shoot(page, 'purchase-order-print', { fullPage: true });
    expect(
      !(await page.getByRole('button', { name: 'Receive…' }).isVisible()),
      'print hides the actions',
    );
    await page.emulateMedia({ media: 'screen' });
    await page.getByRole('button', { name: 'Close…' }).click();
    const dialog = page.getByRole('dialog');
    expect(
      (await dialog.textContent()).includes('80 units not delivered yet are no longer expected'),
      'close explains what changes',
    );
    await dialog.getByRole('button', { name: 'Close order' }).click();
    await dialog.waitFor({ state: 'detached' });
    await settle(page);
    await waitUntil(
      page,
      `document.querySelector('.page-title-row .badge')?.textContent === 'Closed'`,
    );
  });

  await step('orders: filter by status and search', async () => {
    await go('#/purchasing');
    await page.getByRole('button', { name: /^Received/ }).click();
    await settle(page);
    const badges = await page.locator('.po-orders-table tbody .badge').allTextContents();
    expect(badges.length > 0 && badges.every((b) => b === 'Received'), `only received (${badges})`);
    expect(page.url().includes('status=received'), 'status kept in the address');
    await page.getByRole('button', { name: /^All/ }).click();
    await page.getByLabel('Search orders').fill('SOCK-MER');
    await page.waitForTimeout(400);
    await settle(page);
    const numbers = await page.locator('.po-orders-table tbody .product-link').allTextContents();
    expect(numbers.join() === 'PO-0004', `SKU search finds the order (${numbers})`);
  });

  await step('reorder: tick products and create a draft order', async () => {
    await go('#/purchasing?tab=reorder');
    const first = page.locator('.po-reorder-table tbody tr').first();
    const sku = await first.locator('.mono').first().textContent();
    const qty = first.getByLabel(`Units of ${sku} to order`);
    await qty.fill('36');
    await first.getByLabel(`Select ${sku}`).check();
    await page.locator('.po-selection').waitFor();
    await shoot(page, 'purchasing-reorder-selected-1280-light', { fullPage: false });
    await page.getByRole('button', { name: 'Create a draft order' }).click();
    await waitUntil(page, `/#\\/purchasing\\/orders\\/\\d+$/.test(location.hash)`);
    await settle(page);
    expect((await toastText(page)).includes('Draft order created'), 'draft created toast');
    const line = page.locator('.po-lines tbody tr').first();
    expect((await line.textContent()).includes(sku), `the draft has ${sku}`);
    expect(
      (await line.getByLabel(/^Quantity of /).inputValue()) === '36',
      'with the typed quantity',
    );
  });

  await step('reorder: “Order” opens a new order filled in, a supplier is chosen', async () => {
    await go('#/purchasing?tab=reorder');
    const row = page.locator('.po-reorder-table tbody tr', { hasText: 'JKT-RAIN' }).first();
    await row.getByRole('button', { name: /^Choose a supplier for/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Supplier').selectOption({ label: 'Capital Caps Co.' });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });
    expect(
      (await toastText(page)).includes('is now ordered from Capital Caps Co.'),
      'supplier toast',
    );
    await settle(page);
    const order = page
      .locator('.po-reorder-table tbody tr')
      .first()
      .getByRole('link', { name: /^Order / });
    const href = await order.getAttribute('href');
    expect(/supplierId=\d+&items=\d+:\d+$/.test(href), `order link carries the prefill (${href})`);
    await order.click();
    await waitUntil(
      page,
      `document.querySelector('main h1')?.textContent === 'New purchase order'`,
    );
    await settle(page);
    expect(
      (await page.locator('main h1').textContent()) === 'New purchase order',
      'new order page',
    );
    expect((await page.getByLabel(/^Quantity of /).count()) === 1, 'one line prefilled');
  });

  await step('suppliers: add one (with validation) and a product it sells', async () => {
    await go('#/purchasing?tab=suppliers');
    await page.getByRole('button', { name: 'Add supplier' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Linen House');
    await dialog.getByLabel('Currency').fill('EU');
    await dialog.getByRole('button', { name: 'Add supplier' }).click();
    await dialog.locator('.form-error', { hasText: '3-letter currency code' }).waitFor();
    await dialog.getByLabel('Currency').fill('eur');
    await dialog.getByLabel(/^Lead time/).fill('12');
    await dialog.getByRole('button', { name: 'Add supplier' }).click();
    await dialog.waitFor({ state: 'detached' });
    expect((await toastText(page)).includes('Linen House added'), 'supplier added toast');
    await settle(page);
    expect(page.url().includes('supplier=5'), 'its page opens');
    await page.getByRole('button', { name: 'Add product…' }).click();
    await dialog.locator('.picker-option').first().waitFor();
    await dialog.locator('.picker-option:not(.is-disabled)').first().click();
    await dialog.getByLabel(/^Price/).fill('3,75');
    await dialog.getByLabel('Pack size').fill('10');
    await shoot(page, 'dialog-supplier-item-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Add product' }).click();
    await dialog.waitFor({ state: 'detached' });
    await settle(page);
    const item = server.state.purchasing.supplierItems.find((si) => si.supplierId === 5);
    expect(
      item?.unitCost === 3.75 && item.packSize === 10,
      `price and pack saved (${JSON.stringify(item)})`,
    );
    expect(
      server.state.purchasing.suppliers.find((s) => s.id === 5)?.currencyCode === 'EUR',
      'currency upper-cased',
    );
  });

  await step('product page: purchasing section and reorder settings', async () => {
    await go('#/items/4');
    const section = page.locator('[data-section="purchasing"]');
    await section.getByRole('heading', { name: 'Purchasing' }).waitFor();
    expect((await section.textContent()).includes('Acme Textiles'), 'shows the supplier');
    await section.getByRole('button', { name: 'Reorder settings…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Lead time/).fill('400');
    await dialog.getByRole('button', { name: 'Save' }).click();
    expect(
      await dialog.getByLabel(/^Lead time/).evaluate((el) => !el.validity.valid),
      'a lead time over 365 days is refused by the form',
    );
    await dialog.getByLabel(/^Lead time/).fill('9');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });
    await waitUntil(
      page,
      `document.querySelector('[data-section="purchasing"]')?.textContent.includes('9 days (this product)')`,
    );
  });

  await step('activity: deliveries link to their order', async () => {
    await go('#/activity?kind=po_received');
    const link = page.locator('.timeline-title a').first();
    expect(/^PO-\d{4}$/.test(await link.textContent()), 'the title names the order');
    expect(/^#\/purchasing\/orders\/\d+$/.test(await link.getAttribute('href')), 'and links to it');
  });

  await step('reorder: empty states without sales and when nothing needs ordering', async () => {
    server.state.purchasing.noSales = true;
    for (const item of server.state.items) if (item.quantity !== null) item.quantity = 5000;
    await go('#/purchasing?tab=reorder');
    expect(
      (await page.locator('.banner-title').first().textContent()) === 'No sales recorded yet',
      'no-sales banner',
    );
    await page.getByText('Nothing needs reordering').waitFor();
    await shoot(page, 'purchasing-reorder-empty-1280-light', { fullPage: false });
  });
}

/** Flows at 390px (phone), same `ctx`. */
export async function phoneFlows(ctx) {
  const { page, go, step, expect, shoot, settle } = ctx;

  await step('phone: purchase order page and its dialogs fit', async () => {
    await go('#/purchasing/orders/5');
    await shoot(page, 'purchase-order-phone-390-light');
    await page.getByRole('button', { name: 'Receive…' }).click();
    const dialog = page.getByRole('dialog');
    await shoot(page, 'dialog-po-receive-390-light', { fullPage: false });
    const box = await dialog.boundingBox();
    expect(box.x >= 0 && box.x + box.width <= 390, 'receive dialog within the viewport');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    const overflow = await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    expect(overflow <= 0, `no sideways scrolling (${overflow}px)`);
  });

  await step('phone: new order with the item picker', async () => {
    await go('#/purchasing/orders/new?supplierId=1');
    await page.getByRole('button', { name: 'Add products…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.picker-option').first().waitFor();
    await dialog.locator('.picker-option:not(.is-disabled)').first().click();
    await shoot(page, 'dialog-po-picker-390-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Add to order' }).click();
    await dialog.waitFor({ state: 'detached' });
    await settle(page);
    await shoot(page, 'purchase-order-new-phone-390-light');
    const overflow = await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    expect(overflow <= 0, `no sideways scrolling (${overflow}px)`);
  });

  await step('phone: reorder selection bar', async () => {
    await go('#/purchasing?tab=reorder');
    await page.locator('input[data-select]').first().check();
    await page.locator('.po-selection').waitFor();
    await shoot(page, 'purchasing-reorder-selected-390-light', { fullPage: false });
  });
}
