-- Solo lectura; uso administrativo de auditoría, nunca dependencia runtime entre schemas.
SELECT jsonb_build_object(
  'audited_at',now(),
  'products',(SELECT jsonb_agg(p ORDER BY id) FROM catalog.products p),
  'variants',(SELECT jsonb_agg(v ORDER BY id) FROM catalog.variants v),
  'identities',(SELECT jsonb_agg(s ORDER BY sku) FROM catalog.sku_identity s),
  'product_images',(SELECT jsonb_agg(i) FROM catalog.product_images i),
  'variant_images',(SELECT jsonb_agg(i) FROM catalog.variant_images i),
  'profiles',(SELECT jsonb_agg(i) FROM catalog.sku_physical_profiles i),
  'activation_checks',(SELECT jsonb_agg(i) FROM catalog.activation_checks i),
  'migrations',(SELECT jsonb_agg(i) FROM catalog.schema_migrations i),
  'storage',(SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'metadata',metadata)) FROM storage.objects WHERE bucket_id='catalog-products'),
  'bucket',(SELECT jsonb_agg(jsonb_build_object('id',id,'public',public)) FROM storage.buckets WHERE id='catalog-products'),
  'product_attributes',(SELECT jsonb_agg(a) FROM catalog.product_attribute_values a),
  'variant_attributes',(SELECT jsonb_agg(a) FROM catalog.variant_attribute_values a),
  'identifying_characteristics',(SELECT jsonb_agg(a) FROM catalog.product_identifying_characteristics a),
  'brands',(SELECT jsonb_agg(a) FROM taxonomy.brands a),
  'types',(SELECT jsonb_agg(a) FROM taxonomy.product_types a),
  'categories',(SELECT jsonb_agg(a) FROM taxonomy.categories a),
  'characteristics',(SELECT jsonb_agg(a) FROM taxonomy.characteristics a),
  'values',(SELECT jsonb_agg(a) FROM taxonomy.characteristic_values a),
  'associations',(SELECT jsonb_agg(a) FROM taxonomy.product_type_characteristics a)
) AS audit;
