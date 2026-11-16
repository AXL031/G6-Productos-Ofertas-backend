-- Candidate for the isolated H5 pilot; never applied by application bootstrap.
-- Apply as po_pricing_owner only to an explicitly authorized database.
DO $guard$
BEGIN
  IF current_user <> 'po_pricing_owner' OR NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'pricing' AND pg_get_userbyid(nspowner) = current_user
  ) THEN RAISE EXCEPTION 'Run H5 migration as po_pricing_owner on pricing'; END IF;
END;
$guard$;
CREATE TABLE pricing.outbox_delivery (
  message_id uuid NOT NULL,
  destination text NOT NULL,
  route_version integer NOT NULL,
  transport text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  last_error text,
  CONSTRAINT pk_outbox_delivery PRIMARY KEY (message_id, destination),
  CONSTRAINT fk_delivery_outbox FOREIGN KEY (message_id) REFERENCES pricing.outbox(message_id) ON DELETE RESTRICT,
  CONSTRAINT ck_delivery_route CHECK (route_version = 1 AND destination = 'g6.price-audit.from.pricing' AND transport = 'AZURE_SERVICE_BUS'),
  CONSTRAINT ck_delivery_attempts CHECK (attempts >= 0),
  CONSTRAINT ck_delivery_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX ix_delivery_pending ON pricing.outbox_delivery(next_attempt_at, created_at) WHERE sent_at IS NULL;
REVOKE ALL ON pricing.outbox_delivery FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pricing.outbox_delivery TO pricing_app;
