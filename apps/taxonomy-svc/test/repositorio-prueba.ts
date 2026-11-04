import { ProblemDetailsException } from '../src/errors/taxonomy.errors.js';
import type { TaxonomyReadinessIndicator } from '../src/health/readiness.port.js';
import type {
  CategoriaRow,
  MarcaRow,
  TaxonomyRepository,
} from '../src/taxonomy.repository.js';

export class RepositorioPrueba
  implements TaxonomyRepository, TaxonomyReadinessIndicator
{
  categorias: CategoriaRow[] = [];
  marcas: MarcaRow[] = [];
  falla = false;
  listo = true;
  detalleFallo = 'conexion con el esquema taxonomy rechazada';
  errorTablas: (Error & { code?: string }) | null = null;

  async findCategoriasActivas(): Promise<CategoriaRow[]> {
    if (this.falla) {
      throw new Error(this.detalleFallo);
    }
    return this.categorias;
  }

  async findCategoriaAdmin(id: string) {
    if (this.falla) throw new Error(this.detalleFallo);
    const categoria = this.categorias.find((fila) => fila.id === id);
    if (!categoria) return undefined;
    return {
      id: categoria.id,
      nombre: categoria.nombre,
      descripcion: null,
      categoria_padre_id: categoria.categoria_padre_id,
      orden: 0,
      imagen_url: null,
      estado: categoria.estado,
      version: 0,
      slug: null,
    };
  }

  async findMarcasActivas(): Promise<MarcaRow[]> {
    if (this.falla) {
      throw new Error(this.detalleFallo);
    }
    return this.marcas;
  }

  async verificarReadiness(): Promise<void> {
    if (this.errorTablas) {
      throw ProblemDetailsException.noDisponible(
        'Base de datos de taxonomia no disponible.',
      );
    }
    if (!this.listo) {
      throw ProblemDetailsException.noDisponible(
        'Fuente de datos de taxonomía no disponible.',
      );
    }
  }
}
