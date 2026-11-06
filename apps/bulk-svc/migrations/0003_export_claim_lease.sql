-- Additive Bulk-owned export claim and lease metadata.
ALTER TABLE bulk.export_jobs
    ADD COLUMN IF NOT EXISTS claim_token uuid,
    ADD COLUMN IF NOT EXISTS lease_until timestamptz;
