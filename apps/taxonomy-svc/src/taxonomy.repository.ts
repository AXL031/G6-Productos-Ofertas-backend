export const TAXONOMY_REPOSITORY = 'TAXONOMY_REPOSITORY';

export type EstadoTaxonomia = 'ACTIVO' | 'INACTIVO' | 'PENDING_DEACTIVATION';

export interface CategoriaRow {
  id: string;
  nombre: string;
  categoria_padre_id: string | null;
  estado: EstadoTaxonomia;
}

export interface CategoriaAdminRow {
  id: string;
  nombre: string;
  descripcion: string | null;
  categoria_padre_id: string | null;
  orden: number;
  imagen_url: string | null;
  estado: EstadoTaxonomia;
  version: number;
  slug: string | null;
}

export interface MarcaRow {
  id: string;
  nombre: string;
  descripcion: string | null;
  pais_origen_iso: string | null;
  estado: EstadoTaxonomia;
  logo_url?: string | null;
}

export interface TaxonomyRepository {
  findCategoriasActivas(): Promise<CategoriaRow[]>;
  findCategoriaAdmin(id: string): Promise<CategoriaAdminRow | undefined>;
  findMarcasActivas(): Promise<MarcaRow[]>;
}
