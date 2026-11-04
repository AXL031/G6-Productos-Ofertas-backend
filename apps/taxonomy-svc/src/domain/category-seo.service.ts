import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';

function normalizar(texto: string): string {
  return texto
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
@Injectable()
export class CategorySeoService {
  constructor(private readonly database: Database) {}

  async proponer(nombre: string) {
    const base = normalizar(nombre);
    if (!base) return null;
    return this.database.read(async (db) => {
      for (let n = 1; n < 10000; n++) {
        const slug = n === 1 ? base : `${base}-${n}`;
        const exists =
          await db.execute(sql`SELECT 1 FROM taxonomy.category_seo WHERE slug=${slug}
          UNION ALL SELECT 1 FROM taxonomy.slug_history WHERE old_slug=${slug} LIMIT 1`);
        if (!exists.rows.length) return { slug, colisionResuelta: n > 1 };
      }
      throw new Error('LIMITE_RESOLUCION_SLUG');
    });
  }

  async publico(slug: string) {
    return this.database.read(async (db) => {
      const r =
        await db.execute(sql`SELECT s.slug,COALESCE(s.meta_titulo,c.nombre) AS meta_title,
        COALESCE(s.meta_descripcion,c.descripcion,'') AS meta_description
        FROM taxonomy.category_seo s JOIN taxonomy.categories c ON c.id=s.categoria_id
        WHERE s.slug=${slug} AND c.estado='ACTIVO'`);
      return r.rows[0]
        ? {
            slug: r.rows[0].slug,
            meta_title: r.rows[0].meta_title,
            meta_description: r.rows[0].meta_description,
          }
        : undefined;
    });
  }

  async resolver(slug: string) {
    return this.database.read(async (db) => {
      const r = await db.execute(
        sql`SELECT h.old_slug,s.slug AS new_slug FROM taxonomy.slug_history h
          JOIN taxonomy.category_seo s ON s.categoria_id=h.categoria_id
          WHERE h.old_slug=${slug} LIMIT 1`,
      );
      return r.rows[0]
        ? {
            old_slug: r.rows[0].old_slug,
            new_slug: r.rows[0].new_slug,
            resolution: 'PERMANENT' as const,
          }
        : undefined;
    });
  }

  async obtener(id: string) {
    if (!esUuid(id)) return undefined;
    return this.database.read(async (db) => {
      const r =
        await db.execute(sql`SELECT c.id AS categoria_id,s.slug,s.meta_titulo,s.meta_descripcion,s.updated_at
        FROM taxonomy.categories c JOIN taxonomy.category_seo s ON s.categoria_id=c.id WHERE c.id=${id}::uuid`);
      const row = r.rows[0];
      return row
        ? {
            categoriaId: row.categoria_id,
            slug: row.slug,
            metaTitulo: row.meta_titulo,
            metaDescripcion: row.meta_descripcion,
            updatedAt: new Date(String(row.updated_at)).toISOString(),
          }
        : undefined;
    });
  }

  async actualizar(
    id: string,
    data: {
      slug: string;
      metaTitulo?: string | null;
      metaDescripcion?: string | null;
    },
  ) {
    if (!esUuid(id)) return 'NO_ENCONTRADA' as const;
    return this.database.read(async (db) => {
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${data.slug}, 0))`,
          );
          const current = await tx.execute(
            sql`SELECT id FROM taxonomy.categories WHERE id=${id}::uuid FOR UPDATE`,
          );
          if (!current.rows[0]) return 'NO_ENCONTRADA' as const;
          const historico = await tx.execute(
            sql`SELECT 1 FROM taxonomy.slug_history WHERE old_slug=${data.slug}`,
          );
          if (historico.rows.length) return 'SLUG_DUPLICADO' as const;
          const r =
            await tx.execute(sql`UPDATE taxonomy.category_seo SET slug=${data.slug},
        meta_titulo=CASE WHEN ${data.metaTitulo !== undefined} THEN ${data.metaTitulo ?? null} ELSE meta_titulo END,
        meta_descripcion=CASE WHEN ${data.metaDescripcion !== undefined} THEN ${data.metaDescripcion ?? null} ELSE meta_descripcion END,
        taxonomy_version=taxonomy_version+1,updated_at=statement_timestamp()
        WHERE categoria_id=${id}::uuid RETURNING categoria_id,slug,meta_titulo,meta_descripcion,updated_at`);
          const row = r.rows[0];
          if (!row) return 'NO_ENCONTRADA' as const;
          return {
            categoriaId: row.categoria_id,
            slug: row.slug,
            metaTitulo: row.meta_titulo,
            metaDescripcion: row.meta_descripcion,
            updatedAt: new Date(String(row.updated_at)).toISOString(),
          };
        });
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === '23505'
        )
          return 'SLUG_DUPLICADO' as const;
        throw error;
      }
    });
  }

  async historial(id: string) {
    if (!esUuid(id)) return null;
    return this.database.read(async (db) => {
      const exists = await db.execute(
        sql`SELECT 1 FROM taxonomy.categories WHERE id=${id}::uuid`,
      );
      if (!exists.rows.length) return null;
      const rows = await db.execute(
        sql`SELECT old_slug,new_slug,changed_at FROM taxonomy.slug_history WHERE categoria_id=${id}::uuid ORDER BY changed_at,id`,
      );
      return rows.rows.map((r) => ({
        oldSlug: r.old_slug,
        newSlug: r.new_slug,
        changedAt: new Date(String(r.changed_at)).toISOString(),
      }));
    });
  }
}
