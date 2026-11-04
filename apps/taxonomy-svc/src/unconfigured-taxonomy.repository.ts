import { ProblemDetailsException } from './errors/taxonomy.errors.js';
import type { TaxonomyReadinessIndicator } from './health/readiness.port.js';
import type {
  CategoriaRow,
  MarcaRow,
  TaxonomyRepository,
} from './taxonomy.repository.js';

export class UnconfiguredTaxonomyRepository
  implements TaxonomyRepository, TaxonomyReadinessIndicator
{
  async findCategoriasActivas(): Promise<CategoriaRow[]> {
    throw ProblemDetailsException.noDisponible(
      'Fuente de datos de taxonomía no configurada: registra un proveedor TAXONOMY_REPOSITORY para consultar categorías.',
    );
  }

  async findCategoriaAdmin(): Promise<never> {
    throw ProblemDetailsException.noDisponible(
      'Fuente de datos de taxonomía no configurada para consultar categorías.',
    );
  }

  async findMarcasActivas(): Promise<MarcaRow[]> {
    throw ProblemDetailsException.noDisponible(
      'Fuente de datos de taxonomía no configurada: registra un proveedor TAXONOMY_REPOSITORY para consultar marcas.',
    );
  }

  async verificarReadiness(): Promise<void> {
    throw ProblemDetailsException.noDisponible(
      'Fuente de datos de taxonomía no configurada: registra un proveedor TAXONOMY_REPOSITORY para habilitar la readiness.',
    );
  }
}
