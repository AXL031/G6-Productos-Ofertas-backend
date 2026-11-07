-- Índice aditivo para el replay; aplicación separada por el owner de esquema.
CREATE INDEX IF NOT EXISTS ix_inbox_initialization_operation
  ON pricing.inbox (lower(payload->>'operation_id'), created_at, id)
  WHERE handler = 'pricing.product.initialization.v1'
    AND result <> 'OPERATION_ID_CONFLICT';
