SET ROLE po_catalog_owner;
SELECT set_config('catalog.data002_execution_backend',pg_backend_pid()::text,false);
SELECT set_config('catalog.data002_physical_semantics','ACADEMIC_LOGISTIC_EXCEPTION_APPROVED',false);
-- PROPUESTA ACADÉMICA #12. PENDIENTE_APROBACION_MARCO para Supabase compartido.
-- Solo INSERT en catalog.sku_physical_profiles. No crear identidades ni sobrescribir perfiles.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $profiles$
DECLARE m record; before_state jsonb;
BEGIN
  IF current_setting('catalog.data002_physical_semantics',true) IS DISTINCT FROM 'ACADEMIC_LOGISTIC_EXCEPTION_APPROVED'
    THEN RAISE EXCEPTION 'DATA002_PHYSICAL_SEMANTICS_NOT_APPROVED'; END IF;
  IF current_user <> 'po_catalog_owner' OR NOT EXISTS (SELECT 1 FROM pg_namespace
    WHERE nspname='catalog' AND pg_get_userbyid(nspowner)=current_user)
    THEN RAISE EXCEPTION 'DATA002_REQUIRE_CATALOG_OWNER'; END IF;
  LOCK TABLE catalog.products, catalog.variants, catalog.sku_identity, catalog.product_images, catalog.variant_images, catalog.product_attribute_values, catalog.variant_attribute_values, catalog.product_identifying_characteristics, catalog.activation_checks, catalog.master_barriers, catalog.outbox, catalog.inbox, catalog.sku_physical_profiles IN SHARE ROW EXCLUSIVE MODE;
  before_state := (SELECT jsonb_build_object('products',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.products t),
'variants',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variants t),
'sku_identity',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.sku_identity t),
'product_images',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.product_images t),
'variant_images',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variant_images t),
'product_attribute_values',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.product_attribute_values t),
'variant_attribute_values',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variant_attribute_values t),
'product_identifying_characteristics',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.product_identifying_characteristics t),
'activation_checks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.activation_checks t),
'master_barriers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.master_barriers t),
'outbox',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.outbox t),
'inbox',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.inbox t)));
  IF (SELECT count(*)<>55 OR count(DISTINCT sku_identity_id)<>55 OR count(DISTINCT sku)<>55 FROM (VALUES
  ('ADI-ENT22-AZU-M', '1fb83549-de75-4489-a51f-9224648b3b83', '32a4172c-81b2-b643-1d0f-ae66f627f2ef', '35133a17-114a-381e-090a-87446d5fc701', 'ADI-ENT22-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('ADI-ENT22-SHORT-GRI-S', '38a2f874-54a1-4195-beab-69d9cda3adb4', '96c6972f-2bd2-5528-8028-5293fe719db9', '347eebb8-f145-5e3f-8cad-31ffa45ccabc', 'ADI-ENT22-SHORT-BASE', 'VARIANTE', '0.145'::numeric, '30'::numeric, '22'::numeric, '4'::numeric),
  ('ADI-ENT22-SHORT-GRI-M', 'e2485b7a-27fe-4d56-9691-461f1ff8f457', '96c6972f-2bd2-5528-8028-5293fe719db9', '3cde5b53-8282-5491-a423-80a912ee8b71', 'ADI-ENT22-SHORT-BASE', 'VARIANTE', '0.165'::numeric, '33.7'::numeric, '24.2'::numeric, '4.5'::numeric),
  ('ADI-ENT22-SHORT-GRI-L', 'de6fe700-32c2-4354-a3f2-9d3e0ed6c79b', '96c6972f-2bd2-5528-8028-5293fe719db9', 'f60c691e-74fe-5507-a111-a1fd4e1c1f5a', 'ADI-ENT22-SHORT-BASE', 'VARIANTE', '0.19'::numeric, '35'::numeric, '25'::numeric, '5'::numeric),
  ('ADI-ENT26-AZU-S', '9c2801c5-8a19-477c-af55-0c3b2a6c5bf3', '8be3020b-0f9c-5343-ad74-41740393bece', '83709a1d-e38f-5c11-b389-4b72321eda59', 'ADI-ENT26-BASE', 'VARIANTE', '0.17'::numeric, '30'::numeric, '22'::numeric, '2.5'::numeric),
  ('ADI-ENT26-AZU-M', 'c64e267e-105c-44c1-9ca4-c785d9eed0f5', '8be3020b-0f9c-5343-ad74-41740393bece', '7f943d67-1e76-5594-b3be-f0670c1072bc', 'ADI-ENT26-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('ADI-ENT26-AZU-L', '184f8386-11c3-4b18-b37b-f42974ad528b', '8be3020b-0f9c-5343-ad74-41740393bece', 'd756023d-9a33-5fab-af73-9d386b498f21', 'ADI-ENT26-BASE', 'VARIANTE', '0.205'::numeric, '34'::numeric, '24'::numeric, '3'::numeric),
  ('ADI-ENT26-BLA-S', '3b900f1a-e7d6-4414-9377-75154fea9f53', '8be3020b-0f9c-5343-ad74-41740393bece', 'eecf0794-1eea-5cf3-83a6-42795902726e', 'ADI-ENT26-BASE', 'VARIANTE', '0.17'::numeric, '30'::numeric, '22'::numeric, '2.5'::numeric),
  ('ADI-ENT26-BLA-M', '6cc310b7-7a64-4203-a779-994e0060f570', '8be3020b-0f9c-5343-ad74-41740393bece', '0cd5c7bf-363b-5501-b237-d6ff14814f67', 'ADI-ENT26-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('ADI-ENT26-BLA-L', 'd972b913-90e8-4660-94db-323f5993c782', '8be3020b-0f9c-5343-ad74-41740393bece', '9a4bb6a1-1e68-5d32-b861-51a1f20ba8f3', 'ADI-ENT26-BASE', 'VARIANTE', '0.205'::numeric, '34'::numeric, '24'::numeric, '3'::numeric),
  ('ADI-MESSI-JI8291-05', '5e226593-924b-4ee2-9d4b-0eac22c2616e', 'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', NULL, 'ADI-MESSI-JI8291-05', 'PRODUCTO_SIMPLE', '0.42'::numeric, '22'::numeric, '22'::numeric, '22'::numeric),
  ('ADI-PRED-IG7760-MUL-38', '4fbdd519-3dd7-4512-aa84-3ad3a1d4a987', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '840b28a1-46fc-5e3a-a176-cb150e25e8a7', 'ADI-PRED-IG7760-BASE', 'VARIANTE', '0.82'::numeric, '32'::numeric, '20'::numeric, '12'::numeric),
  ('ADI-PRED-IG7760-MUL-40', 'fea91919-d38f-4a45-9584-e2fc8e4d4e5b', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '864ea99c-a2d8-5906-b93f-ac5300fdfa3e', 'ADI-PRED-IG7760-BASE', 'VARIANTE', '0.87'::numeric, '34'::numeric, '22'::numeric, '12.5'::numeric),
  ('ADI-PRED-IG7760-MUL-42', '9f1b8f46-f568-45e7-9e11-6280feb48445', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '2cc6f948-5d34-5ed1-9bfc-c5ff9f39d63f', 'ADI-PRED-IG7760-BASE', 'VARIANTE', '0.93'::numeric, '35'::numeric, '23'::numeric, '13'::numeric),
  ('ADI-PRED-IG7760-MUL-43', '61578bef-98ea-433b-99fe-0bffc23b2ed1', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '284276f3-e0ab-5ffb-a394-3664374aa09b', 'ADI-PRED-IG7760-BASE', 'VARIANTE', '0.97'::numeric, '36'::numeric, '24'::numeric, '13'::numeric),
  ('ADI-RF3-GRI-38', '5fbdfbb6-2c5d-44fb-a896-27e2e44405c9', 'abaf9767-7431-9b50-495c-aeb880dc3055', '532ffc0d-d209-2b48-6506-e94f62026e17', 'ADI-RF3-BASE', 'VARIANTE', '0.85'::numeric, '32'::numeric, '20'::numeric, '12'::numeric),
  ('ADI-RF3-GRI-39', '43ba45b9-c161-4387-a1c9-db2b1f17afc2', 'abaf9767-7431-9b50-495c-aeb880dc3055', 'f1bd0fad-819b-b0fd-b5b1-53bb36fd468f', 'ADI-RF3-BASE', 'VARIANTE', '0.88'::numeric, '33'::numeric, '21'::numeric, '12'::numeric),
  ('ADI-RUNX-JD9558-NEG-EU3436', 'd308eb05-3ca5-4c6c-845c-8bcde8415516', '457f749f-2aaf-56a3-9776-a95df5d24d59', '629792a7-60fb-57f5-9747-f3b54cf8b553', 'ADI-RUNX-JD9558-BASE', 'VARIANTE', '0.08'::numeric, '20'::numeric, '12'::numeric, '3'::numeric),
  ('ADI-RUNX-JD9558-NEG-EU3739', 'c6150f1e-6a0f-4d2e-8694-70a2bb169b22', '457f749f-2aaf-56a3-9776-a95df5d24d59', 'b1d488a5-fba8-5fd4-90b7-b7440cd59a40', 'ADI-RUNX-JD9558-BASE', 'VARIANTE', '0.09'::numeric, '21'::numeric, '13'::numeric, '3'::numeric),
  ('ADI-RUNX-JD9558-NEG-EU4042', 'bf316fa4-e011-4b2b-b322-b801cd0dfe78', '457f749f-2aaf-56a3-9776-a95df5d24d59', '677f8fcc-caaf-5cc9-a060-c7756d5ab1c2', 'ADI-RUNX-JD9558-BASE', 'VARIANTE', '0.1'::numeric, '22'::numeric, '14'::numeric, '3'::numeric),
  ('ADI-SQUA25-JG5832-NEG-S', 'eb4eb0a0-579b-4373-9865-f6a1cc737fbe', '59022191-2fb1-5db3-903f-05f8e6be19b1', '91f677b4-3ee9-539d-9ed9-6804f8922a26', 'ADI-SQUA25-JG5832-BASE', 'VARIANTE', '0.17'::numeric, '30'::numeric, '22'::numeric, '2.5'::numeric),
  ('ADI-SQUA25-JG5832-NEG-M', 'fb57e5d6-5478-469c-a7b8-42ec14c7bb47', '59022191-2fb1-5db3-903f-05f8e6be19b1', 'ab8ae29e-84d5-58fb-b237-c07bc618386c', 'ADI-SQUA25-JG5832-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('ADI-SQUA25-JG5832-NEG-L', '3e05d962-d3aa-4e06-9b91-d1fce3b3da4b', '59022191-2fb1-5db3-903f-05f8e6be19b1', '30723507-bc26-53e2-b3e1-e2a03124445d', 'ADI-SQUA25-JG5832-BASE', 'VARIANTE', '0.205'::numeric, '34'::numeric, '24'::numeric, '3'::numeric),
  ('ADI-SQUA25-JH3407-AZU-S', '4061ac24-5c79-428b-936f-aa09082660cd', '536287fd-b2fa-5c1d-a086-7db284725485', '0d6a3d1f-50fc-5e74-b50b-3844d2f3bcfa', 'ADI-SQUA25-JH3407-BASE', 'VARIANTE', '0.145'::numeric, '27'::numeric, '20'::numeric, '3'::numeric),
  ('ADI-SQUA25-JH3407-AZU-M', 'c357588a-6309-4f98-85b4-be134c2d3344', '536287fd-b2fa-5c1d-a086-7db284725485', '62ca791d-dd40-5846-8105-3650730c08cf', 'ADI-SQUA25-JH3407-BASE', 'VARIANTE', '0.165'::numeric, '29'::numeric, '21'::numeric, '3.5'::numeric),
  ('ADI-SQUA25-JH3407-AZU-L', 'e0d8eb63-e96b-4d0f-8329-5816b1ac2743', '536287fd-b2fa-5c1d-a086-7db284725485', '161d02f4-1913-51c7-aa37-140c6fef4bca', 'ADI-SQUA25-JH3407-BASE', 'VARIANTE', '0.185'::numeric, '31'::numeric, '22'::numeric, '4'::numeric),
  ('NIK-ACADEMY-HV4386-05', '0a2c61dd-2a1c-4078-9bd3-594026e415e2', '2ee6399e-2333-5916-847b-f6d2a0f03527', NULL, 'NIK-ACADEMY-HV4386-05', 'PRODUCTO_SIMPLE', '0.43'::numeric, '22'::numeric, '22'::numeric, '22'::numeric),
  ('NIK-EVP-FQ0327-NEG-EU3438', '14ca68bf-486c-428e-92cb-66d9aa884f02', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', '968ec637-15e1-549c-b8ba-da77ed375edc', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.08'::numeric, '20'::numeric, '12'::numeric, '3'::numeric),
  ('NIK-EVP-FQ0327-NEG-EU3842', '2b04fca8-2f47-480b-9109-2e1c4cde3999', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', '7f8c7bf8-3086-5849-a21f-722bb13bff1c', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.09'::numeric, '21'::numeric, '13'::numeric, '3'::numeric),
  ('NIK-EVP-FQ0327-NEG-EU4246', 'afec6d91-f830-4063-96fa-741f912d7a8a', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', '73829aef-a02c-5555-82f1-03a495d44ced', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.1'::numeric, '22'::numeric, '14'::numeric, '3'::numeric),
  ('NIK-EVP-FQ0327-BLA-EU3438', 'f3e13e01-d48a-4f60-9fa1-c68502cb8903', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', '1c995251-cf8c-55e2-878a-ea83f9f4b351', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.08'::numeric, '20'::numeric, '12'::numeric, '3'::numeric),
  ('NIK-EVP-FQ0327-BLA-EU3842', 'd8a4059a-550a-4599-ac59-c976c08f6c1e', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'e8a0b20b-a6fd-5a78-9e6b-8199f32742c2', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.09'::numeric, '21'::numeric, '13'::numeric, '3'::numeric),
  ('NIK-EVP-FQ0327-BLA-EU4246', 'aa622e76-f1b9-4503-bc12-1d3572185e14', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'bc260f04-d0c1-57d6-862a-6d7ae44c74ff', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.1'::numeric, '22'::numeric, '14'::numeric, '3'::numeric),
  ('NIK-PARK3-M-BV6855-NEG-S', '5282426e-61f6-4168-8d61-2b7fd79ee2c0', 'b8224b4b-8268-57e4-9d61-d4424828544c', 'bd42a0bd-dd7e-595c-8d1d-7afabc4ed049', 'NIK-PARK3-M-BV6855-BASE', 'VARIANTE', '0.145'::numeric, '27'::numeric, '20'::numeric, '3'::numeric),
  ('NIK-PARK3-M-BV6855-NEG-M', '8cd5c256-775a-4470-8fe4-70e48fca848c', 'b8224b4b-8268-57e4-9d61-d4424828544c', '4ef2fc98-fe62-5d4c-b050-5ad312c088e0', 'NIK-PARK3-M-BV6855-BASE', 'VARIANTE', '0.165'::numeric, '29'::numeric, '21'::numeric, '3.5'::numeric),
  ('NIK-PARK3-M-BV6855-NEG-L', '2a770e47-3ee9-45c6-a8ee-7f82fc168aad', 'b8224b4b-8268-57e4-9d61-d4424828544c', 'df53883d-2875-5a71-afe8-1f4097e8b234', 'NIK-PARK3-M-BV6855-BASE', 'VARIANTE', '0.185'::numeric, '31'::numeric, '22'::numeric, '4'::numeric),
  ('NIK-PARK3-W-BV6860-NEG-XS', 'fab810b3-cd46-43b8-b0e3-b0e562ce6354', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '923d14cc-c3d8-53b2-b0c5-57568e9f1abd', 'NIK-PARK3-W-BV6860-BASE', 'VARIANTE', '0.13'::numeric, '25'::numeric, '18'::numeric, '3'::numeric),
  ('NIK-PARK3-W-BV6860-NEG-S', '91b99924-f0b5-473b-b1f7-c38e22f393a0', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', 'e3cd5843-307f-576a-b721-2f58d7df3fdc', 'NIK-PARK3-W-BV6860-BASE', 'VARIANTE', '0.145'::numeric, '27'::numeric, '20'::numeric, '3'::numeric),
  ('NIK-PARK3-W-BV6860-NEG-M', 'c074170e-4fe9-47ac-8ba0-a734da153cf9', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', 'a6a0d134-e4a9-58ba-b512-37076fc99a33', 'NIK-PARK3-W-BV6860-BASE', 'VARIANTE', '0.165'::numeric, '29'::numeric, '21'::numeric, '3.5'::numeric),
  ('NIK-PARK3-W-BV6860-NEG-L', '77e10e3d-3d74-45a1-ac7e-8d62374c04ba', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '29cf5cee-af27-5da0-aaba-c8f4f6712101', 'NIK-PARK3-W-BV6860-BASE', 'VARIANTE', '0.185'::numeric, '31'::numeric, '22'::numeric, '4'::numeric),
  ('NIK-PARK3-W-BV6860-NEG-XL', '448631bc-619a-4588-a10a-f410ad75cc76', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '909bf47b-9242-5955-b2ed-03adf2922580', 'NIK-PARK3-W-BV6860-BASE', 'VARIANTE', '0.21'::numeric, '33'::numeric, '23'::numeric, '4'::numeric),
  ('NIK-PARK7-BV6708-NEG-S', 'aa979ff0-574f-413c-8cca-cf615592f7be', '79c03413-cf12-56fe-bcd1-32e45cf40221', 'f3890276-9ad2-545b-948b-484f5ed1495b', 'NIK-PARK7-BV6708-BASE', 'VARIANTE', '0.17'::numeric, '30'::numeric, '22'::numeric, '2.5'::numeric),
  ('NIK-PARK7-BV6708-NEG-M', 'e416d7cd-b3dd-47ae-bf89-6ec9faeabfdc', '79c03413-cf12-56fe-bcd1-32e45cf40221', '033875cd-b8de-50d6-bb3d-49e98e146178', 'NIK-PARK7-BV6708-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('NIK-PARK7-BV6708-NEG-L', '41288821-165f-4c22-9373-97be7cc15dd9', '79c03413-cf12-56fe-bcd1-32e45cf40221', '96945dfc-af18-5da8-8e6e-c49b8c673ed2', 'NIK-PARK7-BV6708-BASE', 'VARIANTE', '0.205'::numeric, '34'::numeric, '24'::numeric, '3'::numeric),
  ('NIK-PITCH-05', 'eb4d35ac-41c0-4e6e-a059-5dc35d850a57', 'abab3400-46eb-58f7-78d5-8204418b60d9', NULL, 'NIK-PITCH-05', 'PRODUCTO_SIMPLE', '0.43'::numeric, '22'::numeric, '22'::numeric, '22'::numeric),
  ('NIK-REV7-NEG-41', '0265b4f7-4ca3-455c-a416-de32eb341494', 'fedeecfb-c7f5-56cf-c31b-9cdf10b47058', '9df1c63b-f475-5ea4-fab4-cf2bb36120ae', 'NIK-REV7-BASE', 'VARIANTE', '0.95'::numeric, '34'::numeric, '22'::numeric, '13'::numeric),
  ('NIK-REV7-NEG-42', '0ece3ef9-cede-4159-85b5-1768b63ab748', 'fedeecfb-c7f5-56cf-c31b-9cdf10b47058', '437853de-9b59-6b0b-5b26-ccd51e2e062b', 'NIK-REV7-BASE', 'VARIANTE', '0.98'::numeric, '35'::numeric, '23'::numeric, '13'::numeric),
  ('PUM-ORBITA-084641-05', '91286dbf-c52d-426e-bf6a-d71457156341', '8111028a-4a0e-5cb1-a4b8-8095cc098a83', NULL, 'PUM-ORBITA-084641-05', 'PRODUCTO_SIMPLE', '0.43'::numeric, '22'::numeric, '22'::numeric, '22'::numeric),
  ('PUM-SC-782244-BLA-S', '2d6881c1-928d-4f57-b1e2-42000169dcf4', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '7a594c35-880e-5682-b282-a3cc01d8854c', 'PUM-SC-782244-BASE', 'VARIANTE', '0.17'::numeric, '30'::numeric, '22'::numeric, '2.5'::numeric),
  ('PUM-SC-782244-BLA-M', '8b314e37-b2c1-4115-9b0f-f23af5f06881', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', 'd82aafc7-3257-5bc8-8093-c9139562e910', 'PUM-SC-782244-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('PUM-SC-782244-BLA-L', '2959ed50-1360-4368-aa4b-5f2cad69a5ea', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '61600bf0-bb76-5b31-9c9b-1df55ddd3471', 'PUM-SC-782244-BASE', 'VARIANTE', '0.205'::numeric, '34'::numeric, '24'::numeric, '3'::numeric),
  ('PUM-ULP-NEG-42', '72c5c4f2-f9cb-40c1-a017-b48a0a4b79cb', '08f2c67c-d79a-3e61-c7ee-0262885f68e7', '9ba54bda-2686-8e3b-41c6-68b6efa16338', 'PUM-ULP-BASE', 'VARIANTE', '0.93'::numeric, '35'::numeric, '23'::numeric, '13'::numeric),
  ('UA-TECH20-1326413-NEG-S', 'ccf4e328-f61d-42e3-b5d3-94d33c84bfd5', '858ed760-beb9-5fdf-aa6d-b6b543b162d2', 'b6bdb52f-a904-56b8-a863-f23aea89ffc6', 'UA-TECH20-1326413-BASE', 'VARIANTE', '0.125'::numeric, '28'::numeric, '19'::numeric, '1.5'::numeric),
  ('UA-TECH20-1326413-NEG-M', '4f527966-baef-4f82-baca-c37610252713', '858ed760-beb9-5fdf-aa6d-b6b543b162d2', 'b271319c-457a-58c5-bbbf-62280abd0803', 'UA-TECH20-1326413-BASE', 'VARIANTE', '0.138'::numeric, '30'::numeric, '20'::numeric, '1.6'::numeric),
  ('UA-TECH20-1326413-NEG-L', 'eebd5a28-9329-4eb0-a8b3-e12b4e9d6a22', '858ed760-beb9-5fdf-aa6d-b6b543b162d2', '09875bf7-7cbd-5f6d-92e9-47d78e8763a6', 'UA-TECH20-1326413-BASE', 'VARIANTE', '0.149'::numeric, '31'::numeric, '20.5'::numeric, '1.7'::numeric)
) AS m(sku, sku_identity_id, product_id, variant_id, sku_base, tipo_unidad, peso_kg, largo_cm, ancho_cm, alto_cm))
    THEN RAISE EXCEPTION 'DATA002_PROFILE_SCOPE_CONFLICT'; END IF;
  FOR m IN SELECT * FROM (VALUES
  ('ADI-ENT22-AZU-M', '1fb83549-de75-4489-a51f-9224648b3b83', '32a4172c-81b2-b643-1d0f-ae66f627f2ef', '35133a17-114a-381e-090a-87446d5fc701', 'ADI-ENT22-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('ADI-ENT22-SHORT-GRI-S', '38a2f874-54a1-4195-beab-69d9cda3adb4', '96c6972f-2bd2-5528-8028-5293fe719db9', '347eebb8-f145-5e3f-8cad-31ffa45ccabc', 'ADI-ENT22-SHORT-BASE', 'VARIANTE', '0.145'::numeric, '30'::numeric, '22'::numeric, '4'::numeric),
  ('ADI-ENT22-SHORT-GRI-M', 'e2485b7a-27fe-4d56-9691-461f1ff8f457', '96c6972f-2bd2-5528-8028-5293fe719db9', '3cde5b53-8282-5491-a423-80a912ee8b71', 'ADI-ENT22-SHORT-BASE', 'VARIANTE', '0.165'::numeric, '33.7'::numeric, '24.2'::numeric, '4.5'::numeric),
  ('ADI-ENT22-SHORT-GRI-L', 'de6fe700-32c2-4354-a3f2-9d3e0ed6c79b', '96c6972f-2bd2-5528-8028-5293fe719db9', 'f60c691e-74fe-5507-a111-a1fd4e1c1f5a', 'ADI-ENT22-SHORT-BASE', 'VARIANTE', '0.19'::numeric, '35'::numeric, '25'::numeric, '5'::numeric),
  ('ADI-ENT26-AZU-S', '9c2801c5-8a19-477c-af55-0c3b2a6c5bf3', '8be3020b-0f9c-5343-ad74-41740393bece', '83709a1d-e38f-5c11-b389-4b72321eda59', 'ADI-ENT26-BASE', 'VARIANTE', '0.17'::numeric, '30'::numeric, '22'::numeric, '2.5'::numeric),
  ('ADI-ENT26-AZU-M', 'c64e267e-105c-44c1-9ca4-c785d9eed0f5', '8be3020b-0f9c-5343-ad74-41740393bece', '7f943d67-1e76-5594-b3be-f0670c1072bc', 'ADI-ENT26-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('ADI-ENT26-AZU-L', '184f8386-11c3-4b18-b37b-f42974ad528b', '8be3020b-0f9c-5343-ad74-41740393bece', 'd756023d-9a33-5fab-af73-9d386b498f21', 'ADI-ENT26-BASE', 'VARIANTE', '0.205'::numeric, '34'::numeric, '24'::numeric, '3'::numeric),
  ('ADI-ENT26-BLA-S', '3b900f1a-e7d6-4414-9377-75154fea9f53', '8be3020b-0f9c-5343-ad74-41740393bece', 'eecf0794-1eea-5cf3-83a6-42795902726e', 'ADI-ENT26-BASE', 'VARIANTE', '0.17'::numeric, '30'::numeric, '22'::numeric, '2.5'::numeric),
  ('ADI-ENT26-BLA-M', '6cc310b7-7a64-4203-a779-994e0060f570', '8be3020b-0f9c-5343-ad74-41740393bece', '0cd5c7bf-363b-5501-b237-d6ff14814f67', 'ADI-ENT26-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('ADI-ENT26-BLA-L', 'd972b913-90e8-4660-94db-323f5993c782', '8be3020b-0f9c-5343-ad74-41740393bece', '9a4bb6a1-1e68-5d32-b861-51a1f20ba8f3', 'ADI-ENT26-BASE', 'VARIANTE', '0.205'::numeric, '34'::numeric, '24'::numeric, '3'::numeric),
  ('ADI-MESSI-JI8291-05', '5e226593-924b-4ee2-9d4b-0eac22c2616e', 'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', NULL, 'ADI-MESSI-JI8291-05', 'PRODUCTO_SIMPLE', '0.42'::numeric, '22'::numeric, '22'::numeric, '22'::numeric),
  ('ADI-PRED-IG7760-MUL-38', '4fbdd519-3dd7-4512-aa84-3ad3a1d4a987', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '840b28a1-46fc-5e3a-a176-cb150e25e8a7', 'ADI-PRED-IG7760-BASE', 'VARIANTE', '0.82'::numeric, '32'::numeric, '20'::numeric, '12'::numeric),
  ('ADI-PRED-IG7760-MUL-40', 'fea91919-d38f-4a45-9584-e2fc8e4d4e5b', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '864ea99c-a2d8-5906-b93f-ac5300fdfa3e', 'ADI-PRED-IG7760-BASE', 'VARIANTE', '0.87'::numeric, '34'::numeric, '22'::numeric, '12.5'::numeric),
  ('ADI-PRED-IG7760-MUL-42', '9f1b8f46-f568-45e7-9e11-6280feb48445', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '2cc6f948-5d34-5ed1-9bfc-c5ff9f39d63f', 'ADI-PRED-IG7760-BASE', 'VARIANTE', '0.93'::numeric, '35'::numeric, '23'::numeric, '13'::numeric),
  ('ADI-PRED-IG7760-MUL-43', '61578bef-98ea-433b-99fe-0bffc23b2ed1', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '284276f3-e0ab-5ffb-a394-3664374aa09b', 'ADI-PRED-IG7760-BASE', 'VARIANTE', '0.97'::numeric, '36'::numeric, '24'::numeric, '13'::numeric),
  ('ADI-RF3-GRI-38', '5fbdfbb6-2c5d-44fb-a896-27e2e44405c9', 'abaf9767-7431-9b50-495c-aeb880dc3055', '532ffc0d-d209-2b48-6506-e94f62026e17', 'ADI-RF3-BASE', 'VARIANTE', '0.85'::numeric, '32'::numeric, '20'::numeric, '12'::numeric),
  ('ADI-RF3-GRI-39', '43ba45b9-c161-4387-a1c9-db2b1f17afc2', 'abaf9767-7431-9b50-495c-aeb880dc3055', 'f1bd0fad-819b-b0fd-b5b1-53bb36fd468f', 'ADI-RF3-BASE', 'VARIANTE', '0.88'::numeric, '33'::numeric, '21'::numeric, '12'::numeric),
  ('ADI-RUNX-JD9558-NEG-EU3436', 'd308eb05-3ca5-4c6c-845c-8bcde8415516', '457f749f-2aaf-56a3-9776-a95df5d24d59', '629792a7-60fb-57f5-9747-f3b54cf8b553', 'ADI-RUNX-JD9558-BASE', 'VARIANTE', '0.08'::numeric, '20'::numeric, '12'::numeric, '3'::numeric),
  ('ADI-RUNX-JD9558-NEG-EU3739', 'c6150f1e-6a0f-4d2e-8694-70a2bb169b22', '457f749f-2aaf-56a3-9776-a95df5d24d59', 'b1d488a5-fba8-5fd4-90b7-b7440cd59a40', 'ADI-RUNX-JD9558-BASE', 'VARIANTE', '0.09'::numeric, '21'::numeric, '13'::numeric, '3'::numeric),
  ('ADI-RUNX-JD9558-NEG-EU4042', 'bf316fa4-e011-4b2b-b322-b801cd0dfe78', '457f749f-2aaf-56a3-9776-a95df5d24d59', '677f8fcc-caaf-5cc9-a060-c7756d5ab1c2', 'ADI-RUNX-JD9558-BASE', 'VARIANTE', '0.1'::numeric, '22'::numeric, '14'::numeric, '3'::numeric),
  ('ADI-SQUA25-JG5832-NEG-S', 'eb4eb0a0-579b-4373-9865-f6a1cc737fbe', '59022191-2fb1-5db3-903f-05f8e6be19b1', '91f677b4-3ee9-539d-9ed9-6804f8922a26', 'ADI-SQUA25-JG5832-BASE', 'VARIANTE', '0.17'::numeric, '30'::numeric, '22'::numeric, '2.5'::numeric),
  ('ADI-SQUA25-JG5832-NEG-M', 'fb57e5d6-5478-469c-a7b8-42ec14c7bb47', '59022191-2fb1-5db3-903f-05f8e6be19b1', 'ab8ae29e-84d5-58fb-b237-c07bc618386c', 'ADI-SQUA25-JG5832-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('ADI-SQUA25-JG5832-NEG-L', '3e05d962-d3aa-4e06-9b91-d1fce3b3da4b', '59022191-2fb1-5db3-903f-05f8e6be19b1', '30723507-bc26-53e2-b3e1-e2a03124445d', 'ADI-SQUA25-JG5832-BASE', 'VARIANTE', '0.205'::numeric, '34'::numeric, '24'::numeric, '3'::numeric),
  ('ADI-SQUA25-JH3407-AZU-S', '4061ac24-5c79-428b-936f-aa09082660cd', '536287fd-b2fa-5c1d-a086-7db284725485', '0d6a3d1f-50fc-5e74-b50b-3844d2f3bcfa', 'ADI-SQUA25-JH3407-BASE', 'VARIANTE', '0.145'::numeric, '27'::numeric, '20'::numeric, '3'::numeric),
  ('ADI-SQUA25-JH3407-AZU-M', 'c357588a-6309-4f98-85b4-be134c2d3344', '536287fd-b2fa-5c1d-a086-7db284725485', '62ca791d-dd40-5846-8105-3650730c08cf', 'ADI-SQUA25-JH3407-BASE', 'VARIANTE', '0.165'::numeric, '29'::numeric, '21'::numeric, '3.5'::numeric),
  ('ADI-SQUA25-JH3407-AZU-L', 'e0d8eb63-e96b-4d0f-8329-5816b1ac2743', '536287fd-b2fa-5c1d-a086-7db284725485', '161d02f4-1913-51c7-aa37-140c6fef4bca', 'ADI-SQUA25-JH3407-BASE', 'VARIANTE', '0.185'::numeric, '31'::numeric, '22'::numeric, '4'::numeric),
  ('NIK-ACADEMY-HV4386-05', '0a2c61dd-2a1c-4078-9bd3-594026e415e2', '2ee6399e-2333-5916-847b-f6d2a0f03527', NULL, 'NIK-ACADEMY-HV4386-05', 'PRODUCTO_SIMPLE', '0.43'::numeric, '22'::numeric, '22'::numeric, '22'::numeric),
  ('NIK-EVP-FQ0327-NEG-EU3438', '14ca68bf-486c-428e-92cb-66d9aa884f02', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', '968ec637-15e1-549c-b8ba-da77ed375edc', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.08'::numeric, '20'::numeric, '12'::numeric, '3'::numeric),
  ('NIK-EVP-FQ0327-NEG-EU3842', '2b04fca8-2f47-480b-9109-2e1c4cde3999', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', '7f8c7bf8-3086-5849-a21f-722bb13bff1c', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.09'::numeric, '21'::numeric, '13'::numeric, '3'::numeric),
  ('NIK-EVP-FQ0327-NEG-EU4246', 'afec6d91-f830-4063-96fa-741f912d7a8a', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', '73829aef-a02c-5555-82f1-03a495d44ced', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.1'::numeric, '22'::numeric, '14'::numeric, '3'::numeric),
  ('NIK-EVP-FQ0327-BLA-EU3438', 'f3e13e01-d48a-4f60-9fa1-c68502cb8903', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', '1c995251-cf8c-55e2-878a-ea83f9f4b351', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.08'::numeric, '20'::numeric, '12'::numeric, '3'::numeric),
  ('NIK-EVP-FQ0327-BLA-EU3842', 'd8a4059a-550a-4599-ac59-c976c08f6c1e', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'e8a0b20b-a6fd-5a78-9e6b-8199f32742c2', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.09'::numeric, '21'::numeric, '13'::numeric, '3'::numeric),
  ('NIK-EVP-FQ0327-BLA-EU4246', 'aa622e76-f1b9-4503-bc12-1d3572185e14', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'bc260f04-d0c1-57d6-862a-6d7ae44c74ff', 'NIK-EVP-FQ0327-BASE', 'VARIANTE', '0.1'::numeric, '22'::numeric, '14'::numeric, '3'::numeric),
  ('NIK-PARK3-M-BV6855-NEG-S', '5282426e-61f6-4168-8d61-2b7fd79ee2c0', 'b8224b4b-8268-57e4-9d61-d4424828544c', 'bd42a0bd-dd7e-595c-8d1d-7afabc4ed049', 'NIK-PARK3-M-BV6855-BASE', 'VARIANTE', '0.145'::numeric, '27'::numeric, '20'::numeric, '3'::numeric),
  ('NIK-PARK3-M-BV6855-NEG-M', '8cd5c256-775a-4470-8fe4-70e48fca848c', 'b8224b4b-8268-57e4-9d61-d4424828544c', '4ef2fc98-fe62-5d4c-b050-5ad312c088e0', 'NIK-PARK3-M-BV6855-BASE', 'VARIANTE', '0.165'::numeric, '29'::numeric, '21'::numeric, '3.5'::numeric),
  ('NIK-PARK3-M-BV6855-NEG-L', '2a770e47-3ee9-45c6-a8ee-7f82fc168aad', 'b8224b4b-8268-57e4-9d61-d4424828544c', 'df53883d-2875-5a71-afe8-1f4097e8b234', 'NIK-PARK3-M-BV6855-BASE', 'VARIANTE', '0.185'::numeric, '31'::numeric, '22'::numeric, '4'::numeric),
  ('NIK-PARK3-W-BV6860-NEG-XS', 'fab810b3-cd46-43b8-b0e3-b0e562ce6354', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '923d14cc-c3d8-53b2-b0c5-57568e9f1abd', 'NIK-PARK3-W-BV6860-BASE', 'VARIANTE', '0.13'::numeric, '25'::numeric, '18'::numeric, '3'::numeric),
  ('NIK-PARK3-W-BV6860-NEG-S', '91b99924-f0b5-473b-b1f7-c38e22f393a0', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', 'e3cd5843-307f-576a-b721-2f58d7df3fdc', 'NIK-PARK3-W-BV6860-BASE', 'VARIANTE', '0.145'::numeric, '27'::numeric, '20'::numeric, '3'::numeric),
  ('NIK-PARK3-W-BV6860-NEG-M', 'c074170e-4fe9-47ac-8ba0-a734da153cf9', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', 'a6a0d134-e4a9-58ba-b512-37076fc99a33', 'NIK-PARK3-W-BV6860-BASE', 'VARIANTE', '0.165'::numeric, '29'::numeric, '21'::numeric, '3.5'::numeric),
  ('NIK-PARK3-W-BV6860-NEG-L', '77e10e3d-3d74-45a1-ac7e-8d62374c04ba', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '29cf5cee-af27-5da0-aaba-c8f4f6712101', 'NIK-PARK3-W-BV6860-BASE', 'VARIANTE', '0.185'::numeric, '31'::numeric, '22'::numeric, '4'::numeric),
  ('NIK-PARK3-W-BV6860-NEG-XL', '448631bc-619a-4588-a10a-f410ad75cc76', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '909bf47b-9242-5955-b2ed-03adf2922580', 'NIK-PARK3-W-BV6860-BASE', 'VARIANTE', '0.21'::numeric, '33'::numeric, '23'::numeric, '4'::numeric),
  ('NIK-PARK7-BV6708-NEG-S', 'aa979ff0-574f-413c-8cca-cf615592f7be', '79c03413-cf12-56fe-bcd1-32e45cf40221', 'f3890276-9ad2-545b-948b-484f5ed1495b', 'NIK-PARK7-BV6708-BASE', 'VARIANTE', '0.17'::numeric, '30'::numeric, '22'::numeric, '2.5'::numeric),
  ('NIK-PARK7-BV6708-NEG-M', 'e416d7cd-b3dd-47ae-bf89-6ec9faeabfdc', '79c03413-cf12-56fe-bcd1-32e45cf40221', '033875cd-b8de-50d6-bb3d-49e98e146178', 'NIK-PARK7-BV6708-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('NIK-PARK7-BV6708-NEG-L', '41288821-165f-4c22-9373-97be7cc15dd9', '79c03413-cf12-56fe-bcd1-32e45cf40221', '96945dfc-af18-5da8-8e6e-c49b8c673ed2', 'NIK-PARK7-BV6708-BASE', 'VARIANTE', '0.205'::numeric, '34'::numeric, '24'::numeric, '3'::numeric),
  ('NIK-PITCH-05', 'eb4d35ac-41c0-4e6e-a059-5dc35d850a57', 'abab3400-46eb-58f7-78d5-8204418b60d9', NULL, 'NIK-PITCH-05', 'PRODUCTO_SIMPLE', '0.43'::numeric, '22'::numeric, '22'::numeric, '22'::numeric),
  ('NIK-REV7-NEG-41', '0265b4f7-4ca3-455c-a416-de32eb341494', 'fedeecfb-c7f5-56cf-c31b-9cdf10b47058', '9df1c63b-f475-5ea4-fab4-cf2bb36120ae', 'NIK-REV7-BASE', 'VARIANTE', '0.95'::numeric, '34'::numeric, '22'::numeric, '13'::numeric),
  ('NIK-REV7-NEG-42', '0ece3ef9-cede-4159-85b5-1768b63ab748', 'fedeecfb-c7f5-56cf-c31b-9cdf10b47058', '437853de-9b59-6b0b-5b26-ccd51e2e062b', 'NIK-REV7-BASE', 'VARIANTE', '0.98'::numeric, '35'::numeric, '23'::numeric, '13'::numeric),
  ('PUM-ORBITA-084641-05', '91286dbf-c52d-426e-bf6a-d71457156341', '8111028a-4a0e-5cb1-a4b8-8095cc098a83', NULL, 'PUM-ORBITA-084641-05', 'PRODUCTO_SIMPLE', '0.43'::numeric, '22'::numeric, '22'::numeric, '22'::numeric),
  ('PUM-SC-782244-BLA-S', '2d6881c1-928d-4f57-b1e2-42000169dcf4', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '7a594c35-880e-5682-b282-a3cc01d8854c', 'PUM-SC-782244-BASE', 'VARIANTE', '0.17'::numeric, '30'::numeric, '22'::numeric, '2.5'::numeric),
  ('PUM-SC-782244-BLA-M', '8b314e37-b2c1-4115-9b0f-f23af5f06881', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', 'd82aafc7-3257-5bc8-8093-c9139562e910', 'PUM-SC-782244-BASE', 'VARIANTE', '0.185'::numeric, '32'::numeric, '23'::numeric, '3'::numeric),
  ('PUM-SC-782244-BLA-L', '2959ed50-1360-4368-aa4b-5f2cad69a5ea', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '61600bf0-bb76-5b31-9c9b-1df55ddd3471', 'PUM-SC-782244-BASE', 'VARIANTE', '0.205'::numeric, '34'::numeric, '24'::numeric, '3'::numeric),
  ('PUM-ULP-NEG-42', '72c5c4f2-f9cb-40c1-a017-b48a0a4b79cb', '08f2c67c-d79a-3e61-c7ee-0262885f68e7', '9ba54bda-2686-8e3b-41c6-68b6efa16338', 'PUM-ULP-BASE', 'VARIANTE', '0.93'::numeric, '35'::numeric, '23'::numeric, '13'::numeric),
  ('UA-TECH20-1326413-NEG-S', 'ccf4e328-f61d-42e3-b5d3-94d33c84bfd5', '858ed760-beb9-5fdf-aa6d-b6b543b162d2', 'b6bdb52f-a904-56b8-a863-f23aea89ffc6', 'UA-TECH20-1326413-BASE', 'VARIANTE', '0.125'::numeric, '28'::numeric, '19'::numeric, '1.5'::numeric),
  ('UA-TECH20-1326413-NEG-M', '4f527966-baef-4f82-baca-c37610252713', '858ed760-beb9-5fdf-aa6d-b6b543b162d2', 'b271319c-457a-58c5-bbbf-62280abd0803', 'UA-TECH20-1326413-BASE', 'VARIANTE', '0.138'::numeric, '30'::numeric, '20'::numeric, '1.6'::numeric),
  ('UA-TECH20-1326413-NEG-L', 'eebd5a28-9329-4eb0-a8b3-e12b4e9d6a22', '858ed760-beb9-5fdf-aa6d-b6b543b162d2', '09875bf7-7cbd-5f6d-92e9-47d78e8763a6', 'UA-TECH20-1326413-BASE', 'VARIANTE', '0.149'::numeric, '31'::numeric, '20.5'::numeric, '1.7'::numeric)
) AS m(sku, sku_identity_id, product_id, variant_id, sku_base, tipo_unidad, peso_kg, largo_cm, ancho_cm, alto_cm) LOOP
    IF NOT (m.peso_kg IS NOT NULL AND m.peso_kg>0 AND m.peso_kg NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND m.largo_cm IS NOT NULL AND m.largo_cm>0 AND m.largo_cm NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND m.ancho_cm IS NOT NULL AND m.ancho_cm>0 AND m.ancho_cm NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND m.alto_cm IS NOT NULL AND m.alto_cm>0 AND m.alto_cm NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)) THEN RAISE EXCEPTION 'DATA002_INVALID_PROFILE_MEASURE: %',m.sku; END IF;
    IF NOT (EXISTS (SELECT 1 FROM catalog.sku_identity s
    JOIN catalog.products p ON p.id=m.product_id::uuid
    LEFT JOIN catalog.variants v ON v.id=m.variant_id::uuid
    WHERE s.id=m.sku_identity_id::uuid AND s.sku=m.sku AND p.sku_base=m.sku_base AND (
      (m.tipo_unidad='PRODUCTO_SIMPLE' AND NOT p.tiene_variantes AND m.variant_id IS NULL
        AND s.product_id=p.id AND s.variant_id IS NULL AND p.sku_base=m.sku)
      OR (m.tipo_unidad='VARIANTE' AND p.tiene_variantes AND v.product_id=p.id AND v.sku=m.sku
        AND s.variant_id=v.id AND s.product_id IS NULL)))) THEN RAISE EXCEPTION 'DATA002_PROFILE_OWNER_CONFLICT: %',m.sku; END IF;
    IF EXISTS (SELECT 1 FROM catalog.sku_physical_profiles f WHERE f.sku_identity_id=m.sku_identity_id::uuid) AND NOT (EXISTS (SELECT 1 FROM catalog.sku_physical_profiles f WHERE f.sku_identity_id=m.sku_identity_id::uuid AND f.peso_kg IS NOT DISTINCT FROM m.peso_kg AND f.largo_cm IS NOT DISTINCT FROM m.largo_cm AND f.ancho_cm IS NOT DISTINCT FROM m.ancho_cm AND f.alto_cm IS NOT DISTINCT FROM m.alto_cm)) THEN RAISE EXCEPTION 'DATA002_PROFILE_CONFLICT: %',m.sku; END IF;
    INSERT INTO catalog.sku_physical_profiles(sku_identity_id,peso_kg,largo_cm,ancho_cm,alto_cm)
      SELECT m.sku_identity_id::uuid,m.peso_kg,m.largo_cm,m.ancho_cm,m.alto_cm WHERE NOT (EXISTS (SELECT 1 FROM catalog.sku_physical_profiles f WHERE f.sku_identity_id=m.sku_identity_id::uuid));
    IF NOT (EXISTS (SELECT 1 FROM catalog.sku_physical_profiles f WHERE f.sku_identity_id=m.sku_identity_id::uuid AND f.peso_kg IS NOT DISTINCT FROM m.peso_kg AND f.largo_cm IS NOT DISTINCT FROM m.largo_cm AND f.ancho_cm IS NOT DISTINCT FROM m.ancho_cm AND f.alto_cm IS NOT DISTINCT FROM m.alto_cm)) THEN RAISE EXCEPTION 'DATA002_PROFILE_POSTCHECK: %',m.sku; END IF;
  END LOOP;
  IF before_state IS DISTINCT FROM (SELECT jsonb_build_object('products',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.products t),
'variants',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variants t),
'sku_identity',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.sku_identity t),
'product_images',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.product_images t),
'variant_images',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variant_images t),
'product_attribute_values',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.product_attribute_values t),
'variant_attribute_values',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.variant_attribute_values t),
'product_identifying_characteristics',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.product_identifying_characteristics t),
'activation_checks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.activation_checks t),
'master_barriers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.master_barriers t),
'outbox',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.outbox t),
'inbox',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.inbox t))) THEN RAISE EXCEPTION 'DATA002_PROFILE_UNEXPECTED_MUTATION'; END IF;
END
$profiles$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;

SELECT set_config('catalog.data002_execution_context',jsonb_build_object('executed_at',clock_timestamp(),'role',current_user,'session_user',session_user,'backend_pid',pg_backend_pid(),'same_backend',current_setting('catalog.data002_execution_backend')=pg_backend_pid()::text,'physical_semantics',current_setting('catalog.data002_physical_semantics',true))::text,false);
RESET catalog.data002_physical_semantics;
RESET ROLE;
SELECT current_setting('catalog.data002_execution_context')::jsonb AS execution;
