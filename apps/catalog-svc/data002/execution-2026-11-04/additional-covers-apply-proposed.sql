-- PROPUESTA ADICIONAL INDEPENDIENTE: 4 portadas, NO EJECUTADA. Confirmar alcance antes de usar.
-- PROPUESTA PENDIENTE_APROBACION_MARCO. Ejecutar completa con ON_ERROR_STOP.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $data002$
DECLARE m record; before_state jsonb;
BEGIN
  IF current_user <> 'po_catalog_owner' OR NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname='catalog' AND pg_get_userbyid(nspowner)=current_user
  ) THEN RAISE EXCEPTION 'DATA002_REQUIRE_CATALOG_OWNER'; END IF;
  LOCK TABLE catalog.products,catalog.variants,catalog.sku_identity,catalog.product_images,
    catalog.variant_images,catalog.sku_physical_profiles,catalog.activation_checks IN SHARE ROW EXCLUSIVE MODE;
  before_state := (SELECT jsonb_build_object(
  'products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM catalog.products p),
  'variants',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM catalog.variants v),
  'sku_identity',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM catalog.sku_identity s),
  'profiles',(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM catalog.sku_physical_profiles f),
  'checks',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM catalog.activation_checks c)));
  FOR m IN SELECT * FROM (VALUES
  ('PUM-ULP-BASE', '08f2c67c-d79a-3e61-c7ee-0262885f68e7', '9ba54bda-2686-8e3b-41c6-68b6efa16338', 'e26d7736-b820-4e43-b92b-4f95cc773186', 'puma-ultra-play-negro.jpg', '3150f807-c196-4fc3-be05-f6bd4c6677de', '"3a9ba6ba7f775f7061d6cb703a3fc34f-1"', 'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/puma-ultra-play-negro.jpg'),
  ('ADI-ENT22-BASE', '32a4172c-81b2-b643-1d0f-ae66f627f2ef', '35133a17-114a-381e-090a-87446d5fc701', 'c9b5f3d3-542e-4c1b-bd87-e50a53aa0703', 'adidas-entrada22-azul.jpg', 'bf691787-7ad2-42e2-9af4-e75f9e0b34d6', '"1b1058af89e537cdc25b7e5392daf886"', 'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/adidas-entrada22-azul.jpg'),
  ('ADI-RF3-BASE', 'abaf9767-7431-9b50-495c-aeb880dc3055', 'f1bd0fad-819b-b0fd-b5b1-53bb36fd468f', '739bdf11-ce20-4f19-a49e-8fa09bda60f3', 'adidas-runfalcon3-gris.jpg', '3830bc41-91ed-4b55-ba3c-ce3a2f638440', '"b069348a3f481a1c15aa3db22b58c9c9-1"', 'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/adidas-runfalcon3-gris.jpg'),
  ('NIK-REV7-BASE', 'fedeecfb-c7f5-56cf-c31b-9cdf10b47058', '437853de-9b59-6b0b-5b26-ccd51e2e062b', 'aba3e97a-6575-4c13-81e7-fe35a2e14d0a', 'nike-revolution7-negro.jpg', 'adb98816-5445-49c7-8a60-093ff4b6dff2', '"632ef3c08b347454ee8361ad8178c153-1"', 'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/nike-revolution7-negro.jpg')
) AS m(sku, product_id, source_variant_id, source_image_id, file, storage_id, etag, url) LOOP
    IF NOT (EXISTS (SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id
    WHERE b.id='catalog-products' AND b.public AND o.name=m.file AND o.id=m.storage_id::uuid
      AND o.metadata->>'eTag'=m.etag AND (o.metadata->>'size')::bigint>0 AND o.metadata->>'mimetype' LIKE 'image/%') AND EXISTS (SELECT 1 FROM catalog.variant_images i JOIN catalog.variants v ON v.id=i.variant_id
    JOIN catalog.products p ON p.id=v.product_id WHERE i.id=m.source_image_id::uuid
    AND v.id=m.source_variant_id::uuid AND p.id=m.product_id::uuid AND p.sku_base=m.sku
    AND p.tiene_variantes AND i.url=m.url)) THEN RAISE EXCEPTION 'DATA002_COVER_SOURCE_CONFLICT: %',m.sku; END IF;
    IF NOT EXISTS (SELECT 1 FROM catalog.product_images WHERE product_id=m.product_id::uuid) THEN
      INSERT INTO catalog.product_images(product_id,url,principal,posicion) VALUES(m.product_id::uuid,m.url,true,0);
    ELSIF NOT EXISTS (SELECT 1 FROM catalog.product_images i JOIN storage.objects o
      ON i.url='https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/'||o.name AND o.bucket_id='catalog-products'
      WHERE i.product_id=m.product_id::uuid AND i.url=m.url AND (o.metadata->>'size')::bigint>0 AND o.metadata->>'mimetype' LIKE 'image/%') THEN
      RAISE EXCEPTION 'DATA002_EXISTING_COVER_UNVERIFIED: %',m.sku;
    END IF;
  END LOOP;
  IF before_state IS DISTINCT FROM (SELECT jsonb_build_object(
  'products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM catalog.products p),
  'variants',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM catalog.variants v),
  'sku_identity',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM catalog.sku_identity s),
  'profiles',(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM catalog.sku_physical_profiles f),
  'checks',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM catalog.activation_checks c))) THEN RAISE EXCEPTION 'DATA002_UNEXPECTED_MUTATION'; END IF;
END
$data002$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
