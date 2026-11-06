-- DATA-002: ocho asociaciones y dos atributos Pitch, autorización explícita adicional del usuario.
-- Solo INSERT; no normaliza los doce JSON null previos. IDs externos validados por auditoría readonly.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $extra$
DECLARE m record; protected_before jsonb; identifying_before jsonb; attrs_before jsonb;
BEGIN
 IF current_user <> 'po_catalog_owner' OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='catalog' AND pg_get_userbyid(nspowner)=current_user)
 THEN RAISE EXCEPTION 'DATA002_REQUIRE_CATALOG_OWNER'; END IF;
 LOCK TABLE catalog.products,catalog.variants,catalog.sku_identity,catalog.product_images,catalog.variant_images,catalog.sku_physical_profiles,catalog.variant_attribute_values,catalog.activation_checks,catalog.master_barriers,catalog.outbox,catalog.inbox,catalog.product_identifying_characteristics,catalog.product_attribute_values IN SHARE ROW EXCLUSIVE MODE;
 protected_before := (SELECT jsonb_build_object('products',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.products t),'variants',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variants t),'sku_identity',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.sku_identity t),'product_images',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.product_images t),'variant_images',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variant_images t),'sku_physical_profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.sku_physical_profiles t),'variant_attribute_values',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variant_attribute_values t),'activation_checks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.activation_checks t),'master_barriers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.master_barriers t),'outbox',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.outbox t),'inbox',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.inbox t)));
 identifying_before := (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.product_identifying_characteristics t);
 attrs_before := (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.product_attribute_values t);
 FOR m IN SELECT * FROM (VALUES
('08f2c67c-d79a-3e61-c7ee-0262885f68e7','PUM-ULP-BASE','4d68c7e4-69d4-9e79-8e9e-379aa2a3a01a','fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'),
('08f2c67c-d79a-3e61-c7ee-0262885f68e7','PUM-ULP-BASE','4d68c7e4-69d4-9e79-8e9e-379aa2a3a01a','acee6db1-ba1c-f020-caf8-f439b09556ff'),
('32a4172c-81b2-b643-1d0f-ae66f627f2ef','ADI-ENT22-BASE','b023a151-d69f-ff9a-483a-678eefe6842e','fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'),
('32a4172c-81b2-b643-1d0f-ae66f627f2ef','ADI-ENT22-BASE','b023a151-d69f-ff9a-483a-678eefe6842e','acee6db1-ba1c-f020-caf8-f439b09556ff'),
('abaf9767-7431-9b50-495c-aeb880dc3055','ADI-RF3-BASE','457dbfec-c787-826f-7898-d231aeabb589','fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'),
('abaf9767-7431-9b50-495c-aeb880dc3055','ADI-RF3-BASE','457dbfec-c787-826f-7898-d231aeabb589','acee6db1-ba1c-f020-caf8-f439b09556ff'),
('fedeecfb-c7f5-56cf-c31b-9cdf10b47058','NIK-REV7-BASE','457dbfec-c787-826f-7898-d231aeabb589','fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'),
('fedeecfb-c7f5-56cf-c31b-9cdf10b47058','NIK-REV7-BASE','457dbfec-c787-826f-7898-d231aeabb589','acee6db1-ba1c-f020-caf8-f439b09556ff')
 ) AS m(product_id,sku,tipo_producto_id,caracteristica_id) LOOP
  IF NOT EXISTS(SELECT 1 FROM catalog.products p WHERE p.id=m.product_id::uuid AND p.sku_base=m.sku AND p.tipo_producto_id=m.tipo_producto_id AND p.tiene_variantes AND p.estado='BORRADOR')
   OR NOT EXISTS(SELECT 1 FROM catalog.variants v WHERE v.product_id=m.product_id::uuid)
   OR EXISTS(SELECT 1 FROM catalog.variants v WHERE v.product_id=m.product_id::uuid AND NOT EXISTS(
    SELECT 1 FROM catalog.variant_attribute_values a WHERE a.variant_id=v.id AND a.caracteristica_id=m.caracteristica_id AND a.es_identificador
     AND a.valor_id IS NOT NULL AND v.identifying_key->m.caracteristica_id=jsonb_build_object('valor_id',a.valor_id)))
  THEN RAISE EXCEPTION 'DATA002_IDENTIFYING_SOURCE_CONFLICT: %',m.sku; END IF;
  INSERT INTO catalog.product_identifying_characteristics(product_id,caracteristica_id)
   SELECT m.product_id::uuid,m.caracteristica_id WHERE NOT EXISTS(
    SELECT 1 FROM catalog.product_identifying_characteristics x WHERE x.product_id=m.product_id::uuid AND x.caracteristica_id=m.caracteristica_id);
  IF NOT EXISTS(SELECT 1 FROM catalog.product_identifying_characteristics x WHERE x.product_id=m.product_id::uuid AND x.caracteristica_id=m.caracteristica_id)
   THEN RAISE EXCEPTION 'DATA002_IDENTIFYING_POSTCHECK'; END IF;
 END LOOP;
 FOR m IN SELECT * FROM (VALUES
('abab3400-46eb-58f7-78d5-8204418b60d9','NIK-PITCH-05','fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd','Talla','52d4b91a-f829-c05e-d60e-31ada29b0513'),
('abab3400-46eb-58f7-78d5-8204418b60d9','NIK-PITCH-05','acee6db1-ba1c-f020-caf8-f439b09556ff','Color','c0b1a113-b479-5f84-9fa3-0e6cb3a41fea')
 ) AS m(product_id,sku,caracteristica_id,nombre_snapshot,valor_id) LOOP
  IF NOT EXISTS(SELECT 1 FROM catalog.products p JOIN catalog.sku_identity s ON s.product_id=p.id
   WHERE p.id=m.product_id::uuid AND p.sku_base=m.sku AND NOT p.tiene_variantes AND p.estado='BORRADOR' AND s.sku=m.sku)
   THEN RAISE EXCEPTION 'DATA002_PITCH_OWNER_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM catalog.product_attribute_values a WHERE a.product_id=m.product_id::uuid AND a.caracteristica_id=m.caracteristica_id)
   AND NOT EXISTS(SELECT 1 FROM catalog.product_attribute_values a WHERE a.product_id=m.product_id::uuid AND a.caracteristica_id=m.caracteristica_id
    AND a.valor_id=m.valor_id AND a.nombre_snapshot=m.nombre_snapshot AND a.valor='null'::jsonb)
   THEN RAISE EXCEPTION 'DATA002_PITCH_ATTRIBUTE_CONFLICT'; END IF;
  INSERT INTO catalog.product_attribute_values(product_id,caracteristica_id,nombre_snapshot,valor_id,valor)
   SELECT m.product_id::uuid,m.caracteristica_id,m.nombre_snapshot,m.valor_id,'null'::jsonb WHERE NOT EXISTS(
    SELECT 1 FROM catalog.product_attribute_values a WHERE a.product_id=m.product_id::uuid AND a.caracteristica_id=m.caracteristica_id);
  IF NOT EXISTS(SELECT 1 FROM catalog.product_attribute_values a WHERE a.product_id=m.product_id::uuid AND a.caracteristica_id=m.caracteristica_id
   AND a.valor_id=m.valor_id AND a.valor='null'::jsonb) THEN RAISE EXCEPTION 'DATA002_PITCH_ATTRIBUTE_POSTCHECK'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(identifying_before) old LEFT JOIN catalog.product_identifying_characteristics x ON x.id=(old->>'id')::uuid
  WHERE old IS DISTINCT FROM to_jsonb(x)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(attrs_before) old
  LEFT JOIN catalog.product_attribute_values x ON x.id=(old->>'id')::uuid WHERE old IS DISTINCT FROM to_jsonb(x))
  THEN RAISE EXCEPTION 'DATA002_EXISTING_ATTRIBUTE_MUTATION'; END IF;
 IF protected_before IS DISTINCT FROM (SELECT jsonb_build_object('products',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.products t),'variants',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variants t),'sku_identity',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.sku_identity t),'product_images',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.product_images t),'variant_images',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variant_images t),'sku_physical_profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.sku_physical_profiles t),'variant_attribute_values',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variant_attribute_values t),'activation_checks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.activation_checks t),'master_barriers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.master_barriers t),'outbox',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.outbox t),'inbox',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.inbox t))) THEN RAISE EXCEPTION 'DATA002_EXTRA_UNEXPECTED_MUTATION'; END IF;
END
$extra$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
