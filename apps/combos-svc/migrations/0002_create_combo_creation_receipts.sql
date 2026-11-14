-- Candidata H4. Ejecutar como po_combos_owner en una migración transaccional.
CREATE TABLE combos.combo_creation_receipts (
    actor_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    fingerprint text NOT NULL,
    combo_id uuid NOT NULL REFERENCES combos.combos(id) ON DELETE CASCADE,
    PRIMARY KEY (actor_id, idempotency_key),
    CONSTRAINT ck_combo_creation_key CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT ck_combo_creation_fingerprint CHECK (fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX ix_combo_creation_receipts_combo ON combos.combo_creation_receipts(combo_id);
REVOKE ALL ON combos.combo_creation_receipts FROM PUBLIC;
-- El proceso de despliegue concede SELECT e INSERT al rol runtime autorizado.
