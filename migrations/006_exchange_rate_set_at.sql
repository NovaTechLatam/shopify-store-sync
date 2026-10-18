-- When the merchant last saved a store's exchange rate. NULL: still the default 1, which is no
-- rate at all for a store in another currency (src/util/money.ts, exchangeRateUnset).
ALTER TABLE stores ADD COLUMN exchange_rate_set_at timestamptz;

-- A rate other than the default was entered on the store page before this column existed.
UPDATE stores SET exchange_rate_set_at = updated_at WHERE exchange_rate <> 1;
