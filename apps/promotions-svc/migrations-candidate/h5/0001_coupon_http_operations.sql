-- CANDIDATE H5; disposable databases only until model/rollout review.
-- Never executed by bootstrap. No historical migration is modified.
CREATE TABLE promotions.h5_coupon_operations (
  operation_id uuid PRIMARY KEY,
  message_id uuid NOT NULL UNIQUE,
  source_client_id text NOT NULL CHECK (source_client_id = 'modulo-ventas'),
  order_id text NOT NULL CHECK (length(btrim(order_id)) > 0),
  operation_type text NOT NULL CHECK (operation_type IN ('CONSUMIR_CUPON','RESTAURAR_CUPON')),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  command jsonb NOT NULL CHECK (jsonb_typeof(command) = 'object'),
  status text NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('ACCEPTED','COMPLETED','REJECTED')),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  result_payload jsonb,
  CHECK ((status='ACCEPTED' AND completed_at IS NULL AND result_payload IS NULL)
    OR (status IN ('COMPLETED','REJECTED') AND completed_at IS NOT NULL AND result_payload IS NOT NULL))
);
CREATE TABLE promotions.h5_coupon_outbox (
  message_id uuid PRIMARY KEY REFERENCES promotions.h5_coupon_operations(message_id),
  operation_id uuid NOT NULL UNIQUE REFERENCES promotions.h5_coupon_operations(operation_id),
  destination text NOT NULL CHECK (destination='g6.promotions.commands'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  last_error text CHECK (last_error IS NULL OR last_error IN ('SEND_NOT_CONFIRMED','MESSAGE_TOO_LARGE')),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX h5_coupon_outbox_pending ON promotions.h5_coupon_outbox(next_attempt_at,created_at) WHERE sent_at IS NULL;
REVOKE ALL ON promotions.h5_coupon_operations, promotions.h5_coupon_outbox FROM PUBLIC;
-- Owner/runtime roles, grants and model ledger require an explicit reviewed
-- deployment migration. No grant to anon/authenticated or runtime DDL here.
