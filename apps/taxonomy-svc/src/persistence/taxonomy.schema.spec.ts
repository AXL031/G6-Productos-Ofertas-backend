import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  categorias,
  categorySeo,
  esquemaTaxonomia,
  marcas,
  operacionesBaja,
  caracteristicas,
  valoresCaracteristica,
  tiposProducto,
  asociacionesTipoCaracteristica,
} from './taxonomy.schema.js';

describe('taxonomy.schema (#35)', () => {
  const db = drizzle.mock({ schema: esquemaTaxonomia });

  it('mapea las entidades oficiales y sus relaciones exclusivamente en taxonomy', () => {
    for (const [table, name, foreignKeys] of [
      [caracteristicas, 'characteristics', 0],
      [valoresCaracteristica, 'characteristic_values', 1],
      [tiposProducto, 'product_types', 0],
      [asociacionesTipoCaracteristica, 'product_type_characteristics', 2],
    ] as const) {
      const config = getTableConfig(table);
      expect(config.schema).toBe('taxonomy');
      expect(config.name).toBe(name);
      expect(config.foreignKeys).toHaveLength(foreignKeys);
      for (const fk of config.foreignKeys)
        expect(getTableConfig(fk.reference().foreignTable).schema).toBe(
          'taxonomy',
        );
    }
    expect(
      getTableConfig(asociacionesTipoCaracteristica).columns.map((c) => c.name),
    ).not.toContain('taxonomy_version');
    expect(getTableConfig(tiposProducto).columns.map((c) => c.name)).toContain(
      'schema_version',
    );
  });

  it('mapea SEO de categoría con unicidad y FK solo al esquema propio', () => {
    const tabla = getTableConfig(categorySeo);
    expect(tabla.schema).toBe('taxonomy');
    expect(tabla.name).toBe('category_seo');
    expect(tabla.uniqueConstraints.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        'uq_category_seo_categoria',
        'uq_category_seo_slug',
      ]),
    );
    expect(tabla.foreignKeys).toHaveLength(1);
    expect(
      getTableConfig(tabla.foreignKeys[0]!.reference().foreignTable).schema,
    ).toBe('taxonomy');
  });

  it('mapea taxonomy.categories con nombres snake_case', () => {
    const { sql } = db
      .select({
        id: categorias.id,
        padre: categorias.categoriaPadreId,
        version: categorias.taxonomyVersion,
        creado: categorias.createdAt,
      })
      .from(categorias)
      .where(eq(categorias.estado, 'ACTIVO'))
      .toSQL();

    expect(sql).toContain('"taxonomy"."categories"');
    expect(sql).toContain('"categoria_padre_id"');
    expect(sql).toContain('"taxonomy_version"');
    expect(sql).toContain('"created_at"');
    expect(sql).toContain('"estado"');
  });

  it('mapea taxonomy.brands incluida la columna generada y char(2)', () => {
    const { sql } = db
      .select({
        normalizado: marcas.nombreNormalizado,
        pais: marcas.paisOrigenIso,
        logo: marcas.logoUrl,
      })
      .from(marcas)
      .toSQL();

    expect(sql).toContain('"taxonomy"."brands"');
    expect(sql).toContain('"nombre_normalizado"');
    expect(sql).toContain('"pais_origen_iso"');
    expect(sql).toContain('"logo_url"');
  });

  it('declara el enum taxonomy.estado_entidad con sus tres valores', () => {
    expect(esquemaTaxonomia.estadoEntidad.enumName).toBe('estado_entidad');
    expect(esquemaTaxonomia.estadoEntidad.schema).toBe('taxonomy');
    expect(esquemaTaxonomia.estadoEntidad.enumValues).toEqual([
      'ACTIVO',
      'INACTIVO',
      'PENDING_DEACTIVATION',
    ]);
  });

  it('mapea la tabla histórica de operaciones sin inventar columnas', () => {
    const tabla = getTableConfig(operacionesBaja);
    expect(tabla.schema).toBe('taxonomy');
    expect(tabla.name).toBe('master_deactivation_operations');
    expect(tabla.columns.map((columna) => columna.name)).toEqual([
      'id',
      'operation_id',
      'entity_type',
      'entity_id',
      'status',
      'reason',
      'correlation_id',
      'created_at',
      'updated_at',
    ]);
    expect(
      tabla.uniqueConstraints.map((constraint) => constraint.name),
    ).toContain('uq_mdo_operation_id');
    expect(tabla.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'ck_mdo_operation_id_not_nil',
        'ck_mdo_correlation_id_not_nil',
      ]),
    );
  });
});
