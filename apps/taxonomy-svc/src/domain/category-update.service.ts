import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';

export interface CambioCategoria {
  nombre?: string;
  descripcion?: string | null;
  categoriaPadreId?: string | null;
  orden?: number | null;
  imagenUrl?: string | null;
  version?: number | null;
}
type Resultado =
  | {
      estado:
        | 'NO_ENCONTRADA'
        | 'PADRE_INACTIVO'
        | 'CICLO'
        | 'PROFUNDIDAD'
        | 'VERSION_CONFLICT'
        | 'NO_DISPONIBLE'
        | 'PADRE_INVALIDO';
    }
  | { estado: 'OK'; categoria: Record<string, unknown> };

@Injectable()
export class CategoryUpdateService {
  constructor(private readonly database: Database) {}
  async actualizar(
    id: string,
    data: CambioCategoria,
    correlationId: string = randomUUID(),
  ): Promise<Resultado> {
    if (!esUuid(id)) return { estado: 'NO_ENCONTRADA' };
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const existing = await tx.execute(
          sql`SELECT id, estado, categoria_padre_id, taxonomy_version FROM taxonomy.categories WHERE id = ${id}::uuid FOR UPDATE`,
        );
        const current = existing.rows[0];
        if (!current) return { estado: 'NO_ENCONTRADA' } as const;
        if (current.estado === 'PENDING_DEACTIVATION')
          return { estado: 'NO_DISPONIBLE' } as const;
        if (
          data.version != null &&
          String(data.version) !== String(current.taxonomy_version)
        )
          return { estado: 'VERSION_CONFLICT' } as const;
        let nivel = current.categoria_padre_id ? 2 : 1;
        if (data.categoriaPadreId !== undefined) {
          if (data.categoriaPadreId?.toLowerCase() === id.toLowerCase())
            return { estado: 'CICLO' } as const;
          if (data.categoriaPadreId) {
            const parent = await tx.execute(
              sql`SELECT estado, nivel, categoria_padre_id FROM taxonomy.categories WHERE id = ${data.categoriaPadreId}::uuid FOR UPDATE`,
            );
            if (!parent.rows[0]) return { estado: 'PADRE_INVALIDO' } as const;
            if (
              typeof parent.rows[0].categoria_padre_id === 'string' &&
              parent.rows[0].categoria_padre_id.toLowerCase() ===
                id.toLowerCase()
            )
              return { estado: 'CICLO' } as const;
            if (parent.rows[0].estado !== 'ACTIVO')
              return { estado: 'PADRE_INACTIVO' } as const;
            if (Number(parent.rows[0].nivel) !== 1)
              return { estado: 'PROFUNDIDAD' } as const;
            const children = await tx.execute(
              sql`SELECT 1 FROM taxonomy.categories WHERE categoria_padre_id = ${id}::uuid LIMIT 1`,
            );
            if (children.rows.length) return { estado: 'PROFUNDIDAD' } as const;
            nivel = 2;
          } else nivel = 1;
        }
        const result = await tx.execute(
          sql`UPDATE taxonomy.categories SET nombre = CASE WHEN ${data.nombre !== undefined} THEN ${data.nombre ?? null} ELSE nombre END, descripcion = CASE WHEN ${data.descripcion !== undefined} THEN ${data.descripcion ?? null} ELSE descripcion END, categoria_padre_id = CASE WHEN ${data.categoriaPadreId !== undefined} THEN ${data.categoriaPadreId ?? null}::uuid ELSE categoria_padre_id END, nivel = ${nivel}, orden = CASE WHEN ${data.orden !== undefined} THEN ${data.orden ?? 0} ELSE orden END, imagen_url = CASE WHEN ${data.imagenUrl !== undefined} THEN ${data.imagenUrl ?? null} ELSE imagen_url END, taxonomy_version = taxonomy_version + 1, updated_at = statement_timestamp() WHERE id = ${id}::uuid RETURNING id, nombre, descripcion, categoria_padre_id, orden, imagen_url, estado, taxonomy_version`,
        );
        const row = result.rows[0];
        if (
          !row ||
          typeof row.id !== 'string' ||
          typeof row.nombre !== 'string' ||
          !Number.isSafeInteger(Number(row.taxonomy_version))
        )
          throw new Error('Categoría inválida');
        await tx.execute(
          sql`WITH evento AS (SELECT gen_random_uuid() AS message_id, statement_timestamp() AS fecha) INSERT INTO taxonomy.outbox (message_id, event_name, kind, schema_version, correlation_id, occurred_at, payload) SELECT evento.message_id, 'taxonomy.category.updated', 'event', 1, ${correlationId}::uuid, evento.fecha, jsonb_build_object('message_id', evento.message_id, 'schema_version', 1, 'occurred_at', evento.fecha, 'correlation_id', ${correlationId}::uuid, 'producer', 'taxonomy-svc', 'kind', 'event', 'name', 'taxonomy.category.updated', 'data', jsonb_build_object('categoria_id', ${id}::text, 'version', ${Number(row.taxonomy_version)}::bigint)) FROM evento`,
        );
        return {
          estado: 'OK',
          categoria: {
            categoriaId: row.id,
            nombre: row.nombre,
            descripcion: row.descripcion,
            categoriaPadreId: row.categoria_padre_id,
            orden: row.orden,
            imagenUrl: row.imagen_url,
            estado: row.estado,
            version: Number(row.taxonomy_version),
          },
        } as const;
      }),
    );
  }
}
