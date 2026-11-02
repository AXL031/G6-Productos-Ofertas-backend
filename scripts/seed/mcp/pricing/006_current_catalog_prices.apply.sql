-- PREPARADO / NO EJECUTADO. Requiere autorizacion de Marco del lote/destino.
-- Proyecto: slzglmtiyrzygpkiuthf, Modulo de Productos y Ofertas.
-- Inicializa solo los 15 precios base faltantes. No modifica los 5 existentes.
-- PEN/global, sin ofertas. Las variantes heredan el precio del producto.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL ROLE po_pricing_seed;
SET LOCAL search_path = pg_catalog, pricing;
SET LOCAL lock_timeout = '5s';

DO $batch$
DECLARE item record;
BEGIN
  IF current_user <> 'po_pricing_seed' THEN
    RAISE EXCEPTION 'Rol efectivo incorrecto';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('29bc43fb-60e4-5f14-a539-ea31a8e37478'::uuid, '96c6972f-2bd2-5528-8028-5293fe719db9'::text, '59.00'::numeric(12,2), 'bd5bae6f-3b45-59f7-ae21-f690a18a4d2d'::uuid),
    ('0c341043-eede-5155-a0f0-55c2c9c7f3ef'::uuid, '8be3020b-0f9c-5343-ad74-41740393bece'::text, '69.00'::numeric(12,2), '10ab597c-2fd4-5bbb-a98a-ac5fb8f970db'::uuid),
    ('2ce89305-8855-50ad-a14c-6d7f96d7a16b'::uuid, 'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914'::text, '79.00'::numeric(12,2), '54e3c638-ded4-5b4b-abc9-0fa07b8251be'::uuid),
    ('bdd752a8-532e-53f8-a965-e27ce7c74aad'::uuid, '9d5e65cb-10c9-5a2b-a69d-090e3208bd77'::text, '259.00'::numeric(12,2), 'f67745bc-52c6-5939-aba8-0634dba143e8'::uuid),
    ('559c7165-2f80-5808-a98d-deeca79fd2a4'::uuid, '457f749f-2aaf-56a3-9776-a95df5d24d59'::text, '49.00'::numeric(12,2), '1c0ca457-d785-518e-ad25-db11f6786732'::uuid),
    ('e2aa0a34-58bd-5f26-aab8-fd9df8279046'::uuid, '59022191-2fb1-5db3-903f-05f8e6be19b1'::text, '79.00'::numeric(12,2), '98aca149-77b7-503d-a331-a782f8c3f123'::uuid),
    ('9da01a9e-71c2-5e63-a868-646a370f512b'::uuid, '536287fd-b2fa-5c1d-a086-7db284725485'::text, '69.00'::numeric(12,2), 'f4c94520-f2e9-50d2-a7f7-e12a4053de62'::uuid),
    ('e4fb9610-1a09-5a1f-a291-17c5b23f56d5'::uuid, '2ee6399e-2333-5916-847b-f6d2a0f03527'::text, '129.90'::numeric(12,2), 'f0cddeb6-0c68-5947-a1e9-ceb5163bbc1a'::uuid),
    ('4575a954-c220-5042-a007-dcc0af2fbda2'::uuid, 'ff8e9b30-f939-51cd-9294-4753cdae05b8'::text, '69.90'::numeric(12,2), 'da40d40c-1b6a-5a72-a50e-2b9adce4099b'::uuid),
    ('ec676abb-bade-5722-a0d4-fbe3525fed55'::uuid, 'b8224b4b-8268-57e4-9d61-d4424828544c'::text, '69.90'::numeric(12,2), 'd4cce97d-28ec-5ebc-ab86-dedd10f1005b'::uuid),
    ('924928c4-22e7-55b2-a599-7f28f432ffb6'::uuid, '0f9cc95c-6502-54ce-82d5-72f192bbd33c'::text, '69.90'::numeric(12,2), 'edf63cfc-8b14-5ff1-ad37-507c67158787'::uuid),
    ('e5139e88-7803-5c04-a944-b4eb0b57a1c0'::uuid, '79c03413-cf12-56fe-bcd1-32e45cf40221'::text, '89.90'::numeric(12,2), 'c7ce7f72-a860-58a7-ad6c-e3742f3c1b04'::uuid),
    ('8077c84d-4b54-55d1-abf6-5c960bc37dfd'::uuid, '8111028a-4a0e-5cb1-a4b8-8095cc098a83'::text, '119.00'::numeric(12,2), '41acf730-d98d-5758-a6f7-7918fd5a68b8'::uuid),
    ('a47b818f-1eaa-5325-a32b-161cd6b9ec86'::uuid, '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc'::text, '169.00'::numeric(12,2), 'b21393ec-0616-5810-ad1c-aa9b54644580'::uuid),
    ('1fc7ab67-0d63-5d2b-ab17-d95293f19b1b'::uuid, '858ed760-beb9-5fdf-aa6d-b6b543b162d2'::text, '109.90'::numeric(12,2), 'dc3461ad-a58d-5ca1-a474-6c2d5f25bbeb'::uuid)
  ) AS expected(price_id, product_id, amount, validity_id)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pricing.prices p JOIN pricing.price_validities v ON v.price_id = p.id
      WHERE p.id = item.price_id AND p.product_id = item.product_id
        AND p.sku IS NULL AND p.channel_id IS NULL AND p.price_version = 1
        AND v.id = item.validity_id AND v.precio_regular = item.amount
        AND v.precio_oferta IS NULL AND v.currency = 'PEN' AND v.price_version = 1
        AND v.valid_until IS NULL AND v.valid_from = p.created_at
        AND NOT v.is_cancelled AND v.usuario_id IS NULL
        AND v.motivo_cambio = 'Alta de precio regular sintetico Inka Athletics (2026-10-17)'
        AND (SELECT count(*) FROM pricing.price_validities other WHERE other.price_id = p.id) = 1
    ) THEN
      CONTINUE;
    END IF;
    IF (EXISTS (SELECT 1 FROM pricing.prices p WHERE p.id = item.price_id
        OR (p.product_id = item.product_id AND p.sku IS NULL AND p.channel_id IS NULL))
      OR EXISTS (SELECT 1 FROM pricing.price_validities v WHERE v.id = item.validity_id)) THEN
      RAISE EXCEPTION 'Conflicto de lote: product_id=%, price_id=%', item.product_id, item.price_id;
    END IF;
    INSERT INTO pricing.prices (id, product_id, sku, channel_id, price_version)
    VALUES (item.price_id, item.product_id, NULL, NULL, 1);
    INSERT INTO pricing.price_validities
      (id, price_id, precio_regular, precio_oferta, currency, valid_from, valid_until,
       price_version, motivo_cambio, usuario_id, is_cancelled)
    VALUES
      (item.validity_id, item.price_id, item.amount, NULL, 'PEN', transaction_timestamp(), NULL,
       1, 'Alta de precio regular sintetico Inka Athletics (2026-10-17)', NULL, false);
  END LOOP;
