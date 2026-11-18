-- Taxonomy H5. No backfill and no changes to the H4 migrations.
DO $guard$
BEGIN
  IF current_user <> 'po_taxonomy_owner' OR NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'taxonomy' AND pg_get_userbyid(nspowner) = current_user
  ) THEN RAISE EXCEPTION 'Run H5 migration as po_taxonomy_owner on taxonomy'; END IF;
END;
$guard$;

ALTER TABLE taxonomy.outbox ADD COLUMN delivery_transport text NOT NULL DEFAULT 'RABBITMQ'
  CHECK (delivery_transport IN ('RABBITMQ', 'AZURE_SERVICE_BUS'));
ALTER TABLE taxonomy.outbox ALTER COLUMN delivery_transport SET DEFAULT
  COALESCE(NULLIF(current_setting('g6.taxonomy_messaging', true), ''), 'RABBITMQ');

CREATE TABLE taxonomy.outbox_delivery (
  message_id uuid NOT NULL REFERENCES taxonomy.outbox(message_id) ON DELETE RESTRICT,
  destination text NOT NULL CHECK (destination = 'g6.catalog.from.taxonomy'),
  route_version integer NOT NULL DEFAULT 1 CHECK (route_version = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  last_error text,
  PRIMARY KEY (message_id, destination),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX ix_taxonomy_delivery_pending ON taxonomy.outbox_delivery(next_attempt_at, created_at)
  WHERE sent_at IS NULL;

CREATE FUNCTION taxonomy.fn_enqueue_catalog_h5() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.event_name NOT IN (
    'taxonomy.category.updated', 'taxonomy.product-type-schema.changed',
    'taxonomy.characteristic-value.updated', 'taxonomy.master.deactivation.check.requested',
    'taxonomy.master.deactivated', 'taxonomy.master.deactivation.rejected'
  ) THEN RAISE EXCEPTION 'Unsupported Taxonomy H5 route'; END IF;
  INSERT INTO taxonomy.outbox_delivery (message_id, destination)
  VALUES (NEW.message_id, 'g6.catalog.from.taxonomy');
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_taxonomy_catalog_h5 AFTER INSERT ON taxonomy.outbox
FOR EACH ROW WHEN (NEW.delivery_transport = 'AZURE_SERVICE_BUS')
EXECUTE FUNCTION taxonomy.fn_enqueue_catalog_h5();
REVOKE ALL ON taxonomy.outbox_delivery FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON taxonomy.outbox_delivery TO taxonomy_app;
