import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';

export type TipoProductoAdmin = {
  tipoProductoId: string;
  nombre: string;
  estado: 'ACTIVO' | 'INACTIVO' | 'PENDING_DEACTIVATION';
  schemaVersion: number;
};

function mapear(fila: Record<string, unknown>): TipoProductoAdmin {
  const version = Number(fila.schema_version);
  if (
    typeof fila.id !== 'string' ||
    typeof fila.nombre !== 'string' ||
    (fila.estado !== 'ACTIVO' &&
      fila.estado !== 'INACTIVO' &&
      fila.estado !== 'PENDING_DEACTIVATION') ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw new Error('TIPO_PRODUCTO_INVALIDO');
  return {
    tipoProductoId: fila.id,
    nombre: fila.nombre,
    estado: fila.estado,
    schemaVersion: version,
  };
}

@Injectable()
export class ProductTypeService {
  constructor(private readonly database: Database) {}

  async listar(
    pagina: number,
    tamanio: number,
    estado?: string,
  ): Promise<{
    items: TipoProductoAdmin[];
    meta: {
      pagina: number;
      tamanio: number;
      total: number;
      totalPaginas: number;
    };
  }> {
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const condicion = estado
          ? sql`WHERE estado = ${estado}::taxonomy.estado_entidad`
          : sql`WHERE estado IN ('ACTIVO', 'INACTIVO')`;
        const totalResult = await tx.execute(
          sql`SELECT count(*)::int AS total FROM taxonomy.product_types ${condicion}`,
        );
        const total = Number(totalResult.rows[0]?.total ?? 0);
        const filas = await tx.execute(
          sql`SELECT id, nombre, estado, schema_version FROM taxonomy.product_types ${condicion} ORDER BY nombre, id LIMIT ${tamanio} OFFSET ${(pagina - 1) * tamanio}`,
        );
        return {
          items: filas.rows.map(mapear),
          meta: {
            pagina,
            tamanio,
            total,
            totalPaginas: Math.ceil(total / tamanio),
          },
        };
      }),
    );
  }

  async obtener(id: string): Promise<TipoProductoAdmin | null> {
    if (!esUuid(id)) return null;
    return this.database.read(async (db) => {
      const resultado =
        await db.execute(sql`SELECT id, nombre, estado, schema_version
        FROM taxonomy.product_types WHERE id = ${id}::uuid`);
      return resultado.rows[0] ? mapear(resultado.rows[0]) : null;
    });
  }

  async obtenerEsquema(id: string): Promise<{
    tipoProducto: TipoProductoAdmin;
    caracteristicas: unknown[];
    schemaVersion: number;
  } | null> {
    if (!esUuid(id)) return null;
    return this.database.read(async (db) => {
      const result =
        await db.execute(sql`SELECT t.id, t.nombre, t.estado, t.schema_version,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'caracteristicaId', c.id, 'obligatoria', a.obligatoria, 'estado', a.estado,
          'schemaVersion', t.schema_version, 'caracteristica', jsonb_build_object(
            'caracteristicaId', c.id, 'nombre', c.nombre, 'tipo', c.tipo,
            'unidadMedida', c.unidad_medida, 'estado', c.estado, 'version', c.taxonomy_version,
            'valores', COALESCE((SELECT jsonb_agg(jsonb_build_object('valorId', v.id, 'nombre', v.nombre,
              'estado', v.estado, 'version', v.taxonomy_version) ORDER BY v.nombre, v.id)
              FROM taxonomy.characteristic_values v WHERE v.caracteristica_id = c.id AND v.estado = 'ACTIVO'), '[]'::jsonb)
          )) ORDER BY c.nombre, c.id)
          FROM taxonomy.product_type_characteristics a JOIN taxonomy.characteristics c ON c.id = a.caracteristica_id
          WHERE a.tipo_producto_id = t.id AND a.estado = 'ACTIVO' AND c.estado = 'ACTIVO'), '[]'::jsonb) AS caracteristicas
        FROM taxonomy.product_types t WHERE t.id = ${id}::uuid`);
      const row = result.rows[0];
      if (!row) return null;
      if (!Array.isArray(row.caracteristicas))
        throw new Error('ESQUEMA_INVALIDO');
      const tipoProducto = mapear(row);
      return {
        tipoProducto,
        caracteristicas: row.caracteristicas,
        schemaVersion: tipoProducto.schemaVersion,
      };
    });
  }

  async crear(nombre: string): Promise<TipoProductoAdmin | null> {
    if (!nombre.trim()) return null;
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const resultado =
          await tx.execute(sql`INSERT INTO taxonomy.product_types (nombre)
        VALUES (${nombre}) ON CONFLICT (nombre) DO NOTHING
        RETURNING id, nombre, estado, schema_version`);
        return resultado.rows[0] ? mapear(resultado.rows[0]) : null;
      }),
    );
  }

  async reactivar(
    id: string,
  ): Promise<'NO_ENCONTRADO' | 'BAJA_EN_PROCESO' | TipoProductoAdmin> {
    if (!esUuid(id)) return 'NO_ENCONTRADO';
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const actual =
          await tx.execute(sql`SELECT id, nombre, estado, schema_version
        FROM taxonomy.product_types WHERE id = ${id}::uuid FOR UPDATE`);
        const row = actual.rows[0];
        if (!row) return 'NO_ENCONTRADO' as const;
        if (row.estado === 'PENDING_DEACTIVATION')
          return 'BAJA_EN_PROCESO' as const;
        if (row.estado === 'INACTIVO') {
          const updated = await tx.execute(sql`UPDATE taxonomy.product_types
          SET estado = 'ACTIVO', taxonomy_version = taxonomy_version + 1, updated_at = statement_timestamp()
          WHERE id = ${id}::uuid AND estado = 'INACTIVO'
          RETURNING id, nombre, estado, schema_version`);
          if (!updated.rows[0]) throw new Error('CAMBIO_CONCURRENTE');
          return mapear(updated.rows[0]);
        }
        return mapear(row);
      }),
    );
  }
}
