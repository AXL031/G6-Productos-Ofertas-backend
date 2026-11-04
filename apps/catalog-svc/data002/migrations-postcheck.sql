-- Solo lectura: estructura, historial desconocido y permisos; no registra versiones.
SELECT version,checksum,applied_at FROM catalog.schema_migrations ORDER BY version;
SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
WHERE table_schema='catalog' AND (table_name='sku_barcodes' OR column_name='publicado_alguna_vez');
SELECT tgname,pg_get_triggerdef(oid) FROM pg_trigger
WHERE tgrelid IN ('catalog.products'::regclass,to_regclass('catalog.sku_barcodes')) AND NOT tgisinternal;
SELECT has_table_privilege('catalog_app','catalog.sku_barcodes','SELECT') AS can_read,
  has_table_privilege('catalog_app','catalog.sku_barcodes','DELETE') AS can_delete,
  has_column_privilege('catalog_app','catalog.sku_barcodes','codigo_barras','UPDATE') AS can_change_code;
SELECT publicado_alguna_vez,count(*) FROM catalog.products GROUP BY publicado_alguna_vez;
SELECT count(*) AS barcodes FROM catalog.sku_barcodes;
