-- Candidata para el H5 de Service Bus Basic; nunca se aplica automáticamente en bootstrap de Nest.
-- Aplicar con po_inventory_owner solo en una base autorizada.
DO $guard$
BEGIN
  IF current_user <> 'po_inventory_owner' OR NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'inventory' AND pg_get_userbyid(nspowner) = current_user
  ) THEN RAISE EXCEPTION 'Ejecutar migracion candidata H5 como po_inventory_owner sobre el esquema inventory'; END IF;
END;
$guard$;

CREATE TABLE inventory.outbox_delivery (
  message_id uuid NOT NULL,
  destination text NOT NULL,
  route_version integer NOT NULL DEFAULT 1,
  transport text NOT NULL DEFAULT 'AZURE_SERVICE_BUS',
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  last_error text,
  CONSTRAINT pk_inventory_outbox_delivery PRIMARY KEY (message_id, destination),
  CONSTRAINT fk_inventory_delivery_outbox FOREIGN KEY (message_id) REFERENCES inventory.outbox(event_id) ON DELETE RESTRICT,
  CONSTRAINT ck_inventory_delivery_route CHECK (
    route_version = 1 AND
    transport = 'AZURE_SERVICE_BUS' AND
    destination IN (
      'g6.catalog.from.inventory',
      'g6.combos.from.inventory',
      'g6.promotions.from.inventory'
    )
  ),
  CONSTRAINT ck_inventory_delivery_attempts CHECK (attempts >= 0),
  CONSTRAINT ck_inventory_delivery_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);

CREATE INDEX ix_inventory_delivery_pending
  ON inventory.outbox_delivery (next_attempt_at, created_at)
  WHERE sent_at IS NULL;

REVOKE ALL ON inventory.outbox_delivery FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON inventory.outbox_delivery TO inventory_app;
