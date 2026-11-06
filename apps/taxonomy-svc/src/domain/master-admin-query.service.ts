import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';

type Estado = 'ACTIVO' | 'INACTIVO' | 'PENDING_DEACTIVATION';
type Categoria = {
  categoriaId: string;
  nombre: string;
  descripcion: string | null;
  categoriaPadreId: string | null;
  orden: number;
  imagenUrl: string | null;
  estado: Estado;
  version: number;
  slug: string | null;
};
type Marca = {
  marcaId: string;
  nombre: string;
  descripcion: string | null;
  logoUrl: string | null;
  paisOrigenIso: string | null;
  estado: Estado;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type CategoriaTreeNode = {
  categoria: Categoria;
  hijos: CategoriaTreeNode[];
};

function paginaValida(pagina: number, tamanio: number): void {
  if (
    !Number.isSafeInteger(pagina) ||
    pagina < 1 ||
    !Number.isSafeInteger(tamanio) ||
    tamanio < 1 ||
    tamanio > 200
  )
    throw new Error('PAGINACION_INVALIDA');
}

@Injectable()
export class MasterAdminQueryService {
  constructor(private readonly database: Database) {}

  async arbol(): Promise<CategoriaTreeNode[]> {
    return this.database.read(async (db) => {
      const result = await db.execute(sql`SELECT c.id, c.nombre, c.descripcion,
        c.categoria_padre_id, c.orden, c.imagen_url, c.estado,
        c.taxonomy_version AS version, s.slug
        FROM taxonomy.categories c LEFT JOIN taxonomy.category_seo s ON s.categoria_id = c.id
        WHERE c.estado::text IN ('ACTIVO', 'INACTIVO')
        ORDER BY c.orden, c.nombre, c.id`);
      const rows = result.rows.map((r) => this.categoria(r));
      const nodes = new Map<string, CategoriaTreeNode>();
      for (const row of rows)
        nodes.set(row.categoriaId, { categoria: row, hijos: [] });
      const roots: CategoriaTreeNode[] = [];
      for (const row of rows) {
        const node = nodes.get(row.categoriaId)!;
        const parent = row.categoriaPadreId
          ? nodes.get(row.categoriaPadreId)
          : undefined;
        if (parent) parent.hijos.push(node);
        else roots.push(node);
      }
      return roots;
    });
  }

  async categoriasAdmin(filtro: {
    categoriaPadreId?: string;
    pagina: number;
    tamanio: number;
    estado?: string;
  }) {
    paginaValida(filtro.pagina, filtro.tamanio);
    return this.database.read(async (db) => {
      const args = [filtro.estado ?? null, filtro.categoriaPadreId ?? null];
      const total =
        await db.execute(sql`SELECT count(*)::int AS total FROM taxonomy.categories
        WHERE estado::text IN ('ACTIVO', 'INACTIVO')
        AND (${args[0]}::text IS NULL OR estado::text = ${args[0]}::text)
        AND (${args[1]}::uuid IS NULL OR categoria_padre_id = ${args[1]}::uuid)`);
      const result =
        await db.execute(sql`SELECT c.id, c.nombre, c.descripcion, c.categoria_padre_id,
        c.orden, c.imagen_url, c.estado, c.taxonomy_version AS version, s.slug
        FROM taxonomy.categories c LEFT JOIN taxonomy.category_seo s ON s.categoria_id = c.id
        WHERE c.estado::text IN ('ACTIVO', 'INACTIVO')
        AND (${args[0]}::text IS NULL OR c.estado::text = ${args[0]}::text)
        AND (${args[1]}::uuid IS NULL OR c.categoria_padre_id = ${args[1]}::uuid)
        ORDER BY c.orden, c.nombre, c.id LIMIT ${filtro.tamanio} OFFSET ${(filtro.pagina - 1) * filtro.tamanio}`);
      const n = Number(total.rows[0]?.total ?? 0);
      return {
        items: result.rows.map((r) => this.categoria(r)),
        meta: {
          pagina: filtro.pagina,
          tamanio: filtro.tamanio,
          total: n,
          totalPaginas: Math.ceil(n / filtro.tamanio),
        },
      };
    });
  }

  async marca(id: string): Promise<Marca | undefined> {
    return this.database.read(async (db) => {
      const result =
        await db.execute(sql`SELECT id, nombre, descripcion, logo_url, pais_origen_iso,
        estado, taxonomy_version AS version, created_at, updated_at FROM taxonomy.brands WHERE id = ${id}::uuid`);
      return result.rows[0] ? this.marcaDto(result.rows[0]) : undefined;
    });
  }

  async marcasAdmin(filtro: {
    q?: string;
    pagina: number;
    tamanio: number;
    estado?: string;
  }) {
    paginaValida(filtro.pagina, filtro.tamanio);
    const q = filtro.q?.trim() || null;
    return this.database.read(async (db) => {
      const total =
        await db.execute(sql`SELECT count(*)::int AS total FROM taxonomy.brands
        WHERE estado::text IN ('ACTIVO', 'INACTIVO')
        AND (${filtro.estado ?? null}::text IS NULL OR estado::text = ${filtro.estado ?? null}::text)
        AND (${q}::text IS NULL OR nombre ILIKE '%' || ${q} || '%')`);
      const result =
        await db.execute(sql`SELECT id, nombre, descripcion, logo_url, pais_origen_iso,
        estado, taxonomy_version AS version, created_at, updated_at FROM taxonomy.brands
        WHERE estado::text IN ('ACTIVO', 'INACTIVO')
        AND (${filtro.estado ?? null}::text IS NULL OR estado::text = ${filtro.estado ?? null}::text)
        AND (${q}::text IS NULL OR nombre ILIKE '%' || ${q} || '%')
        ORDER BY nombre, id LIMIT ${filtro.tamanio} OFFSET ${(filtro.pagina - 1) * filtro.tamanio}`);
      const n = Number(total.rows[0]?.total ?? 0);
      return {
        items: result.rows.map((r) => this.marcaDto(r)),
        meta: {
          pagina: filtro.pagina,
          tamanio: filtro.tamanio,
          total: n,
          totalPaginas: Math.ceil(n / filtro.tamanio),
        },
      };
    });
  }

  private categoria(row: Record<string, unknown>): Categoria {
    return {
      categoriaId: String(row.id),
      nombre: String(row.nombre),
      descripcion: row.descripcion as string | null,
      categoriaPadreId: row.categoria_padre_id as string | null,
      orden: Number(row.orden),
      imagenUrl: row.imagen_url as string | null,
      estado: row.estado as Estado,
      version: Number(row.version),
      slug: row.slug as string | null,
    };
  }

  private marcaDto(row: Record<string, unknown>): Marca {
    return {
      marcaId: String(row.id),
      nombre: String(row.nombre),
      descripcion: row.descripcion as string | null,
      logoUrl: row.logo_url as string | null,
      paisOrigenIso: row.pais_origen_iso as string | null,
      estado: row.estado as Estado,
      version: Number(row.version),
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
  }
}
