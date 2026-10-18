# The catalog

The **Catalog** page is where you write a product once and publish it to every brand. Each brand
can have its own title, description, images, search engine listing and tags; the options, variants,
SKUs, barcodes and weights are the same everywhere, because they are what keeps the stock shared.

This page explains how it works and what to watch out for. The last part,
[Under the hood](#under-the-hood), is for developers.

## What a catalog product is

A catalog product has:

- **The default version**: title, description, vendor, product type, tags, status, web address
  (handle) and search engine listing. Every brand uses it unless you change something for that
  brand.
- **Options and variants**, shared by every brand: up to 3 options (like Size and Color), and one
  variant for each combination of values you sell. Each variant has its own **SKU**, which is how
  Store Sync knows that "Red / S" in one brand is the same thing as "Red / S" in another, and so
  shares its stock.
- **Prices and costs**, shared too: you enter a **base price** (in your base currency, see
  **Settings > Currency**), and each brand turns it into its own price with its exchange rate and
  price rule (see the **Prices** page). The base price and cost you type in the catalog are the
  same ones the Prices page shows.
- **Brands**: for each store, whether the product is sold there ("Sell in …"), what is different
  there, whether it shows in its Online Store, and images only that brand uses.
- **Images**: shared images (every brand) and each brand's own images. A brand shows its own images
  first, then the shared ones; its first image is its main image. An image can be tied to an
  option value ("Show for Color: Red"): the variants with that value show it.

## Creating a product

1. On **Catalog**, click **New product**.
2. Fill in the basics. The description takes simple HTML (paragraphs, bold, italics, lists, links
   and headings); the preview next to it shows how it reads.
3. Under **Options and variants**, add your options and their values, separated by commas
   (`S, M, L`). Store Sync makes one variant per combination. Give each a SKU and a base price. If
   you don't sell a combination, remove it; you can add it back later.
4. Add images, with a short description of each (alt text): screen readers read it aloud.
5. Under **Brands**, untick the brands that don't sell it, and change what you want for the others.
   An empty field uses the default ("Same as default").
6. Click **Create product**.

Nothing is sent to your stores yet. When you're ready, click **Publish…**.

### New SKUs start at 0

A SKU Store Sync didn't know before starts at **0** units, in every store, when the product is first
published. Add stock with a purchase order (**Purchasing**) or **Add or remove units** on its page in
**Products**. A SKU Store Sync already knew keeps its stock.

On **Products**, such a variant says **Not published in <brand> yet** for each brand that sells
the product, until you publish there. Once it was published, a variant deleted from that brand in
Shopify says **Missing in <brand>** and needs attention, like any other product.

## Publishing

**Publish…** shows, for each brand, what publishing will do there, before anything happens:

- **Creates the product**, or **updates** the one that's there.
- Which fields change (title, tags, status…), which variants are added, and which prices change.
- **What gets deleted**, in red: a brand's product becomes exactly what you see in the catalog, so
  variants and images it has that the catalog product doesn't are deleted from that store. Deleting
  a variant also deletes its stock in that store. Read this part before you publish.
- Why a brand **can't** be published to right now, and what to do about it.

Tick the brands to publish to and click **Publish**. Each brand is updated in the background; the
page shows **Waiting to publish**, **Publishing…**, then **Published** or **Failed** with the
reason. You can leave the page meanwhile.

After an edit, brands show **Changes not published** until you publish again. **Prices to update**
means the brand charges something else than its price rule says (a base price or a rule changed);
publishing, or **Update prices in stores** on the Prices page, fixes it.

### When a brand already has the product

If a brand already has a product with exactly the catalog product's SKUs (and no other variants),
publishing **updates that product** instead of creating a second one, and says so. If the SKUs are
in a product that has other variants too, or spread over several products, publishing refuses: a
SKU can only be in a store once, or its stock stops syncing. Import that product instead (below),
or fix the SKUs in Shopify first.

## Importing a product a store already sells

If your brands already sell a product, don't create it again: **import** it.

1. On **Catalog**, click **Import from a store…** (or **Import…** in the Catalog section of a
   product's page).
2. Choose the store and the product.
3. Click **Import**.

Store Sync copies the product's texts, options, variants, prices (where the base price isn't set
yet, converted with the store's exchange rate), costs and images. Then it looks for the same SKUs in
your other brands. Where one product has them, it is **linked**: its own title, description, tags
and images become that brand's version, so nothing is lost. Nothing changes in your stores.

Variants a linked brand has that the imported product doesn't are added to the catalog product, if
they fit its options. Anything that doesn't fit is listed at the top of the product's page after the
import: publishing to that brand would delete it.

Brands whose product is identical show as **Published** (the order of tags doesn't count: Shopify
keeps them as a set). Brands that differ (other variants, variants in another order, another
barcode…) show as **Changes not published**, and **Publish…** shows exactly what would change.

- **Online Store.** Store Sync doesn't read whether an imported product is shown in a brand's Online
  Store, so publishing leaves that as it is in Shopify until you change **Show in … Online Store**
  for that brand (or its status). A product you kept off the Online Store stays off it.
- **Unlisted products.** The catalog only has active, draft and archived products: an unlisted
  product becomes active, and the brand shows **Changes not published** ("Status: Unlisted →
  Active") because publishing lists it again.

Every variant needs its own SKU to be imported, and a product can have at most 250 variants.

## Changing and removing

- **Variants**: change options and values on the product's page. Renaming a value keeps its variant.
  Removing values or combinations asks first. A variant's SKU can't change once the product is in a
  store: remove the variant and add one with the new SKU.
- **Archiving**: set the status to **Archived** and publish. A brand that never had the product
  doesn't get an archived copy.
- **Not selling in a brand any more**: untick **Sell in …**. Store Sync stops updating the product
  there, but leaves it in the store as it is: archive or delete it in Shopify if you want it gone.
- **Remove from catalog** (at the bottom of the product's page) only removes it from Store Sync. Your
  stores keep the product, and its stock keeps syncing.

## What to watch out for

- **Edit catalog products in Store Sync, not in Shopify.** Publishing replaces each brand's product
  with the catalog version: a title or image changed directly in Shopify is overwritten, and an
  image or variant added in Shopify is deleted. The publish preview lists these before you confirm.
- **Prices.** A brand whose price rule is off keeps the prices it has when a product is updated; a
  new product (or a new variant) starts at the base price converted with the exchange rate.
- **One SKU, one product.** A SKU can only be in one catalog product, and only once in each store.
- **Web addresses.** A web address (handle) must be unique in each store. If a brand already uses
  it, publishing to that brand fails and says so: give the brand its own address.
- **Stock is never set by publishing**, except a brand-new variant, which starts at 0 and then
  follows the shared stock.

## Permissions

| Permission           | Needed for                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `write_products`     | Creating and updating products, uploading images. Without it the brand shows "Can’t publish" with the steps to add it (see [Setting up Shopify](setup-shopify.md#permissions-for-the-extra-features)). |
| `write_publications` | Showing products in the brand's **Online Store**. Without it the product is still published; Store Sync notes that you need to make it visible in Shopify yourself.                                    |

Importing only reads products, which every store already allows.

## Limitations

- At most 3 options and 250 variants per product.
- Images: JPEG, PNG, WebP or GIF, up to 20 MB and 20 megapixels.
- Collections, metafields, sales channels other than the Online Store, product categories and
  per-market prices aren't managed; Store Sync leaves them as they are.
- If a brand keeps an image's old description (alt text) after you change it and publish, remove
  the image, publish, and add it again.
- Videos and 3D models of a brand's product aren't shown in the publish preview, and publishing
  removes them: add them back in Shopify afterwards, or keep such products out of the catalog.
- An image Shopify couldn't process (a broken file or address) is sent again on the next publish.
- The description preview shows simple formatting only; the full HTML is sent to Shopify as you
  wrote it.

## Under the hood

- **Model.** `master_products`, `master_variants` (one per item/SKU; price and cost live on
  `items`), `master_product_stores` (a brand's overlay: NULL = the master's value; publish state,
  hash and snapshot of the last publish), `master_media` + `master_media_links` (our image → its
  Shopify media in each store), `media_files` (uploads, by sha256). See
  `migrations/002_catalog_pricing_sales_purchasing.sql` and `003_catalog_publish_snapshot.sql`.
- **Publishing** is the `publish_product` task (`src/products/publish.ts`). It reads the brand's
  product from Shopify first and builds a full `productSet` input from it
  (`src/products/plan.ts`): variants matched by SKU are sent with their ids (never recreated: a new
  variant would get a new inventory item), images already there by media id, so the plan knows
  exactly what Shopify will delete; the preview uses the same code. `inventoryQuantities` (0 at the
  synced locations) are only sent for variants being created. After the write every returned
  variant is linked at once (`refreshInventoryItem`), so stock syncing starts without waiting for
  the next catalog read.
- **Retries.** `productSet` has no idempotency key. Updates go by product id with absolute values.
  Creates first look for a product of the store holding exactly our SKUs (our copy of its catalog,
  then Shopify), and otherwise upsert by a custom id (`$app:store_sync.master_product_id` metafield,
  defined once per store), so a create retried after a timeout finds the product it made. A SKU in
  another product of the store blocks the publish.
- **"Changed"** is computed, not stored: the sha256 of the brand's content (everything but prices
  and costs, with our own ids, stable key order, tags sorted) against the hash stored at the last
  publish, and,
  separately, the brand's current prices (`variants.price`) against what a publish would send.
  Prices and costs are left out of the hash because rules, exchange rates and average costs change
  on their own.
- **Failures** a merchant must fix (permissions, a paused store, SKU conflicts, what Shopify
  refuses) end the task with `failed`, the reason, and an alert (`catalog_publish_failed`). Network
  and Shopify outages are retried; the brand shows "waiting to retry". A missing permission never
  marks the store itself as being in error.
- **Uploads** are checked by their first bytes (the declared type is ignored), kept once per
  content, served with `nosniff`, and deleted a day after nothing uses them.
- **Description preview** (`renderSimpleHtml`, `public/js/views/catalog-shared.js`): parsed into an
  inert document, rebuilt from an allow-list of tags with no attributes but an http(s) link address.
  Never `innerHTML`.
