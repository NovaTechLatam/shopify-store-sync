/** Background tasks of the prices feature. */
export type PricingTaskPayloads = {
  /** Write the target prices of one price run to one store (dedupeKey `apply_prices:<run>:<store>`). */
  apply_prices: { runId: number; storeId: number };
};
