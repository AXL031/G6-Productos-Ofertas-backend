BEGIN;

CREATE TABLE catalog.outbox_delivery (
    message_id uuid NOT NULL REFERENCES catalog.outbox (message_id),
    destination text NOT NULL CHECK (destination IN (
        'g6.pricing.from.catalog', 'g6.inventory.from.catalog',
        'g6.promotions.from.catalog', 'g6.combos.from.catalog',
        'g6.taxonomy.from.catalog', 'g6.bulk.from.catalog'
    )),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    published_at timestamptz,
    last_error text,
    PRIMARY KEY (message_id, destination),
    CHECK (published_at IS NULL OR lease_token IS NULL)
);

CREATE INDEX ix_outbox_delivery_pending
    ON catalog.outbox_delivery (available_at, created_at, message_id, destination)
    WHERE published_at IS NULL;

CREATE FUNCTION catalog.enqueue_h5_outbox_deliveries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, catalog
AS $$
BEGIN
    IF current_setting('catalog.messaging_provider', true) IS DISTINCT FROM 'AZURE_SERVICE_BUS' THEN
        RETURN NEW;
    END IF;

    INSERT INTO catalog.outbox_delivery (message_id, destination)
    SELECT NEW.message_id, destination
    FROM (VALUES
        ('pricing.product.initialization.requested', 'g6.pricing.from.catalog'),
        ('inventory.sku.initialization.requested', 'g6.inventory.from.catalog'),
        ('catalog.product.deactivated', 'g6.promotions.from.catalog'),
        ('catalog.product.deactivated', 'g6.combos.from.catalog'),
        ('catalog.sku.deactivated', 'g6.inventory.from.catalog'),
        ('catalog.sku.deactivated', 'g6.pricing.from.catalog'),
        ('catalog.sku.deactivated', 'g6.promotions.from.catalog'),
        ('catalog.sku.deactivated', 'g6.combos.from.catalog'),
        ('catalog.master.deactivation.checked', 'g6.taxonomy.from.catalog'),
        ('catalog.bulk.upsert.completed', 'g6.bulk.from.catalog'),
        ('catalog.bulk.upsert.rejected', 'g6.bulk.from.catalog')
    ) AS routes(event_name, destination)
    WHERE routes.event_name = NEW.event_name
      AND routes.destination = ANY(
          string_to_array(
              COALESCE(current_setting('catalog.messaging_destinations', true), ''),
              ','
          )
      )
    ON CONFLICT (message_id, destination) DO NOTHING;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tr_catalog_outbox_h5_delivery
AFTER INSERT ON catalog.outbox
FOR EACH ROW EXECUTE FUNCTION catalog.enqueue_h5_outbox_deliveries();

REVOKE ALL ON catalog.outbox_delivery FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.enqueue_h5_outbox_deliveries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.enqueue_h5_outbox_deliveries() TO catalog_app;
GRANT SELECT, INSERT ON catalog.outbox_delivery TO catalog_app;
GRANT UPDATE (attempts, available_at, lease_token, published_at, last_error)
    ON catalog.outbox_delivery TO catalog_app;

COMMIT;
