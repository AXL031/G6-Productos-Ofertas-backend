-- Candidate migration for Inventory only.
-- Review and run against a disposable PostgreSQL instance before any deployment.
-- This file is never executed by application bootstrap and has not been applied
-- to the shared Supabase project.

BEGIN;

CREATE TABLE IF NOT EXISTS inventory.sku_lifecycle (
  sku_id text PRIMARY KEY,
  product_id uuid NOT NULL,
  sku_version integer NOT NULL CHECK (sku_version > 0),
  active boolean NOT NULL,
  changed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_sku_lifecycle_product
  ON inventory.sku_lifecycle(product_id);

CREATE TABLE IF NOT EXISTS inventory.offline_sale_reconciliations (
  client_id text NOT NULL,
  offline_sale_id text NOT NULL,
  operation_id uuid NOT NULL UNIQUE,
  order_id text NOT NULL,
  request_fingerprint text NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_payload jsonb NOT NULL
    CHECK (jsonb_typeof(request_payload) = 'object'),
  result_payload jsonb NOT NULL
    CHECK (jsonb_typeof(result_payload) = 'object'),
  status text NOT NULL CHECK (status IN ('COMPLETED', 'REQUIRES_REVIEW')),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (client_id, offline_sale_id)
);

COMMIT;
