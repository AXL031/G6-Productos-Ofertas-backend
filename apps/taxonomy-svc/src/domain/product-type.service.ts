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
          : sql``;
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
}
