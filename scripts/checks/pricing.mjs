// Dashboard checks for the prices page, run by ../check-dashboard.mjs.

/** Pages visited at every width and colour scheme: [screenshot name, hash]. */
export const PAGES = [
  ['prices', '#/prices'],
  ['prices-changes', '#/prices?filter=changes'],
  ['prices-rules', '#/prices?tab=rules'],
  ['prices-sales', '#/prices?tab=sales'],
  ['prices-history', '#/prices?tab=history'],
];

/** A datetime-local value `days` from now (the browser's time zone is the machine's). */
function localInput(days) {
  const d = new Date(Date.now() + days * 86_400_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const item = (server, sku) => server.state.items.find((i) => i.sku === sku);

/**
 * Waits for a toast containing `text` (older toasts may still be on screen, so the newest isn't
 * always the one to read).
 */
async function expectToast(ctx, text, message) {
  try {
    await ctx.waitUntil(
      ctx.page,
      `[...document.querySelectorAll('.toast-message')].some((t) => t.textContent.includes(${JSON.stringify(text)}))`,
      5000,
    );
  } catch {
    ctx.expect(false, `${message} (toast: ${await ctx.toastText(ctx.page).catch(() => 'none')})`);
  }
}

/** Searches the product picker of the open dialog and ticks the first product found. */
async function pickProduct(ctx, search) {
  const dialog = ctx.page.getByRole('dialog');
  await dialog.getByLabel('Find products').fill(search);
  // The search is debounced: wait for its results, not the list that was there before.
  await ctx.waitUntil(
    ctx.page,
    `(() => {
      const first = document.querySelector('dialog .picker-option .mono');
      return !document.querySelector('.picker-results[aria-busy]') && !!first &&
        first.textContent.includes(${JSON.stringify(search)});
    })()`,
  );
  await dialog.locator('.picker-option').first().click();
}

/**
 * Flows at 1280px. `ctx` = { page, go, step, expect, shoot, toastText, waitUntil, settle, server,
 * createMockState, setAllowHttpErrors } (see check-dashboard.mjs for each).
 */
export async function flows(ctx) {
  const { page, go, step, expect, shoot, waitUntil, settle, server } = ctx;
  const dialog = page.getByRole('dialog');

  await step('prices: edit a base price and save it', async () => {
    await go('#/prices?search=CAP-WAX-OLI-L');
    const field = page.getByLabel('Base price of CAP-WAX-OLI-L');
    await field.fill('21.5');
    await page.locator('.price-save-bar').waitFor();
    expect(
      (await page.locator('.price-save-bar').textContent()).includes('1 base price not saved yet'),
      'the save bar counts unsaved base prices',
    );
    await shoot(page, 'prices-unsaved-1280-light', { fullPage: false });
    await page.getByRole('button', { name: 'Save base prices' }).click();
    await page.locator('.price-save-bar').waitFor({ state: 'hidden' });
    await expectToast(ctx, '1 base price saved', 'save toast');
    expect(item(server, 'CAP-WAX-OLI-L').basePrice === 21.5, 'base price saved in the mock');
    await settle(page);
    expect((await field.inputValue()) === '21.5', 'the list shows the saved price');
  });

  await step('prices: a negative base price is refused before saving', async () => {
    await go('#/prices?search=CAP-WAX-OLI-S');
    await page.getByLabel('Base price of CAP-WAX-OLI-S').fill('-3');
    expect(
      await page.getByRole('button', { name: 'Save base prices' }).isDisabled(),
      'save is disabled',
    );
    expect(
      (await page.locator('.price-save-bar').textContent()).includes('Enter a price of 0 or more'),
      'the save bar says why',
    );
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await page.locator('.price-save-bar').waitFor({ state: 'hidden' });
  });

  await step('prices: change several base prices by a percentage', async () => {
    await go('#/prices?search=TOTE');
    await page.getByLabel('Select every product on this page').check();
    await page.getByRole('button', { name: 'Change 3 prices…' }).click();
    await dialog.getByLabel('Percentage', { exact: true }).fill('10');
    await waitUntil(
      page,
      `document.querySelector('dialog .preview-line').textContent.includes('$17.59')`,
    );
    await shoot(page, 'dialog-prices-bulk-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Apply change' }).click();
    await dialog.waitFor({ state: 'detached' });
    await expectToast(ctx, '3 base prices changed', 'bulk toast');
    expect(item(server, 'TOTE-CNV-NAT-M').basePrice === 17.59, '15.99 + 10% = 17.59');
  });

  await step('prices: removing prices, or losing compare-at prices, asks first', async () => {
    await go('#/prices?search=TOTE');
    await page.getByLabel('Select every product on this page').check();
    await page.getByRole('button', { name: 'Change 3 prices…' }).click();
    const bulk = page.getByRole('dialog').first();
    // +20% puts the totes (17.59) above their compare-at price (19.99).
    await bulk.getByLabel('Percentage', { exact: true }).fill('20');
    await bulk.getByRole('button', { name: 'Apply change' }).click();
    const confirm = page.getByRole('dialog', { name: 'Change 3 base prices?' });
    await confirm.waitFor();
    expect(
      (await confirm.textContent()).includes(
        '3 products will have a compare-at price no higher than the base price',
      ),
      'it counts the compare-at prices that go',
    );
    await shoot(page, 'dialog-prices-bulk-compare-at-1280-light', { fullPage: false });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await bulk.locator('.form-error', { hasText: 'Nothing was changed.' }).waitFor();
    // An empty "Set to an amount" removes the base prices: named, with the count.
    await bulk.getByText('Set to an amount').click();
    await bulk.getByLabel(/^New amount/).fill('');
    await bulk.getByRole('button', { name: 'Apply change' }).click();
    const remove = page.getByRole('dialog', { name: 'Remove the base price of 3 products?' });
    await remove.waitFor();
    expect(
      (await remove.getByRole('button', { name: 'Remove 3 base prices' }).count()) === 1,
      'the button says what it removes',
    );
    await remove.getByRole('button', { name: 'Cancel' }).click();
    await page.keyboard.press('Escape');
    await bulk.waitFor({ state: 'detached' });
    expect(item(server, 'TOTE-CNV-NAT-M').basePrice === 17.59, 'nothing changed');
  });

  await step(
    'prices: a change to “the products in this list” keeps to the store shown',
    async () => {
      // Fixed prices in Little Fox Kids only: one sock (Northwind's hoodies have some too).
      await go('#/prices?filter=overrides&storeId=3');
      await page.getByRole('button', { name: 'Change prices…' }).click();
      expect(
        (await dialog.textContent()).includes('Applies to the 1 product in this list'),
        'the dialog counts the products listed',
      );
      await dialog.getByLabel('Percentage', { exact: true }).fill('10');
      await dialog.getByRole('button', { name: 'Apply change' }).click();
      await dialog.waitFor({ state: 'detached' });
      await expectToast(ctx, '1 base price changed', 'bulk toast for the listed product');
      expect(
        item(server, 'HOOD-CLS-NAV-L').basePrice === 59.99,
        'products not listed are untouched',
      );
    },
  );

  await step('prices: a fixed price for one store, with validation', async () => {
    await go('#/prices?search=TEE-ORG-WHI-S');
    await page
      .getByRole('button', { name: 'Fixed price for TEE-ORG-WHI-S in Harbor & Pine…' })
      .click();
    await dialog.getByLabel('Price (COP)', { exact: true }).fill('120000');
    await dialog.getByLabel('Compare-at price (COP)').fill('100000');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.locator('.form-error').waitFor();
    expect(
      (await dialog.locator('.form-error').textContent()).includes('must be higher than the price'),
      'compare-at not above the price is refused inline',
    );
    await dialog.getByLabel('Compare-at price (COP)').fill('');
    await shoot(page, 'dialog-prices-fixed-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });
    await expectToast(ctx, 'Fixed price saved', 'fixed price toast');
    await settle(page);
    expect(
      (await page.locator('tbody tr').first().textContent()).includes('Fixed price'),
      'the cell says it is a fixed price',
    );
  });

  await step(
    'prices: removing a fixed price where the rule is off keeps the store’s price',
    async () => {
      await go('#/prices?search=SOCK-MER-GRE-S');
      await page
        .getByRole('button', { name: 'Fixed price for SOCK-MER-GRE-S in Little Fox Kids…' })
        .click();
      await dialog.getByRole('button', { name: 'Remove fixed price…' }).click();
      await dialog
        .getByRole('heading', { name: 'Remove the fixed price of SOCK-MER-GRE-S?' })
        .waitFor();
      const text = await dialog.textContent();
      expect(
        text.includes('keeps the price it has in Shopify') && !text.includes('its rule gives'),
        `no rule price is promised where the rule is off (${text})`,
      );
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    },
  );

  await step('prices: edit a rule and see the examples follow', async () => {
    await go('#/prices?tab=rules');
    const harbor = page.locator('.rule-card').filter({ hasText: 'Harbor & Pine' });
    const before = await harbor.locator('.rule-examples').textContent();
    await harbor.getByLabel('Multiply by').fill('1.5');
    const after = await harbor.locator('.rule-examples').textContent();
    expect(before !== after, 'examples change while typing');
    expect(after.includes('122,900'), `$19.99 × 4,100 × 1.5 ends in 900 (${after})`);
    await harbor.getByLabel('Ending (COP)').fill('1000');
    await harbor.getByRole('button', { name: 'Save rule' }).click();
    expect(
      (await harbor.locator('.field-error').textContent()).includes(
        'must be smaller than the step',
      ),
      'an ending not below the step is refused',
    );
    await harbor.getByLabel('Ending (COP)').fill('900');
    await shoot(page, 'prices-rule-edit-1280-light', { fullPage: false });
    await harbor.getByRole('button', { name: 'Save rule' }).click();
    await expectToast(ctx, 'Rule saved for Harbor & Pine', 'rule toast');
    expect(server.state.pricing.rules[2].multiplier === 1.5, 'rule saved in the mock');
  });

  await step('prices: update the stores, with a confirmation and progress', async () => {
    await go('#/prices');
    await page.getByRole('button', { name: 'Update prices in stores…' }).click();
    await dialog.locator('.update-store').first().waitFor();
    expect(
      (await dialog.textContent()).includes('drop by 20% or more'),
      'big drops are pointed out',
    );
    expect(
      await dialog.getByRole('checkbox', { name: /Little Fox Kids/ }).isDisabled(),
      'a store that can’t be updated can’t be chosen',
    );
    await shoot(page, 'dialog-prices-update-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Update prices' }).click();
    await dialog.waitFor({ state: 'detached' });
    await expectToast(ctx, 'Updating prices in 2 stores', 'update toast');
    await waitUntil(
      page,
      `document.querySelector('.price-progress .banner-title')?.textContent === 'Prices updated'`,
    );
    await settle(page);
    await shoot(page, 'prices-updated-1280-light', { fullPage: false });
    await page.getByRole('button', { name: 'Prices to update' }).click();
    await settle(page);
    expect(
      (await page.locator('.state-title').textContent()) === 'Every store already has its price',
      'nothing left to change',
    );
  });

  await step('prices: schedule a sale, with validation', async () => {
    await go('#/prices?tab=sales');
    await page.getByRole('button', { name: 'New sale…' }).click();
    await dialog.getByLabel('Name').fill('Spring sale');
    await dialog.getByLabel('Starts').fill(localInput(10));
    await dialog.getByLabel('Ends').fill(localInput(9));
    await dialog.getByLabel('Percent off').fill('15');
    await pickProduct(ctx, 'SOCK-MER-GRE');
    await dialog.getByRole('button', { name: 'Schedule sale' }).click();
    await dialog.locator('.form-error').waitFor();
    expect(
      (await dialog.locator('.form-error').textContent()).includes('must end after it starts'),
      'end before start is refused',
    );
    await dialog.getByLabel('Ends').fill(localInput(12));
    // The browser's own check stops a percentage above 99 before anything is sent.
    await dialog.getByLabel('Percent off').fill('120');
    expect(
      await dialog.getByLabel('Percent off').evaluate((el) => !el.checkValidity()),
      'a percentage above 99 is refused',
    );
    await dialog.getByLabel('Percent off').fill('15');
    await shoot(page, 'dialog-prices-sale-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Schedule sale' }).click();
    await dialog.waitFor({ state: 'detached' });
    await expectToast(ctx, 'Sale “Spring sale” scheduled', 'sale toast');
    await settle(page);
    expect((await page.locator('tbody').textContent()).includes('Spring sale'), 'sale listed');
  });

  await step('prices: the sale picker says when it lists only some products', async () => {
    await go('#/prices?tab=sales');
    await page.getByRole('button', { name: 'New sale…' }).click();
    const more = dialog.locator('.picker-more');
    await more.locator('p').waitFor();
    const text = await more.textContent();
    const total = Number(/of (\d+)/.exec(text)?.[1]);
    expect(
      text.startsWith('Showing 20 of') && total > 20,
      `the list says how many it leaves out (${text})`,
    );
    await more.getByRole('button', { name: `Tick all ${total}` }).click();
    await waitUntil(
      page,
      `(document.querySelector('dialog .chosen-products .field-label')?.textContent ?? '').includes('${total}')`,
    );
    expect(
      (await dialog.locator('.picker-option input:checked').count()) === 20,
      'every listed product is ticked too',
    );
    await shoot(page, 'dialog-prices-sale-all-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
  });

  await step('prices: an overlapping sale is refused; a planned one can be cancelled', async () => {
    await go('#/prices?tab=sales');
    ctx.setAllowHttpErrors(true);
    await page.getByRole('button', { name: 'Edit “Black Friday”' }).click();
    await dialog.getByLabel('Starts').fill(localInput(10.5));
    await dialog.getByLabel('Ends').fill(localInput(11));
    await pickProduct(ctx, 'SOCK-MER-GRE');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await waitUntil(page, `!!document.querySelector('dialog .form-error:not([hidden])')`);
    expect(
      (await dialog.locator('.form-error').textContent()).includes('overlaps “Spring sale”'),
      'the overlapping sale is named',
    );
    ctx.setAllowHttpErrors(false);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Cancel “Black Friday”…' }).click();
    await shoot(page, 'dialog-prices-cancel-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Cancel sale' }).click();
    await dialog.waitFor({ state: 'detached' });
    await expectToast(ctx, 'is cancelled', 'cancel toast');
    await settle(page);
    const row = page.locator('tbody tr').filter({ hasText: 'Black Friday' });
    expect((await row.textContent()).includes('Cancelled'), 'cancelled badge');
  });

  await step('prices: end a running sale now', async () => {
    await go('#/prices?tab=sales');
    await page.getByRole('button', { name: 'End now “Autumn hoodie weekend”…' }).click();
    await dialog.getByRole('button', { name: 'End sale now' }).click();
    await dialog.waitFor({ state: 'detached' });
    await expectToast(ctx, '“Autumn hoodie weekend” ended', 'end toast');
    await waitUntil(page, `!!document.querySelector('.price-progress .banner')`);
    expect(
      !server.state.pricing.overrides.some((o) => o.scheduleId === 1),
      'the sale’s fixed prices are gone',
    );
    await settle(page);
  });

  await step('prices: schedule a base price change', async () => {
    await go('#/prices?tab=sales');
    await page.getByRole('button', { name: 'New price change…' }).click();
    await dialog.getByLabel('Name').fill('Autumn prices');
    await dialog.getByLabel('On', { exact: true }).fill(localInput(20));
    await pickProduct(ctx, 'TOTE-CNV-NAT-S');
    await dialog.getByLabel('New base price of TOTE-CNV-NAT-S').fill('18.5');
    await shoot(page, 'dialog-prices-base-change-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Schedule price change' }).click();
    await dialog.waitFor({ state: 'detached' });
    await expectToast(ctx, 'Price change “Autumn prices” scheduled', 'price change toast');
    const s = server.state.pricing.schedules.find((x) => x.name === 'Autumn prices');
    expect(s?.changes[0]?.basePrice === 18.5, 'the new base price is kept');
  });

  await step('prices: the history shows what Shopify refused', async () => {
    await go('#/prices?tab=history');
    await page.getByText('What Shopify refused (2)').click();
    expect(
      (await page.locator('.refusals[open]').textContent()).includes('JKT-RAIN-YEL-M'),
      'refused SKUs shown',
    );
  });

  await step('prices: the product page shows each store’s price', async () => {
    await go('#/items/5');
    const section = page.locator('[data-section="pricing"]');
    await section.locator('.card').waitFor();
    expect((await section.textContent()).includes('Harbor & Pine'), 'store prices listed');
    await shoot(page, 'product-prices-1280-light');
  });
}

