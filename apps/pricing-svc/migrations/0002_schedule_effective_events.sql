-- Contexto causal para activar una programación después del commit original.
-- Los registros históricos permanecen legibles; los que no tengan contexto de
-- Catalog no se publican hasta que el owner los reconcilie de forma autorizada.
ALTER TABLE pricing.scheduled_prices
  ADD COLUMN IF NOT EXISTS product_id text,
  ADD COLUMN IF NOT EXISTS correlation_id uuid;
