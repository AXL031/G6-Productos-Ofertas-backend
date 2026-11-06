-- Additive Bulk-owned migration. Apply only through the reviewed service migration process.
ALTER TABLE bulk.file_manifests
    ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN bulk.file_manifests.metadata IS
    'Export provenance: export identity, requested_at and observed source versions.';
