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
  ('ADI-ENT22-AZU-M', 'c9b5f3d3-542e-4c1b-bd87-e50a53aa0703', '35133a17-114a-381e-090a-87446d5fc701', '32a4172c-81b2-b643-1d0f-ae66f627f2ef', 'https://placehold.co/800x800/png?text=Imagen+referencial', 'adidas-entrada22-azul.jpg', 'bf691787-7ad2-42e2-9af4-e75f9e0b34d6', '"1b1058af89e537cdc25b7e5392daf886"', 'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/adidas-entrada22-azul.jpg'),
  ('ADI-RF3-GRI-38', 'bdf64a75-0ee8-4fd2-aeae-e85e27c67cae', '532ffc0d-d209-2b48-6506-e94f62026e17', 'abaf9767-7431-9b50-495c-aeb880dc3055', 'https://placehold.co/800x800/png?text=Imagen+referencial', 'adidas-runfalcon3-gris.jpg', '3830bc41-91ed-4b55-ba3c-ce3a2f638440', '"b069348a3f481a1c15aa3db22b58c9c9-1"', 'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/adidas-runfalcon3-gris.jpg'),
  ('ADI-RF3-GRI-39', '739bdf11-ce20-4f19-a49e-8fa09bda60f3', 'f1bd0fad-819b-b0fd-b5b1-53bb36fd468f', 'abaf9767-7431-9b50-495c-aeb880dc3055', 'https://placehold.co/800x800/png?text=Imagen+referencial', 'adidas-runfalcon3-gris.jpg', '3830bc41-91ed-4b55-ba3c-ce3a2f638440', '"b069348a3f481a1c15aa3db22b58c9c9-1"', 'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/adidas-runfalcon3-gris.jpg'),
  ('NIK-REV7-NEG-41', 'e807b012-00ba-4d17-a4e5-f47546cd8980', '9df1c63b-f475-5ea4-fab4-cf2bb36120ae', 'fedeecfb-c7f5-56cf-c31b-9cdf10b47058', 'https://placehold.co/800x800/png?text=Imagen+referencial', 'nike-revolution7-negro.jpg', 'adb98816-5445-49c7-8a60-093ff4b6dff2', '"632ef3c08b347454ee8361ad8178c153-1"', 'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/nike-revolution7-negro.jpg'),
  ('NIK-REV7-NEG-42', 'aba3e97a-6575-4c13-81e7-fe35a2e14d0a', '437853de-9b59-6b0b-5b26-ccd51e2e062b', 'fedeecfb-c7f5-56cf-c31b-9cdf10b47058', 'https://placehold.co/800x800/png?text=Imagen+referencial', 'nike-revolution7-negro.jpg', 'adb98816-5445-49c7-8a60-093ff4b6dff2', '"632ef3c08b347454ee8361ad8178c153-1"', 'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/nike-revolution7-negro.jpg'),
  ('PUM-ULP-NEG-42', 'e26d7736-b820-4e43-b92b-4f95cc773186', '9ba54bda-2686-8e3b-41c6-68b6efa16338', '08f2c67c-d79a-3e61-c7ee-0262885f68e7', 'https://placehold.co/800x800/png?text=Imagen+referencial', 'puma-ultra-play-negro.jpg', '3150f807-c196-4fc3-be05-f6bd4c6677de', '"3a9ba6ba7f775f7061d6cb703a3fc34f-1"', 'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/puma-ultra-play-negro.jpg')
) AS m(sku, image_id, variant_id, product_id, old_url, file, storage_id, etag, url) LOOP
    IF NOT (EXISTS (SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id
    WHERE b.id='catalog-products' AND b.public AND o.name=m.file AND o.id=m.storage_id::uuid
      AND o.metadata->>'eTag'=m.etag AND (o.metadata->>'size')::bigint>0 AND o.metadata->>'mimetype' LIKE 'image/%') AND EXISTS (SELECT 1 FROM catalog.variant_images i JOIN catalog.variants v ON v.id=i.variant_id
    JOIN catalog.products p ON p.id=v.product_id JOIN catalog.sku_identity s ON s.variant_id=v.id
    WHERE i.id=m.image_id::uuid AND v.id=m.variant_id::uuid AND p.id=m.product_id::uuid
      AND v.sku=m.sku AND s.sku=m.sku AND p.tiene_variantes AND i.url IN (m.old_url,m.url))) THEN RAISE EXCEPTION 'DATA002_IMAGE_CONFLICT: %',m.sku; END IF;
    UPDATE catalog.variant_images SET url=m.url WHERE id=m.image_id::uuid AND url=m.old_url;
    IF NOT EXISTS (SELECT 1 FROM catalog.variant_images WHERE id=m.image_id::uuid AND url=m.url)
      THEN RAISE EXCEPTION 'DATA002_IMAGE_POSTCHECK: %',m.sku; END IF;
  END LOOP;
  IF NOT (EXISTS (SELECT 1 FROM catalog.products p JOIN catalog.sku_identity s ON s.product_id=p.id
    WHERE p.id='abab3400-46eb-58f7-78d5-8204418b60d9'::uuid AND p.sku_base='NIK-PITCH-05' AND s.sku=p.sku_base AND NOT p.tiene_variantes)
    AND EXISTS (SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id
      WHERE b.id='catalog-products' AND b.public AND o.id='650391e4-4e23-44bd-9dfd-e8ea48f5bdef'::uuid
      AND o.name='nike-pitch-talla.jpg' AND o.metadata->>'eTag'='"7c04b3ebc27c18ef756f097718f0d675-1"'
      AND (o.metadata->>'size')::bigint>0 AND o.metadata->>'mimetype' LIKE 'image/%')
    AND (NOT EXISTS (SELECT 1 FROM catalog.product_images WHERE product_id='abab3400-46eb-58f7-78d5-8204418b60d9'::uuid)
      OR (SELECT count(*)=1 AND bool_and(url='https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/nike-pitch-talla.jpg' AND principal AND posicion=0)
          FROM catalog.product_images WHERE product_id='abab3400-46eb-58f7-78d5-8204418b60d9'::uuid))) THEN RAISE EXCEPTION 'DATA002_PITCH_CONFLICT'; END IF;
  INSERT INTO catalog.product_images(product_id,url,principal,posicion)
    SELECT 'abab3400-46eb-58f7-78d5-8204418b60d9'::uuid,'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/nike-pitch-talla.jpg',true,0
    WHERE NOT EXISTS (SELECT 1 FROM catalog.product_images WHERE product_id='abab3400-46eb-58f7-78d5-8204418b60d9'::uuid);
  IF NOT (EXISTS (SELECT 1 FROM catalog.products p JOIN catalog.sku_identity s ON s.product_id=p.id
    WHERE p.id='abab3400-46eb-58f7-78d5-8204418b60d9'::uuid AND p.sku_base='NIK-PITCH-05' AND s.sku=p.sku_base AND NOT p.tiene_variantes)
    AND EXISTS (SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id
      WHERE b.id='catalog-products' AND b.public AND o.id='650391e4-4e23-44bd-9dfd-e8ea48f5bdef'::uuid
      AND o.name='nike-pitch-talla.jpg' AND o.metadata->>'eTag'='"7c04b3ebc27c18ef756f097718f0d675-1"'
      AND (o.metadata->>'size')::bigint>0 AND o.metadata->>'mimetype' LIKE 'image/%')
    AND (NOT EXISTS (SELECT 1 FROM catalog.product_images WHERE product_id='abab3400-46eb-58f7-78d5-8204418b60d9'::uuid)
      OR (SELECT count(*)=1 AND bool_and(url='https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/nike-pitch-talla.jpg' AND principal AND posicion=0)
          FROM catalog.product_images WHERE product_id='abab3400-46eb-58f7-78d5-8204418b60d9'::uuid))) OR NOT EXISTS (SELECT 1 FROM catalog.product_images
    WHERE product_id='abab3400-46eb-58f7-78d5-8204418b60d9'::uuid AND url='https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/nike-pitch-talla.jpg' AND principal AND posicion=0)
    THEN RAISE EXCEPTION 'DATA002_PITCH_POSTCHECK'; END IF;
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
