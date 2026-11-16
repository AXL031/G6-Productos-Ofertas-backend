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

REVOKE ALL ON catalog.outbox_delivery FROM PUBLIC;
GRANT SELECT, INSERT ON catalog.outbox_delivery TO catalog_app;
GRANT UPDATE (attempts, available_at, lease_token, published_at, last_error)
    ON catalog.outbox_delivery TO catalog_app;

COMMIT;
