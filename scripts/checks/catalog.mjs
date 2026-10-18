// Dashboard checks for the catalog pages, run by ../check-dashboard.mjs.

/** Pages visited at every width and colour scheme: [screenshot name, hash]. */
export const PAGES = [
  ['catalog', '#/catalog'],
  ['catalog-new', '#/catalog/new'],
  ['catalog-product', '#/catalog/1'],
  ['catalog-product-failed', '#/catalog/2'],
  ['catalog-product-prices', '#/catalog/4'],
];

// A real 1×1 PNG, as a browser uploads it.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const OVERFLOW = `document.documentElement.scrollWidth - document.documentElement.clientWidth`;

/** Fills an option's values, one per line (Tab commits the change, like leaving the field). */
async function addOption(page, values) {
  await page.getByRole('button', { name: 'Add option' }).click();
  const field = page.locator('[data-option-values]').last();
  await field.fill(values);
  await field.press('Tab');
}

/**
 * Flows at 1280px. `ctx` = { page, go, step, expect, shoot, toastText, waitUntil, settle, server,
 * createMockState, setAllowHttpErrors } (see check-dashboard.mjs for each).
 */
export async function flows(ctx) {
  const { page, go, step, expect, shoot, toastText, waitUntil, settle, setAllowHttpErrors } = ctx;

  await step('catalog: list shows each brand’s state; search and status filter', async () => {
    await go('#/catalog');
    const badges = await page.locator('.brand-states .badge').allTextContents();
    for (const label of ['Published', 'Changes not published', 'Failed', 'Prices to update']) {
      expect(badges.includes(label), `catalog list shows a “${label}” brand`);
    }
    await page.getByLabel('Search the catalog').fill('socks');
    await page.waitForTimeout(400);
    await settle(page);
    const titles = await page.locator('.catalog-table .product-link').allTextContents();
    expect(
      titles.length === 1 && titles[0] === 'Merino socks',
      `search finds the socks (${titles})`,
    );
    expect(page.url().includes('search=socks'), 'search is kept in the address');
    await page.getByLabel('Search the catalog').fill('');
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Draft' }).click();
    await settle(page);
    const drafts = await page.locator('.catalog-table .product-link').allTextContents();
    expect(drafts.join() === 'Waxed cap', `draft filter (${drafts})`);
  });

  await step('catalog: create a product with two options and an image', async () => {
    await go('#/catalog/new');
    await page.getByLabel('Title').first().fill('Field jacket');
    await addOption(page, 'S\nM');
    await addOption(page, 'Olive\nNavy');
    const skus = page.locator('[data-field=sku]');
    expect((await skus.count()) === 4, `four variants from 2 × 2 values (${await skus.count()})`);
    const rows = await page.locator('.variant-grid tbody th').allTextContents();
    expect(rows.join('|') === 'S / Olive|S / Navy|M / Olive|M / Navy', `variant names (${rows})`);
    for (let i = 0; i < 4; i++) {
      await skus.nth(i).fill(`JKT-FLD-${i + 1}`);
      await page.locator('[data-field=basePrice]').nth(i).fill('149');
    }
    await page.locator('input[type=file]').first().setInputFiles({
      name: 'front.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await page.locator('.image-row').first().waitFor();
    await page.getByLabel('Alt text').first().fill('Field jacket, front');
    await shoot(page, 'catalog-new-filled-1280-light');
    await page.getByRole('button', { name: 'Create product' }).click();
    await waitUntil(page, `/#\\/catalog\\/\\d+$/.test(location.hash)`);
    await settle(page);
    expect((await toastText(page)).includes('Product created'), 'create toast');
    expect(
      (await page.locator('main h1').textContent()) === 'Field jacket',
      'the new product’s page opens',
    );
    expect((await page.locator('.image-row img').count()) === 1, 'the image was saved');
  });

  await step('catalog: option values keep their commas', async () => {
    await go('#/catalog/new');
    await page.getByLabel('Title').first().fill('Enamel mug');
    await addOption(page, 'Red, matte\nRed, glossy');
    const rows = await page.locator('.variant-grid tbody th').allTextContents();
    expect(rows.join('|') === 'Red, matte|Red, glossy', `one variant per line (${rows})`);
    // Leaving the box again keeps them as they are.
    const box = page.locator('[data-option-values]').last();
    await box.focus();
    await box.press('Tab');
    expect(
      (await box.inputValue()) === 'Red, matte\nRed, glossy',
      `the values read back one per line (${JSON.stringify(await box.inputValue())})`,
    );
    // Leave the page, so the next step's new product starts empty.
    await go('#/catalog');
  });

  await step('catalog: SKU mistakes are refused with a message', async () => {
    await go('#/catalog/new');
    await page.getByLabel('Title').first().fill('Duplicate test');
    await addOption(page, 'S\nM');
    await page.locator('[data-field=sku]').nth(0).fill('DUP-1');
    await page.locator('[data-field=sku]').nth(1).fill('dup-1');
    await page.getByRole('button', { name: 'Create product' }).click();
    const error = page.locator('.form-error');
    await error.waitFor();
    expect(
      (await error.textContent()).includes('SKU dup-1 is used twice'),
      'duplicate SKUs are refused before saving',
    );
    await shoot(page, 'catalog-new-error-1280-light', { fullPage: false });
    // A SKU of another catalog product: the server says which.
    setAllowHttpErrors(true);
    await page.locator('[data-field=sku]').nth(1).fill('SHIRT-LIN-WHI-S');
    await page.getByRole('button', { name: 'Create product' }).click();
    await waitUntil(
      page,
      `document.querySelector('.form-error')?.textContent.includes('Linen shirt')`,
    );
    expect(
      (await error.textContent()).includes('already in “Linen shirt” in the catalog'),
      'a SKU of another product is refused',
    );
    setAllowHttpErrors(false);
  });

  await step('catalog: the description preview never runs what it’s given', async () => {
    await go('#/catalog/new');
    await page
      .getByLabel('Description')
      .first()
      .fill(
        '<p>Hello <strong>bold</strong></p><script>window.__ran = 1</script>' +
          '<img src="x" onerror="window.__ran = 2"><a href="javascript:alert(1)">bad</a>' +
          '<a href="https://example.com/care">care guide</a><h1>Big</h1>',
      );
    const preview = page.locator('.html-preview');
    expect((await preview.locator('strong').textContent()) === 'bold', 'bold text is shown');
    expect((await preview.locator('script, img, h1').count()) === 0, 'no script, image or h1');
    expect(
      (await preview.locator('a').first().getAttribute('href')) === null,
      'a javascript: link loses its address',
    );
    expect(
      (await preview.locator('a').last().getAttribute('href')) === 'https://example.com/care',
      'a web link keeps its address',
    );
    expect((await page.evaluate('window.__ran')) === undefined, 'nothing from the description ran');
  });

  await step('catalog: publish preview says what each brand gets', async () => {
    await go('#/catalog/4');
    await page.getByRole('button', { name: 'Publish…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const text = await dialog.textContent();
    expect(text.includes('Deletes 1 variant in Harbor & Pine'), 'variant deletion is spelled out');
    expect(text.includes('Not sold in Little Fox Kids'), 'a brand that doesn’t sell it is skipped');
    expect(
      (await dialog.getByLabel('Publish to Little Fox Kids').isDisabled()) === true,
      'a skipped brand can’t be ticked',
    );
    await shoot(page, 'dialog-catalog-publish-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Publish' }).click();
    await dialog.waitFor({ state: 'detached' });
    expect((await toastText(page)).includes('Publishing to'), 'publishing toast');
    await waitUntil(
      page,
      `[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Published to'))`,
      15_000,
    );
    await settle(page);
  });

  await step('catalog: import a product from a store', async () => {
    await go('#/catalog');
    await page.getByRole('button', { name: 'Import from a store…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.picker-option').first().waitFor();
    await dialog.getByLabel('Search its products').fill('Hoodie');
    await page.waitForTimeout(400);
    await waitUntil(page, `!document.querySelector('.picker-results[aria-busy]')`);
    const options = await dialog.locator('.picker-option .strong').allTextContents();
    expect(
      options.length === 1 && options[0] === 'Classic Hoodie',
      `search finds the hoodie (${options})`,
    );
    await dialog.locator('.picker-option').first().click();
    await shoot(page, 'dialog-catalog-import-1280-light', { fullPage: false });
    await dialog.getByRole('button', { name: 'Import' }).click();
    await dialog.waitFor({ state: 'detached' });
    await waitUntil(page, `/#\\/catalog\\/\\d+$/.test(location.hash)`);
    await settle(page);
    expect((await toastText(page)).includes('is in the catalog'), 'import toast');
    expect(
      (await page.locator('main h1').textContent()) === 'Classic Hoodie',
      'imported page opens',
    );
    expect(
      (await page.locator('.brand-panel').first().textContent()).includes(
        'publishing leaves the product shown or hidden in the Online Store as it is',
      ),
      'an imported brand’s Online Store is left as it is',
    );
    // Already imported products can't be picked again.
    await go('#/catalog');
    await page.getByRole('button', { name: 'Import from a store…' }).click();
    await dialog.getByLabel('Search its products').fill('Hoodie');
    await page.waitForTimeout(400);
    await waitUntil(page, `!document.querySelector('.picker-results[aria-busy]')`);
    expect(
      (await dialog.locator('.picker-option input').first().isDisabled()) === true,
      'an imported product is shown as already in the catalog',
    );
    await page.keyboard.press('Escape');
  });

  await step('catalog: the product page says whether an item is in the catalog', async () => {
    await go('#/items/5');
    const section = page.locator('[data-section=catalog]');
    await section.locator('.card').waitFor();
    expect(
      (await section.textContent()).includes('In the catalog as Organic Tee'),
      'catalog section of a catalog item',
    );
    // CAP-WAX-OLI-S: only the M of the cap is in the catalog.
    await go('#/items/16');
    await section.locator('.card').waitFor();
    expect((await section.textContent()).includes('Not in the catalog'), 'item not in the catalog');
    expect(
      (await section.getByRole('button', { name: 'Import…' }).count()) === 1,
      'it can be imported from there',
    );
  });

  await step('catalog: images can be reordered with buttons', async () => {
    await go('#/catalog/1');
    const shared = page
      .locator('section.card')
      .filter({ has: page.locator('h2', { hasText: 'Shared images' }) });
    const alts = () =>
      shared.locator('.image-row input.input').evaluateAll((els) => els.map((e) => e.value));
    const before = await alts();
    await shared.getByRole('button', { name: 'Move image 1 down' }).click();
    const after = await alts();
    expect(after[0] === before[1] && after[1] === before[0], `images swapped (${after})`);
    expect(
      (await page.locator('.save-bar.is-dirty').count()) === 1,
      'a reorder is an unsaved change',
    );
  });
}

/** Flows at 390px (phone), same `ctx`. */
export async function phoneFlows(ctx) {
  const { page, go, step, expect, shoot } = ctx;
  await step('phone: the product editor fits, variants as cards', async () => {
    await go('#/catalog/1');
    const overflow = await page.evaluate(OVERFLOW);
    expect(overflow <= 0, `editor scrolls sideways by ${overflow}px`);
    await shoot(page, 'catalog-product-editor-390-light');
    const box = await page.locator('.variant-grid tbody tr').first().boundingBox();
    expect(box && box.width <= 390, 'a variant card fits the screen');
  });
  await step('phone: the publish dialog fits', async () => {
    await go('#/catalog/2');
    await page.getByRole('button', { name: 'Publish…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await shoot(page, 'dialog-catalog-publish-390-light', { fullPage: false });
    const box = await dialog.boundingBox();
    expect(box.x >= 0 && box.x + box.width <= 390, 'dialog within the viewport');
    await page.keyboard.press('Escape');
  });
  await step('phone: a new product with options', async () => {
    await go('#/catalog/new');
    await page.getByLabel('Title').first().fill('Rib beanie');
    await page.getByRole('button', { name: 'Add option' }).click();
    const values = page.locator('[data-option-values]').last();
    await values.fill('Black\nGrey\nCream');
    await values.press('Tab');
    expect((await page.locator('[data-field=sku]').count()) === 3, 'three variants');
    const overflow = await page.evaluate(OVERFLOW);
    expect(overflow <= 0, `new product page scrolls sideways by ${overflow}px`);
    await shoot(page, 'catalog-new-options-390-light');
  });
}
