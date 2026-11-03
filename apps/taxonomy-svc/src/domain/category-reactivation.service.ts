import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
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
  ): Promise<ResultadoReactivacionCategoria> {
    if (!esUuid(categoriaId)) return { estado: 'NO_ENCONTRADA' };
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const result = await tx.execute(
          sql`SELECT id, estado, categoria_padre_id FROM taxonomy.categories WHERE id = ${categoriaId}::uuid FOR UPDATE`,
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
        const updated = await tx.execute(
          sql`UPDATE taxonomy.categories SET estado = 'ACTIVO', taxonomy_version = taxonomy_version + CASE WHEN estado = 'INACTIVO' THEN 1 ELSE 0 END, updated_at = CASE WHEN estado = 'INACTIVO' THEN statement_timestamp() ELSE updated_at END WHERE id = ${categoriaId}::uuid AND estado IN ('ACTIVO','INACTIVO') RETURNING id, nombre, descripcion, categoria_padre_id, orden, imagen_url, estado, taxonomy_version`,
        );
        const row = updated.rows[0];
        if (
          !row ||
          typeof row.id !== 'string' ||
          typeof row.nombre !== 'string' ||
          row.estado !== 'ACTIVO' ||
          !Number.isSafeInteger(Number(row.taxonomy_version)) ||
          !Number.isSafeInteger(row.orden)
        )
          throw new Error('Estado de categoría inválido');
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
