-- Consultas solo lectura DATA-002
select count(*) products from catalog.products; select count(*) variants from catalog.variants; select count(*) sku_identity from catalog.sku_identity; select count(*) product_images from catalog.product_images; select count(*) variant_images from catalog.variant_images;
select p.id,p.nombre,p.sku_base,p.slug,p.tiene_variantes,p.estado,v.id,v.sku,si.product_id,si.variant_id from catalog.products p left join catalog.variants v on v.product_id=p.id left join catalog.sku_identity si on si.product_id=p.id or si.variant_id=v.id order by p.nombre,v.sku;
select id,sku,product_id,variant_id from catalog.sku_identity order by sku;
select id,nombre,estado from taxonomy.brands where estado='ACTIVO'; select id,nombre,estado from taxonomy.product_types where estado='ACTIVO'; select id,nombre,categoria_padre_id,estado from taxonomy.categories where estado='ACTIVO';
select c.nombre,cv.id,cv.nombre from taxonomy.characteristics c join taxonomy.characteristic_values cv on cv.caracteristica_id=c.id where c.estado='ACTIVO' and cv.estado='ACTIVO';
select pt.nombre,c.nombre,ptc.obligatoria,ptc.estado from taxonomy.product_type_characteristics ptc join taxonomy.product_types pt on pt.id=ptc.tipo_producto_id join taxonomy.characteristics c on c.id=ptc.caracteristica_id;
select name,mime_type,metadata->>'size' bytes from storage.objects where bucket_id='catalog-products';
select conrelid::regclass,conname,contype,pg_get_constraintdef(oid) from pg_constraint where connamespace='catalog'::regnamespace;
select event_object_table,trigger_name,event_manipulation,action_timing from information_schema.triggers where trigger_schema='catalog';
-- Validacion explícita de referencias del lote: ambas consultas deben devolver cero filas.
-- Solo lectura: también comprueba que cada valor pertenece a la característica esperada
-- y que cada relación tipo/característica está activa.
WITH expected(reference_type, id, parent_id) AS (VALUES
        ('brand', 'd05cc621-2d16-faa3-f620-19fb3173737c'::uuid, NULL::uuid),
        ('brand', 'd5649b17-23aa-dbf2-cb87-60164737fcf9'::uuid, NULL::uuid),
        ('brand', 'c489b6d1-08e1-5dcb-cb4d-2864df0c2ed4'::uuid, NULL::uuid),
        ('brand', '514d9c18-b418-559b-a692-e304183560ad'::uuid, NULL::uuid),
        ('product_type', 'b023a151-d69f-ff9a-483a-678eefe6842e'::uuid, NULL::uuid),
        ('product_type', '69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, NULL::uuid),
        ('product_type', 'db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, NULL::uuid),
        ('product_type', '4d68c7e4-69d4-9e79-8e9e-379aa2a3a01a'::uuid, NULL::uuid),
        ('product_type', '455e292f-face-5ea3-387d-db95b93cc9af'::uuid, NULL::uuid),
        ('category', '69bda117-9700-d41d-9ccf-f207717068e0'::uuid, NULL::uuid),
        ('category', '3894c641-982c-5db5-a9d2-3897b16d9cb3'::uuid, NULL::uuid),
        ('category', 'dbd02734-85f5-b47b-5c95-ee768d5dc875'::uuid, NULL::uuid),
        ('category', 'fcb3cac1-b14a-b935-fc1a-c147b878a5c6'::uuid, NULL::uuid),
        ('characteristic', 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid, NULL::uuid),
        ('characteristic', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, NULL::uuid),
        ('characteristic_value', '931a4c7d-03d4-1ae2-bc95-817315fafcd6'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('characteristic_value', 'c0b1a113-b479-5f84-9fa3-0e6cb3a41fea'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('characteristic_value', '50347024-7af0-2f6b-03fd-f5bbd3f408cf'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('characteristic_value', '35e25c52-aa9b-5572-b656-15b701e4894c'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('characteristic_value', '61174517-27e1-1c5f-253b-4f6f2daa8b3f'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('characteristic_value', '52d4b91a-f829-c05e-d60e-31ada29b0513'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'ae3eba02-52e6-4a8a-d71f-231960bdd9a4'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'c90f8581-0fe2-5fd4-b08c-8b5d3f616399'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '122e93d8-cd1a-4b0e-8224-859fcff6db25'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'c636cd16-7146-52d9-a1a5-faab92c5ea42'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '6e7505c8-4ae3-5850-86b2-d01d0b40bace'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '6787802a-f29f-5a1b-a495-1d034f1002b6'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'f0ec53c9-fb28-7464-e308-a2c171d943a3'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '68e9a97e-7e35-5c46-aed9-046556f9387b'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '353dbffe-8b38-5575-8f35-a7a8e42d8946'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '6e8053e7-d856-5a20-9a0b-9a34d497def5'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'bac7a07c-2684-523f-aca4-761f1e15d128'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'c417b2a9-f655-57a5-976c-128a0b3c1527'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '0223e905-3700-5c92-87ac-f5a0615b2e96'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '20ead521-e596-521d-a057-7c41b52d0626'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '0234fd28-6c7f-5203-bef5-733196f382a6'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid)
), active(reference_type, id, parent_id) AS (
    SELECT 'brand', id, NULL::uuid FROM taxonomy.brands WHERE estado = 'ACTIVO'
    UNION ALL SELECT 'product_type', id, NULL::uuid FROM taxonomy.product_types WHERE estado = 'ACTIVO'
    UNION ALL SELECT 'category', id, NULL::uuid FROM taxonomy.categories WHERE estado = 'ACTIVO'
    UNION ALL SELECT 'characteristic', id, NULL::uuid FROM taxonomy.characteristics WHERE estado = 'ACTIVO'
    UNION ALL SELECT 'characteristic_value', id, caracteristica_id FROM taxonomy.characteristic_values WHERE estado = 'ACTIVO'
)
SELECT e.reference_type, e.id, 'FALTA_INACTIVA_O_CARACTERISTICA_INCORRECTA' AS resultado
FROM expected e LEFT JOIN active a ON a.reference_type=e.reference_type AND a.id=e.id AND a.parent_id IS NOT DISTINCT FROM e.parent_id
WHERE a.id IS NULL
ORDER BY e.reference_type, e.id;
WITH expected(tipo_producto_id, caracteristica_id) AS (VALUES
        ('69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('b023a151-d69f-ff9a-483a-678eefe6842e'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('b023a151-d69f-ff9a-483a-678eefe6842e'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('455e292f-face-5ea3-387d-db95b93cc9af'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('455e292f-face-5ea3-387d-db95b93cc9af'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('4d68c7e4-69d4-9e79-8e9e-379aa2a3a01a'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('4d68c7e4-69d4-9e79-8e9e-379aa2a3a01a'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid)
)
SELECT e.tipo_producto_id, e.caracteristica_id, 'RELACION_FALTA_O_INACTIVA' AS resultado
FROM expected e LEFT JOIN taxonomy.product_type_characteristics r
  ON r.tipo_producto_id=e.tipo_producto_id AND r.caracteristica_id=e.caracteristica_id AND r.estado='ACTIVO'
WHERE r.tipo_producto_id IS NULL
ORDER BY e.tipo_producto_id, e.caracteristica_id;

DO $catalog_preflight$
DECLARE
    invalid_reference_count integer;
    invalid_relation_count integer;
BEGIN
    WITH expected(reference_type, id, parent_id) AS (VALUES
        ('brand', 'd05cc621-2d16-faa3-f620-19fb3173737c'::uuid, NULL::uuid),
        ('brand', 'd5649b17-23aa-dbf2-cb87-60164737fcf9'::uuid, NULL::uuid),
        ('brand', 'c489b6d1-08e1-5dcb-cb4d-2864df0c2ed4'::uuid, NULL::uuid),
        ('brand', '514d9c18-b418-559b-a692-e304183560ad'::uuid, NULL::uuid),
        ('product_type', 'b023a151-d69f-ff9a-483a-678eefe6842e'::uuid, NULL::uuid),
        ('product_type', '69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, NULL::uuid),
        ('product_type', 'db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, NULL::uuid),
        ('product_type', '4d68c7e4-69d4-9e79-8e9e-379aa2a3a01a'::uuid, NULL::uuid),
        ('product_type', '455e292f-face-5ea3-387d-db95b93cc9af'::uuid, NULL::uuid),
        ('category', '69bda117-9700-d41d-9ccf-f207717068e0'::uuid, NULL::uuid),
        ('category', '3894c641-982c-5db5-a9d2-3897b16d9cb3'::uuid, NULL::uuid),
        ('category', 'dbd02734-85f5-b47b-5c95-ee768d5dc875'::uuid, NULL::uuid),
        ('category', 'fcb3cac1-b14a-b935-fc1a-c147b878a5c6'::uuid, NULL::uuid),
        ('characteristic', 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid, NULL::uuid),
        ('characteristic', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, NULL::uuid),
        ('characteristic_value', '931a4c7d-03d4-1ae2-bc95-817315fafcd6'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('characteristic_value', 'c0b1a113-b479-5f84-9fa3-0e6cb3a41fea'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('characteristic_value', '50347024-7af0-2f6b-03fd-f5bbd3f408cf'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('characteristic_value', '35e25c52-aa9b-5572-b656-15b701e4894c'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('characteristic_value', '61174517-27e1-1c5f-253b-4f6f2daa8b3f'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('characteristic_value', '52d4b91a-f829-c05e-d60e-31ada29b0513'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'ae3eba02-52e6-4a8a-d71f-231960bdd9a4'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'c90f8581-0fe2-5fd4-b08c-8b5d3f616399'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '122e93d8-cd1a-4b0e-8224-859fcff6db25'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'c636cd16-7146-52d9-a1a5-faab92c5ea42'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '6e7505c8-4ae3-5850-86b2-d01d0b40bace'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '6787802a-f29f-5a1b-a495-1d034f1002b6'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'f0ec53c9-fb28-7464-e308-a2c171d943a3'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '68e9a97e-7e35-5c46-aed9-046556f9387b'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '353dbffe-8b38-5575-8f35-a7a8e42d8946'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '6e8053e7-d856-5a20-9a0b-9a34d497def5'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'bac7a07c-2684-523f-aca4-761f1e15d128'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', 'c417b2a9-f655-57a5-976c-128a0b3c1527'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '0223e905-3700-5c92-87ac-f5a0615b2e96'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '20ead521-e596-521d-a057-7c41b52d0626'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('characteristic_value', '0234fd28-6c7f-5203-bef5-733196f382a6'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid)
    ), active(reference_type, id, parent_id) AS (
        SELECT 'brand', id, NULL::uuid FROM taxonomy.brands WHERE estado = 'ACTIVO'
        UNION ALL SELECT 'product_type', id, NULL::uuid FROM taxonomy.product_types WHERE estado = 'ACTIVO'
        UNION ALL SELECT 'category', id, NULL::uuid FROM taxonomy.categories WHERE estado = 'ACTIVO'
        UNION ALL SELECT 'characteristic', id, NULL::uuid FROM taxonomy.characteristics WHERE estado = 'ACTIVO'
        UNION ALL SELECT 'characteristic_value', id, caracteristica_id FROM taxonomy.characteristic_values WHERE estado = 'ACTIVO'
    )
    SELECT count(*) INTO invalid_reference_count
    FROM expected e
    LEFT JOIN active a ON a.reference_type = e.reference_type
        AND a.id = e.id AND a.parent_id IS NOT DISTINCT FROM e.parent_id
    WHERE a.id IS NULL;

    WITH expected(tipo_producto_id, caracteristica_id) AS (VALUES
        ('69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('b023a151-d69f-ff9a-483a-678eefe6842e'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('b023a151-d69f-ff9a-483a-678eefe6842e'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('455e292f-face-5ea3-387d-db95b93cc9af'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('455e292f-face-5ea3-387d-db95b93cc9af'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('4d68c7e4-69d4-9e79-8e9e-379aa2a3a01a'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('4d68c7e4-69d4-9e79-8e9e-379aa2a3a01a'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid)
    )
    SELECT count(*) INTO invalid_relation_count
    FROM expected e
    LEFT JOIN taxonomy.product_type_characteristics r
      ON r.tipo_producto_id = e.tipo_producto_id
     AND r.caracteristica_id = e.caracteristica_id
     AND r.estado = 'ACTIVO'
    WHERE r.tipo_producto_id IS NULL;

    IF invalid_reference_count > 0 OR invalid_relation_count > 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'DATA002_PREFLIGHT_BLOCKED';
    END IF;
END
$catalog_preflight$;
