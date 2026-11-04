import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { categories, brands, categorySeo } from './taxonomy.schema.js';
import { ProblemDetailsException } from './errors/taxonomy.errors.js';
import type { TaxonomyReadinessIndicator } from './health/readiness.port.js';
import type {
  TaxonomyRepository,
  CategoriaRow,
  CategoriaAdminRow,
  MarcaRow,
} from './taxonomy.repository.js';

/**
 * Puerto mínimo de la fuente de datos de runtime: lectura tipada y
 * verificación de identidad. `Database` lo satisface conservando TLS e
 * identidad; las pruebas pueden sustituirlo por un adaptador efímero.
 */
export interface TaxonomyDataSource {
  read<T>(query: (db: NodePgDatabase) => Promise<T>): Promise<T>;
  verifyIdentity(env?: Readonly<NodeJS.ProcessEnv>): Promise<void>;
}

@Injectable()
export class PostgresTaxonomyRepository
  implements TaxonomyRepository, TaxonomyReadinessIndicator
{
  constructor(private readonly database: TaxonomyDataSource) {}

  async findCategoriasActivas(): Promise<CategoriaRow[]> {
    const rows = await this.database.read((db) =>
      db
        .select({
          id: categories.id,
          nombre: categories.nombre,
          categoria_padre_id: categories.categoria_padre_id,
          estado: categories.estado,
        })
        .from(categories)
        .where(eq(categories.estado, 'ACTIVO'))
        .orderBy(
          asc(categories.orden),
          asc(categories.nombre),
          asc(categories.id),
        ),
    );
    return rows.filter((row) => row.estado === 'ACTIVO');
  }

  async findCategoriaAdmin(id: string): Promise<CategoriaAdminRow | undefined> {
    const [row] = await this.database.read((db) =>
      db
        .select({
          id: categories.id,
          nombre: categories.nombre,
          descripcion: categories.descripcion,
          categoria_padre_id: categories.categoria_padre_id,
          orden: categories.orden,
          imagen_url: categories.imagen_url,
          estado: categories.estado,
          version: categories.taxonomy_version,
          slug: categorySeo.slug,
        })
        .from(categories)
        .leftJoin(categorySeo, eq(categorySeo.categoria_id, categories.id))
        .where(eq(categories.id, id))
        .limit(1),
    );
    return row;
  }

  async findMarcasActivas(): Promise<MarcaRow[]> {
    const rows = await this.database.read((db) =>
      db
        .select({
          id: brands.id,
          nombre: brands.nombre,
          descripcion: brands.descripcion,
          pais_origen_iso: brands.pais_origen_iso,
          logo_url: brands.logo_url,
          estado: brands.estado,
        })
        .from(brands)
        .where(eq(brands.estado, 'ACTIVO'))
        .orderBy(asc(brands.nombre), asc(brands.id)),
    );
    return rows.filter((row) => row.estado === 'ACTIVO');
  }

  async readiness(): Promise<boolean> {
    try {
      await this.database.verifyIdentity();
      // Sondeos acotados (columnas explícitas + LIMIT 1): verifican privilegios
      // y disponibilidad sin recorrer tablas completas.
      await this.database.read((db) =>
        db
          .select({
            id: categories.id,
            nombre: categories.nombre,
            categoria_padre_id: categories.categoria_padre_id,
            orden: categories.orden,
            estado: categories.estado,
          })
          .from(categories)
          .where(eq(categories.estado, 'ACTIVO'))
          .limit(1),
      );
      await this.database.read((db) =>
        db
          .select({
            id: brands.id,
            nombre: brands.nombre,
            descripcion: brands.descripcion,
            pais_origen_iso: brands.pais_origen_iso,
            logo_url: brands.logo_url,
            estado: brands.estado,
          })
          .from(brands)
          .where(eq(brands.estado, 'ACTIVO'))
          .limit(1),
      );
      return true;
    } catch {
      return false;
    }
  }

  async verificarReadiness(): Promise<void> {
    const ok = await this.readiness();
    if (!ok) {
      throw ProblemDetailsException.noDisponible(
        'Fuente de datos de taxonomía no disponible.',
      );
    }
  }
}
