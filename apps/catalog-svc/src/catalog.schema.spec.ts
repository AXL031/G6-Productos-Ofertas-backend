import { getTableConfig } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import {
  activationChecks,
  catalogSchema,
  estadoProducto,
  estadoVariante,
  inbox,
  masterBarriers,
  outbox,
  productAttributes,
  productIdentifyingCharacteristics,
  productImages,
  products,
  skuIdentity,
  skuPhysicalProfiles,
  variantAttributes,
  variantImages,
  variants,
} from './catalog.schema.js';

describe('catalog Drizzle schema', () => {
  // This immutable fixture is copied from Docs, not generated from Drizzle.
  const migration = readFileSync(
    new URL('../test/fixtures/0001_create_catalog.sql', import.meta.url),
    'utf8',
  );

  it.each(Object.values(catalogSchema).map(getTableConfig))(
    'matches every column and named constraint in the official $name table',
    (table) => {
      const definition = new RegExp(
        `CREATE TABLE catalog\\.${table.name} \\(([\\s\\S]*?)\\n\\);`,
      ).exec(migration)?.[1];
      expect(definition).toBeDefined();
      if (!definition) throw new Error('Missing official table definition');
      const columns = [
        ...definition.matchAll(
          /^    (\w+) (uuid|text|boolean|bigint|integer|jsonb|numeric|timestamptz|catalog\.estado_\w+)([^\n]*)/gm,
        ),
      ].map(([, name, type, modifiers]) => ({
        name,
        type: type
          .replace('catalog.', '')
          .replace('timestamptz', 'timestamp with time zone'),
        notNull: modifiers.includes('NOT NULL'),
        hasDefault: modifiers.includes('DEFAULT'),
      }));
      expect(
        table.columns
          .filter((column) => column.name !== 'publicado_alguna_vez')
          .map((column) => ({
            name: column.name,
            type: column.getSQLType(),
            notNull: column.notNull,
            hasDefault: column.hasDefault,
          })),
      ).toEqual(columns);
      const constraints = [...definition.matchAll(/CONSTRAINT (\w+)/g)]
        .map(([, name]) => name)
        .sort();
      expect(
        [
          ...table.primaryKeys.map((key) => key.getName()),
          ...table.foreignKeys.map((key) => key.getName()),
          ...table.uniqueConstraints.map((key) => key.name),
          ...table.checks.map((constraint) => constraint.name),
        ].sort(),
      ).toEqual(constraints);
    },
  );

  it('maps exactly the 13 tables in the physical model to catalog', () => {
    const tables = Object.values(catalogSchema).map(getTableConfig);
    expect(tables).toHaveLength(13);
    expect(tables.map((table) => table.name).sort()).toEqual(
      [
        'products',
        'variants',
        'sku_identity',
        'product_images',
        'variant_images',
        'product_attribute_values',
        'variant_attribute_values',
        'product_identifying_characteristics',
        'sku_physical_profiles',
        'activation_checks',
        'master_barriers',
        'outbox',
        'inbox',
      ].sort(),
    );
    expect(tables.every((table) => table.schema === 'catalog')).toBe(true);
    const columnsByTable = Object.fromEntries(
      tables.map((table) => [
        table.name,
        table.columns.map((column) => column.name),
      ]),
    );
    expect(columnsByTable).toEqual({
      products: [
        'id',
        'nombre',
        'descripcion',
        'categoria_id',
        'tipo_producto_id',
        'marca_id',
        'sku_base',
        'slug',
        'tiene_variantes',
        'estado',
        'publicado_alguna_vez',
        'catalog_version',
        'created_at',
        'updated_at',
      ],
      variants: [
        'id',
        'product_id',
        'sku',
        'identifying_key',
        'estado',
        'catalog_version',
        'created_at',
        'updated_at',
      ],
      sku_identity: ['id', 'sku', 'product_id', 'variant_id', 'created_at'],
      product_images: [
        'id',
        'product_id',
        'url',
        'principal',
        'posicion',
        'created_at',
        'updated_at',
      ],
      variant_images: [
        'id',
        'variant_id',
        'url',
        'posicion',
        'created_at',
        'updated_at',
      ],
      product_attribute_values: [
        'id',
        'product_id',
        'caracteristica_id',
        'nombre_snapshot',
        'valor_id',
        'valor',
        'created_at',
        'updated_at',
      ],
      variant_attribute_values: [
        'id',
        'variant_id',
        'caracteristica_id',
        'nombre_snapshot',
        'valor_id',
        'valor',
        'es_identificador',
        'created_at',
        'updated_at',
      ],
      product_identifying_characteristics: [
        'id',
        'product_id',
        'caracteristica_id',
        'created_at',
        'updated_at',
      ],
      sku_physical_profiles: [
        'id',
        'sku_identity_id',
        'peso_kg',
        'largo_cm',
        'ancho_cm',
        'alto_cm',
        'created_at',
        'updated_at',
      ],
      activation_checks: [
        'id',
        'product_id',
        'variant_id',
        'sku',
        'dependency',
        'operation_id',
        'correlation_id',
        'request_payload',
        'state',
        'result_payload',
        'result_message_id',
        'created_at',
        'updated_at',
      ],
      master_barriers: [
        'id',
        'master_type',
        'master_id',
        'operation_id',
        'is_blocking',
        'source_version',
        'payload',
        'created_at',
        'updated_at',
      ],
      outbox: [
        'id',
        'message_id',
        'event_name',
        'kind',
        'schema_version',
        'correlation_id',
        'causation_id',
        'operation_id',
        'occurred_at',
        'payload',
        'published_at',
        'attempts',
        'last_error',
        'created_at',
      ],
      inbox: [
        'id',
        'message_id',
        'handler',
        'event_name',
        'correlation_id',
        'operation_id',
        'payload',
        'result',
        'processed_at',
        'created_at',
      ],
    });
  });

  it('preserves native enums, arbitrary precision numeric and bigint versions', () => {
    expect(
      getTableConfig(products).columns.map((column) => column.name),
    ).toContain('catalog_version');
    expect(
      getTableConfig(products)
        .columns.find((column) => column.name === 'catalog_version')
        ?.getSQLType(),
    ).toBe('bigint');
    expect(
      getTableConfig(skuPhysicalProfiles)
        .columns.find((column) => column.name === 'peso_kg')
        ?.getSQLType(),
    ).toBe('numeric');
    expect(estadoProducto.enumValues).toEqual([
      'BORRADOR',
      'ACTIVO',
      'INACTIVO',
    ]);
    expect(estadoVariante.enumValues).toEqual([
      'BORRADOR',
      'ACTIVA',
      'INACTIVA',
    ]);
    expect(estadoProducto.enumName).toBe('estado_producto');
    expect(estadoProducto.schema).toBe('catalog');
    expect(estadoVariante.enumName).toBe('estado_variante');
    expect(estadoVariante.schema).toBe('catalog');
  });

  it('retains key uniqueness and ownership constraints', () => {
    const skuKeys = getTableConfig(skuIdentity).uniqueConstraints.map(
      (key) => key.name,
    );
    expect(skuKeys).toContain('uq_sku_identity_sku');
    const combinations = getTableConfig(variants).uniqueConstraints.map(
      (key) => key.name,
    );
    expect(combinations).toContain('uq_variants_product_combination');
    expect(
      getTableConfig(activationChecks).foreignKeys.map((key) => key.getName()),
    ).toContain('fk_activation_checks_variant_product');
    expect(
      getTableConfig(productImages).foreignKeys.map((key) => key.getName()),
    ).toContain('fk_product_images_product_id');
    expect(getTableConfig(variantImages).name).toBe('variant_images');
    expect(getTableConfig(productAttributes).name).toBe(
      'product_attribute_values',
    );
    expect(getTableConfig(variantAttributes).name).toBe(
      'variant_attribute_values',
    );
    expect(getTableConfig(productIdentifyingCharacteristics).name).toBe(
      'product_identifying_characteristics',
    );
    expect(getTableConfig(masterBarriers).name).toBe('master_barriers');
    expect(
      getTableConfig(outbox).columns.map((column) => column.name),
    ).toContain('published_at');
    expect(
      getTableConfig(inbox).uniqueConstraints.map((key) => key.name),
    ).toContain('uq_inbox_message_handler');
  });
});
