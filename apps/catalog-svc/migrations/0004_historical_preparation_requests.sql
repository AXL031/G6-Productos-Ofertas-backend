-- CONTRATO_CANDIDATO / propuesta aditiva para revisión del owner.
-- Aplicar solo mediante el proceso autorizado; nunca desde bootstrap.
-- No aplicada en Supabase compartida. Pruebas: PostgreSQL descartable.
DO $$ BEGIN
  IF current_user <> 'po_catalog_owner' THEN
    RAISE EXCEPTION 'Catalog migration requires po_catalog_owner' USING ERRCODE = '42501';
  END IF;
END $$;
CREATE TABLE catalog.historical_preparation_requests (
  request_id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  actor_subject uuid NOT NULL,
  correlation_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  selection jsonb NOT NULL CHECK (jsonb_typeof(selection) = 'object'),
  response_payload jsonb NOT NULL CHECK (jsonb_typeof(response_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_historical_preparation_requests_product
  ON catalog.historical_preparation_requests(product_id);
ALTER TABLE catalog.historical_preparation_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON catalog.historical_preparation_requests FROM PUBLIC;
GRANT SELECT, INSERT ON catalog.historical_preparation_requests TO catalog_app;
CREATE POLICY historical_preparation_runtime
  ON catalog.historical_preparation_requests TO catalog_app
  USING (true) WITH CHECK (true);
COMMENT ON TABLE catalog.historical_preparation_requests IS
  'Recibo inmutable de admisión histórica; no representa preparación COMPLETED ni publica mensajes por sí mismo.';
