import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';

export interface CategoriaNueva {
  nombre: string;
  descripcion: string | null;
  categoriaPadreId: string | null;
  orden: number;
  imagenUrl: string | null;
  slugConfirmado: string;
}
type Resultado =
  | {
      estado:
        | 'PADRE_INVALIDO'
        | 'PADRE_INACTIVO'
        | 'PROFUNDIDAD_EXCEDIDA'
        | 'SLUG_DUPLICADO';
    }
  | {
      estado: 'CREADA';
      categoria: {
        categoriaId: string;
        nombre: string;
        descripcion: string | null;
        categoriaPadreId: string | null;
        orden: number;
        imagenUrl: string | null;
        estado: 'ACTIVO';
        version: number;
        slug: string;
      };
    };
class SlugDuplicado extends Error {}

@Injectable()
export class CategoryCreateService {
  constructor(private readonly database: Database) {}
  async crear(entrada: CategoriaNueva): Promise<Resultado> {
    return this.database.read(async (db) => {
      try {
        return await db.transaction(async (tx) => {
          let nivel = 1;
          if (entrada.categoriaPadreId) {
            const parent = await tx.execute(
              sql`SELECT estado, nivel FROM taxonomy.categories WHERE id = ${entrada.categoriaPadreId}::uuid FOR UPDATE`,
            );
            if (!parent.rows[0]) return { estado: 'PADRE_INVALIDO' } as const;
            if (parent.rows[0].estado !== 'ACTIVO')
              return { estado: 'PADRE_INACTIVO' } as const;
            if (Number(parent.rows[0].nivel) !== 1)
              return { estado: 'PROFUNDIDAD_EXCEDIDA' } as const;
            nivel = 2;
          }
          const inserted = await tx.execute(
            sql`INSERT INTO taxonomy.categories (nombre, descripcion, categoria_padre_id, nivel, orden, imagen_url) VALUES (${entrada.nombre}, ${entrada.descripcion}, ${entrada.categoriaPadreId}::uuid, ${nivel}, ${entrada.orden}, ${entrada.imagenUrl}) RETURNING id, taxonomy_version`,
          );
          const row = inserted.rows[0];
          if (
            !row ||
            typeof row.id !== 'string' ||
            !Number.isSafeInteger(Number(row.taxonomy_version))
          )
            throw new Error('Categoría inválida');
          const seo = await tx.execute(
            sql`INSERT INTO taxonomy.category_seo (categoria_id, slug) VALUES (${row.id}::uuid, ${entrada.slugConfirmado}) ON CONFLICT (slug) DO NOTHING RETURNING slug`,
          );
          if (!seo.rows.length) throw new SlugDuplicado();
          return {
            estado: 'CREADA',
            categoria: {
              categoriaId: row.id,
              nombre: entrada.nombre,
              descripcion: entrada.descripcion,
              categoriaPadreId: entrada.categoriaPadreId,
              orden: entrada.orden,
              imagenUrl: entrada.imagenUrl,
              estado: 'ACTIVO',
              version: Number(row.taxonomy_version),
              slug: entrada.slugConfirmado,
            },
          } as const;
        });
      } catch (error) {
        if (error instanceof SlugDuplicado) return { estado: 'SLUG_DUPLICADO' };
        throw error;
      }
    });
  }
}
