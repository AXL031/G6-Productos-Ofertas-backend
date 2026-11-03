-- Solo lectura. No aplicar DDL ni cambiar ledger desde este archivo.
SELECT current_database(),current_user,version();
SELECT version,checksum,applied_at FROM catalog.schema_migrations ORDER BY version;
SELECT nspname,pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='catalog';
SELECT rolname,rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('po_catalog_owner','catalog_app');
SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
WHERE table_schema='catalog' AND (table_name='sku_barcodes' OR column_name='publicado_alguna_vez');
SELECT tgname,pg_get_triggerdef(oid) FROM pg_trigger
WHERE tgrelid='catalog.products'::regclass AND NOT tgisinternal;
SELECT proname,pg_get_functiondef(oid) FROM pg_proc
WHERE pronamespace='catalog'::regnamespace AND proname IN ('guard_product_publication_history','guard_sku_barcode','fn_assert_product');
