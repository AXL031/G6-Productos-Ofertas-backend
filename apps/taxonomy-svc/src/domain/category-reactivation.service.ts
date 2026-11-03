import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';

export type ResultadoReactivacionCategoria =
  | { estado: 'NO_ENCONTRADA' }
  | { estado: 'PADRE_INACTIVO' }
  | { estado: 'BAJA_EN_PROCESO' }
  | {
      estado: 'ACTIVA';
      categoria: {
        categoriaId: string;
        nombre: string;
        descripcion: string | null;
        categoriaPadreId: string | null;
        orden: number;
        imagenUrl: string | null;
        estado: 'ACTIVO';
        version: number;
      };
    };

@Injectable()
export class CategoryReactivationService {
  constructor(private readonly database: Database) {}

  async reactivar(
    categoriaId: string,
    correlationId: string = randomUUID(),
  ): Promise<ResultadoReactivacionCategoria> {
    if (!esUuid(categoriaId)) return { estado: 'NO_ENCONTRADA' };
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const result = await tx.execute(
          sql`SELECT id, nombre, descripcion, categoria_padre_id, orden, imagen_url, estado, taxonomy_version FROM taxonomy.categories WHERE id = ${categoriaId}::uuid FOR UPDATE`,
        );
        const current = result.rows[0];
        if (!current) return { estado: 'NO_ENCONTRADA' } as const;
        const active = await tx.execute(
          sql`SELECT 1 FROM taxonomy.master_deactivation_operations WHERE entity_type = 'CATEGORY' AND entity_id = ${categoriaId}::uuid AND status IN ('REQUESTED', 'IN_PROGRESS') LIMIT 1`,
        );
        if (current.estado === 'PENDING_DEACTIVATION' || active.rows.length)
          return { estado: 'BAJA_EN_PROCESO' } as const;
        if (typeof current.categoria_padre_id === 'string') {
          const parent = await tx.execute(
            sql`SELECT estado FROM taxonomy.categories WHERE id = ${current.categoria_padre_id}::uuid FOR UPDATE`,
          );
          if (parent.rows[0]?.estado !== 'ACTIVO')
            return { estado: 'PADRE_INACTIVO' } as const;
        }
        const updated =
          current.estado === 'ACTIVO'
            ? undefined
            : await tx.execute(
                sql`UPDATE taxonomy.categories SET estado = 'ACTIVO', taxonomy_version = taxonomy_version + 1, updated_at = statement_timestamp() WHERE id = ${categoriaId}::uuid AND estado = 'INACTIVO' RETURNING id, nombre, descripcion, categoria_padre_id, orden, imagen_url, estado, taxonomy_version`,
              );
        const row = updated ? updated.rows[0] : current;
        if (
          !row ||
          typeof row.id !== 'string' ||
          typeof row.nombre !== 'string' ||
          row.estado !== 'ACTIVO' ||
          !Number.isSafeInteger(Number(row.taxonomy_version)) ||
          !Number.isSafeInteger(row.orden)
        )
          throw new Error('Estado de categoría inválido');
        if (current.estado === 'INACTIVO') {
          await tx.execute(
            sql`WITH evento AS (SELECT gen_random_uuid() AS message_id, statement_timestamp() AS fecha) INSERT INTO taxonomy.outbox (message_id, event_name, kind, schema_version, correlation_id, occurred_at, payload) SELECT evento.message_id, 'taxonomy.category.updated', 'event', 1, ${correlationId}::uuid, evento.fecha, jsonb_build_object('message_id', evento.message_id, 'schema_version', 1, 'occurred_at', evento.fecha, 'correlation_id', ${correlationId}::uuid, 'producer', 'taxonomy-svc', 'kind', 'event', 'name', 'taxonomy.category.updated', 'data', jsonb_build_object('categoria_id', ${categoriaId}::text, 'version', ${Number(row.taxonomy_version)}::bigint)) FROM evento`,
          );
        }
        return {
          estado: 'ACTIVA',
          categoria: {
            categoriaId: row.id,
            nombre: row.nombre,
            descripcion:
              typeof row.descripcion === 'string' ? row.descripcion : null,
            categoriaPadreId:
              typeof row.categoria_padre_id === 'string'
                ? row.categoria_padre_id
                : null,
            orden: Number(row.orden),
            imagenUrl:
              typeof row.imagen_url === 'string' ? row.imagen_url : null,
            estado: 'ACTIVO',
            version: Number(row.taxonomy_version),
          },
        } as const;
      }),
    );
  }
}
