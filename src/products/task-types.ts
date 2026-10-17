/** Background tasks of the catalog feature (master products published to the brand stores). */
export type CatalogTaskPayloads = {
  /** Create or update a master product in one store (Shopify productSet). */
  publish_product: { masterProductId: number; storeId: number };
};
