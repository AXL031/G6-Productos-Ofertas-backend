import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { OnApplicationShutdown } from '@nestjs/common';
import { ProblemDetailsException } from '../errors/taxonomy.errors.js';
import type { TaxonomyReadinessIndicator } from '../health/readiness.port.js';
import type {
  CategoriaRow,
  CategoriaAdminRow,
  MarcaRow,
  TaxonomyRepository,
} from '../taxonomy.repository.js';
import {
  categorias,
  categorySeo,
  esquemaTaxonomia,
  marcas,
} from './taxonomy.schema.js';

export type TaxonomyDb = NodePgDatabase<typeof esquemaTaxonomia>;

export type TransaccionTaxonomy = Parameters<
  Parameters<TaxonomyDb['transaction']>[0]
>[0];

export interface FilaCategoriaDb {
  id: string;
  nombre: string;
  categoria_padre_id: string | null;
}

export interface FilaMarcaDb {
  id: string;
  nombre: string;
  descripcion: string | null;
  pais_origen_iso: string | null;
  logo_url: string | null;
}

const CODIGOS_CONEXION = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '53400',
]);

const DETALLE_NO_DISPONIBLE = 'Base de datos de taxonomia no disponible.';

export function esFalloDeConexion(error: unknown): boolean {
  return codigosDeError(error).some((codigo) => CODIGOS_CONEXION.has(codigo));
}

function codigosDeError(error: unknown, profundidad = 0): string[] {
  if (typeof error !== 'object' || error === null || profundidad > 3) {
    return [];
  }
  const codigos: string[] = [];
  const codigo = (error as { code?: unknown }).code;
  if (typeof codigo === 'string') {
    codigos.push(codigo);
  }
  const anidados = (error as { errors?: unknown }).errors;
  if (Array.isArray(anidados)) {
    for (const anidado of anidados) {
      codigos.push(...codigosDeError(anidado, profundidad + 1));
    }
  }
  const causa = (error as { cause?: unknown }).cause;
  if (causa && causa !== error) {
    codigos.push(...codigosDeError(causa, profundidad + 1));
  }
  return codigos;
}

export function aCategoriaRow(fila: FilaCategoriaDb): CategoriaRow {
  return {
    id: fila.id,
    nombre: fila.nombre,
    categoria_padre_id: fila.categoria_padre_id ?? null,
    estado: 'ACTIVO',
  };
}

export function aMarcaRow(fila: FilaMarcaDb): MarcaRow {
  return {
    id: fila.id,
    nombre: fila.nombre,
    descripcion: fila.descripcion ?? null,
    pais_origen_iso: fila.pais_origen_iso ?? null,
    logo_url: fila.logo_url ?? null,
    estado: 'ACTIVO',
  };
}

export class DrizzleTaxonomyRepository
  implements
    TaxonomyRepository,
    TaxonomyReadinessIndicator,
    OnApplicationShutdown
{
  constructor(
    private readonly db: TaxonomyDb,
    private readonly alCerrar: () => Promise<void> = async () => undefined,
  ) {}

  async findCategoriasActivas(): Promise<CategoriaRow[]> {
    try {
      const filas = await this.db
        .select({
          id: categorias.id,
          nombre: categorias.nombre,
          categoria_padre_id: categorias.categoriaPadreId,
        })
        .from(categorias)
        .where(eq(categorias.estado, 'ACTIVO'));
      return filas.map(aCategoriaRow);
    } catch (error) {
      this.traducirError(error);
    }
  }

  async findCategoriaAdmin(id: string): Promise<CategoriaAdminRow | undefined> {
    try {
      const [row] = await this.db
        .select({
          id: categorias.id,
          nombre: categorias.nombre,
          descripcion: categorias.descripcion,
          categoria_padre_id: categorias.categoriaPadreId,
          orden: categorias.orden,
          imagen_url: categorias.imagenUrl,
          estado: categorias.estado,
          version: categorias.taxonomyVersion,
          slug: categorySeo.slug,
        })
        .from(categorias)
        .leftJoin(categorySeo, eq(categorySeo.categoriaId, categorias.id))
        .where(eq(categorias.id, id))
        .limit(1);
      return row;
    } catch (error) {
      this.traducirError(error);
    }
  }

  async findMarcasActivas(): Promise<MarcaRow[]> {
    try {
      const filas = await this.db
        .select({
          id: marcas.id,
          nombre: marcas.nombre,
          descripcion: marcas.descripcion,
          pais_origen_iso: marcas.paisOrigenIso,
          logo_url: marcas.logoUrl,
        })
        .from(marcas)
        .where(eq(marcas.estado, 'ACTIVO'));
      return filas.map(aMarcaRow);
    } catch (error) {
      this.traducirError(error);
    }
  }

  async verificarReadiness(): Promise<void> {
    try {
      await this.db
        .select({
          id: categorias.id,
          nombre: categorias.nombre,
          categoria_padre_id: categorias.categoriaPadreId,
          orden: categorias.orden,
          estado: categorias.estado,
        })
        .from(categorias)
        .where(eq(categorias.estado, 'ACTIVO'))
        .limit(1);

      await this.db
        .select({
          id: marcas.id,
          nombre: marcas.nombre,
          descripcion: marcas.descripcion,
          pais_origen_iso: marcas.paisOrigenIso,
          logo_url: marcas.logoUrl,
          estado: marcas.estado,
        })
        .from(marcas)
        .where(eq(marcas.estado, 'ACTIVO'))
        .limit(1);
    } catch {
      throw ProblemDetailsException.noDisponible(DETALLE_NO_DISPONIBLE);
    }
  }

  async enTransaccion<T>(
    operacion: (tx: TransaccionTaxonomy) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction((tx) => operacion(tx));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.alCerrar();
  }

  private traducirError(error: unknown): never {
    if (esFalloDeConexion(error)) {
      throw ProblemDetailsException.noDisponible(DETALLE_NO_DISPONIBLE);
    }
    throw error;
  }
}