/** Flows at 390px (phone), same `ctx`. */
export async function phoneFlows(ctx) {
  const { page, go, step, expect, shoot } = ctx;
  const dialog = page.getByRole('dialog');
  const fits = async (name) => {
    await dialog.waitFor();
    const box = await dialog.boundingBox();
    expect(box.x >= 0 && box.x + box.width <= 390, `${name}: dialog within the viewport`);
  };

  await step('phone: price list, change dialog and fixed price dialog fit', async () => {
    await go('#/prices?search=HOOD-CLS-NAV');
    await shoot(page, 'prices-hoodies-390-light');
    await page.getByRole('button', { name: 'Change prices…' }).click();
    await shoot(page, 'dialog-prices-bulk-390-light', { fullPage: false });
    await fits('change prices');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page
      .getByRole('button', { name: 'Fixed price for HOOD-CLS-NAV-L in Northwind Apparel…' })
      .click();
    await shoot(page, 'dialog-prices-fixed-390-light', { fullPage: false });
    await fits('fixed price');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  });

  await step('phone: update and price change dialogs fit', async () => {
    await go('#/prices');
    await page.getByRole('button', { name: 'Update prices in stores…' }).click();
    await dialog.locator('.update-store').first().waitFor();
    await shoot(page, 'dialog-prices-update-390-light', { fullPage: false });
    await fits('update prices');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await go('#/prices?tab=sales');
    await page.getByRole('button', { name: 'New price change…' }).click();
    await pickProduct(ctx, 'TEE-ORG-BLA');
    await dialog.locator('.chosen-item').first().scrollIntoViewIfNeeded();
    await shoot(page, 'dialog-prices-base-change-390-light', { fullPage: false });
    await fits('price change');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  });
}
