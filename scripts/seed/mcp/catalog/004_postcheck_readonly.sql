-- Postcheck DATA-002. Es una consulta de solo lectura compatible con SQL/MCP.
-- Cada fila devuelve observacion, esperado y PASS/FAIL para revisión del operador.
WITH product_ids(ids) AS (
    VALUES (ARRAY[
        '96c6972f-2bd2-5528-8028-5293fe719db9', '8be3020b-0f9c-5343-ad74-41740393bece',
        'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77',
        '457f749f-2aaf-56a3-9776-a95df5d24d59', '59022191-2fb1-5db3-903f-05f8e6be19b1',
        '536287fd-b2fa-5c1d-a086-7db284725485', '2ee6399e-2333-5916-847b-f6d2a0f03527',
        'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'b8224b4b-8268-57e4-9d61-d4424828544c',
        '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '79c03413-cf12-56fe-bcd1-32e45cf40221',
        '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '8111028a-4a0e-5cb1-a4b8-8095cc098a83',
        '858ed760-beb9-5fdf-aa6d-b6b543b162d2'
    ]::uuid[])
), checks(orden, comprobacion, observado, esperado, aprobado) AS (
    SELECT 1, 'productos', count(*)::text, '15', count(*) = 15
    FROM catalog.products, product_ids WHERE id = ANY(product_ids.ids)
    UNION ALL
    SELECT 2, 'variantes', count(*)::text, '45', count(*) = 45
    FROM catalog.variants, product_ids WHERE product_id = ANY(product_ids.ids)
    UNION ALL
    SELECT 3, 'caracteristicas_identificadoras_producto', count(*)::text, '24', count(*) = 24
    FROM catalog.product_identifying_characteristics, product_ids
    WHERE product_id = ANY(product_ids.ids)
    UNION ALL
    SELECT 4, 'atributos_variante', count(*)::text, '90', count(*) = 90
    FROM catalog.variant_attribute_values a
    JOIN catalog.variants v ON v.id = a.variant_id
    CROSS JOIN product_ids WHERE v.product_id = ANY(product_ids.ids)
    UNION ALL
    SELECT 5, 'atributos_producto', count(*)::text, '6', count(*) = 6
    FROM catalog.product_attribute_values, product_ids
    WHERE product_id = ANY(product_ids.ids)
    UNION ALL
    SELECT 6, 'payloads_jsonb_validos', count(*)::text, '0', count(*) = 0
    FROM (
        SELECT a.valor, a.valor_id
        FROM catalog.variant_attribute_values a
        JOIN catalog.variants v ON v.id = a.variant_id
        CROSS JOIN product_ids WHERE v.product_id = ANY(product_ids.ids)
        UNION ALL
        SELECT a.valor, a.valor_id
        FROM catalog.product_attribute_values a
        CROSS JOIN product_ids WHERE a.product_id = ANY(product_ids.ids)
    ) attributes
    WHERE valor IS NULL OR jsonb_typeof(valor) <> 'object'
       OR valor->>'valor_id' IS DISTINCT FROM valor_id
    UNION ALL
    SELECT 7, 'sku_vendibles', count(*)::text, '48', count(*) = 48
    FROM catalog.sku_identity s, product_ids
    WHERE s.variant_id IN (
        SELECT id FROM catalog.variants WHERE product_id = ANY(product_ids.ids)
    ) OR s.product_id IN (
        'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914',
        '2ee6399e-2333-5916-847b-f6d2a0f03527',
        '8111028a-4a0e-5cb1-a4b8-8095cc098a83'
    )
    UNION ALL
    SELECT 8, 'imagenes_variante', count(*)::text, '45', count(*) = 45
    FROM catalog.variant_images i
    JOIN catalog.variants v ON v.id = i.variant_id
    CROSS JOIN product_ids WHERE v.product_id = ANY(product_ids.ids)
    UNION ALL
    SELECT 9, 'imagenes_producto', count(*)::text, '3', count(*) = 3
    FROM catalog.product_images, product_ids
    WHERE product_id = ANY(product_ids.ids)
    UNION ALL
    SELECT 10, 'urls_imagen_distintas', count(DISTINCT url)::text, '17', count(DISTINCT url) = 17
    FROM (
        SELECT i.url FROM catalog.variant_images i
        JOIN catalog.variants v ON v.id = i.variant_id
        CROSS JOIN product_ids WHERE v.product_id = ANY(product_ids.ids)
        UNION ALL
        SELECT i.url FROM catalog.product_images i
        CROSS JOIN product_ids WHERE i.product_id = ANY(product_ids.ids)
    ) image_urls
    UNION ALL
    SELECT 11, 'identifying_key_derivada', count(*)::text, '0', count(*) = 0
    FROM catalog.variants v
    CROSS JOIN LATERAL (
        SELECT jsonb_object_agg(a.caracteristica_id, jsonb_build_object('valor_id', a.valor_id)) AS derived_key
        FROM catalog.variant_attribute_values a
        WHERE a.variant_id = v.id AND a.es_identificador
    ) attributes
    CROSS JOIN product_ids
    WHERE v.product_id = ANY(product_ids.ids)
      AND v.identifying_key IS DISTINCT FROM attributes.derived_key
    UNION ALL
    SELECT 12, 'variantes_con_imagen', count(*)::text, '0', count(*) = 0
    FROM catalog.variants v
    CROSS JOIN product_ids
    WHERE v.product_id = ANY(product_ids.ids)
      AND NOT EXISTS (
          SELECT 1 FROM catalog.variant_images i WHERE i.variant_id = v.id
      )
)
SELECT comprobacion, observado, esperado,
       CASE WHEN aprobado THEN 'PASS' ELSE 'FAIL' END AS resultado
FROM checks
ORDER BY orden;
