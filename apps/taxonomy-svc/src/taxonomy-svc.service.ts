import { Inject, Injectable } from '@nestjs/common';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import { ProblemDetailsException } from './errors/taxonomy.errors.js';
import type {
  CategoriaRow,
  EstadoTaxonomia,
  MarcaRow,
  TaxonomyRepository,
} from './taxonomy.repository.js';

export type EstadoEntidad = 'ACTIVA' | 'INACTIVA';

export interface CategoriaDto {
  categoria_id: string;
  parent_id: string | null;
  name: string;
  status: EstadoEntidad;
}

export interface MarcaDto {
  marca_id: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  country_code: string | null;
  status: EstadoEntidad;
}

export interface CategoriaAdminDto {
  categoriaId: string;
  nombre: string;
  descripcion: string | null;
  categoriaPadreId: string | null;
  orden: number;
  imagenUrl: string | null;
  estado: EstadoTaxonomia;
  version: number;
  slug: string | null;
}

function mapEstado(estado: EstadoTaxonomia): EstadoEntidad {
  if (estado === 'PENDING_DEACTIVATION') {
    throw ProblemDetailsException.noDisponible();
  }
  return estado === 'INACTIVO' ? 'INACTIVA' : 'ACTIVA';
}

function mapCategoria(fila: CategoriaRow): CategoriaDto {
  return {
    categoria_id: fila.id,
    parent_id: fila.categoria_padre_id ?? null,
    name: fila.nombre,
    status: mapEstado(fila.estado),
  };
}

function mapMarca(fila: MarcaRow): MarcaDto {
  return {
    marca_id: fila.id,
    name: fila.nombre,
    description: fila.descripcion ?? null,
    logo_url: fila.logo_url ?? null,
    country_code: fila.pais_origen_iso ?? null,
    status: mapEstado(fila.estado),
  };
}

@Injectable()
export class TaxonomySvcService {
  constructor(
    @Inject(TAXONOMY_REPOSITORY)
    private readonly taxonomyRepository: TaxonomyRepository,
  ) {}

  getHealth() {
    return {
      status: 'ok',
      service: 'taxonomy-svc',
    };
  }

  async listarCategorias(): Promise<{ categories: CategoriaDto[] }> {
    const filas = await this.taxonomyRepository.findCategoriasActivas();
    return {
      categories: filas
        .filter((fila) => fila.estado === 'ACTIVO')
        .map(mapCategoria),
    };
  }

  async obtenerCategoriaAdmin(
    id: string,
  ): Promise<CategoriaAdminDto | undefined> {
    const fila = await this.taxonomyRepository.findCategoriaAdmin(id);
    if (!fila) return undefined;
    return {
      categoriaId: fila.id,
      nombre: fila.nombre,
      descripcion: fila.descripcion,
      categoriaPadreId: fila.categoria_padre_id,
      orden: fila.orden,
      imagenUrl: fila.imagen_url,
      estado:
        fila.estado === 'PENDING_DEACTIVATION'
          ? this.estadoAdminNoRepresentable()
          : fila.estado,
      version: fila.version,
      slug: fila.slug,
    };
  }

  private estadoAdminNoRepresentable(): never {
    throw ProblemDetailsException.noDisponible(
      'El contrato CategoriaAdmin no representa el estado pendiente de baja.',
    );
  }

  async listarMarcas(): Promise<{ brands: MarcaDto[] }> {
    const filas = await this.taxonomyRepository.findMarcasActivas();
    return {
      brands: filas.filter((fila) => fila.estado === 'ACTIVO').map(mapMarca),
    };
  }
}