END
$batch$;

SET CONSTRAINTS ALL IMMEDIATE;
SELECT p.id, p.product_id, v.id AS validity_id, v.precio_regular::text,
       v.currency, p.channel_id, v.valid_from, v.valid_until
FROM pricing.prices p JOIN pricing.price_validities v ON v.price_id = p.id
WHERE p.id IN (
  '29bc43fb-60e4-5f14-a539-ea31a8e37478'::uuid,
  '0c341043-eede-5155-a0f0-55c2c9c7f3ef'::uuid,
  '2ce89305-8855-50ad-a14c-6d7f96d7a16b'::uuid,
  'bdd752a8-532e-53f8-a965-e27ce7c74aad'::uuid,
  '559c7165-2f80-5808-a98d-deeca79fd2a4'::uuid,
  'e2aa0a34-58bd-5f26-aab8-fd9df8279046'::uuid,
  '9da01a9e-71c2-5e63-a868-646a370f512b'::uuid,
  'e4fb9610-1a09-5a1f-a291-17c5b23f56d5'::uuid,
  '4575a954-c220-5042-a007-dcc0af2fbda2'::uuid,
  'ec676abb-bade-5722-a0d4-fbe3525fed55'::uuid,
  '924928c4-22e7-55b2-a599-7f28f432ffb6'::uuid,
  'e5139e88-7803-5c04-a944-b4eb0b57a1c0'::uuid,
  '8077c84d-4b54-55d1-abf6-5c960bc37dfd'::uuid,
  'a47b818f-1eaa-5325-a32b-161cd6b9ec86'::uuid,
  '1fc7ab67-0d63-5d2b-ab17-d95293f19b1b'::uuid
) ORDER BY p.product_id;
COMMIT;
