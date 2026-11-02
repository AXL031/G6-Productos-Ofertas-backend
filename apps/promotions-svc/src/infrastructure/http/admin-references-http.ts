import type {
  AdminReferences,
  AdminReferenceRequest,
  ActiveAdminReferences,
} from '../../domain/admin-references.js';
import { CommercialDependencyError } from '../../domain/commercial-context.js';
import { valid, object } from '../../http/http-validation.js';
import { withDeadline } from '../resilience/deadline.js';
import {
  InternalHttpReader,
  type InternalHttpOptions,
} from './internal-http.js';
import { upstreamSchemas } from './upstream-contract.generated.js';

export class HttpAdminReferences implements AdminReferences {
  private readonly reader: InternalHttpReader;
  constructor(options: InternalHttpOptions) {
    this.reader = new InternalHttpReader(options);
  }
  async verify(
    request: AdminReferenceRequest,
    signal: AbortSignal,
  ): Promise<ActiveAdminReferences> {
    try {
      signal.throwIfAborted();
      return await withDeadline(async (timeout) => {
        const bounded = AbortSignal.any([signal, timeout]);
        const products = new Set<string>(),
          skus = new Set<string>(),
          categories = new Set<string>();
        for (const id of new Set(request.products)) {
          const row = await this.reader.read(
            'obtenerProducto',
            '/productos/' + encodeURIComponent(id),
            bounded,
            true,
          );
          if (row === null) continue; // Not eligible/visible; no claim about administrative existence.
          if (
            !object(row) ||
            !valid(row, upstreamSchemas.ProductoDetalleComercial) ||
            row.product_id !== id
          )
            throw new Error('INVALID_ADMIN_PRODUCT');
          products.add(id);
        }
        for (const sku of new Set(request.skus)) {
          const row = await this.reader.read(
            'obtenerContextoSku',
            '/productos/skus/' + encodeURIComponent(sku) + '/contexto',
            bounded,
            true,
          );
          if (row === null) continue;
          if (
            !object(row) ||
            !valid(row, upstreamSchemas.PricingCatalogContext) ||
            row.sku !== sku ||
            typeof row.productId !== 'string' ||
            !row.productId.trim()
          )
            throw new Error('INVALID_ADMIN_SKU');
          if (row.active && row.eligible) skus.add(sku);
        }
        for (const id of new Set(request.categories)) {
          const row = await this.reader.read(
            'obtenerCategoriaAdmin',
            '/categorias/' + encodeURIComponent(id),
            bounded,
            true,
          );
          if (row === null) continue;
          if (
            !object(row) ||
            !valid(row, upstreamSchemas.CategoriaAdmin) ||
            row.categoriaId !== id
          )
            throw new Error('INVALID_ADMIN_CATEGORY');
          if (row.estado === 'ACTIVO') categories.add(id);
        }
        return { products, skus, categories };
      }, 2500);
    } catch {
      throw new CommercialDependencyError(
        'referencias administrativas',
        'Catálogo/Taxonomía + integración G6',
        'fuentes contractuales disponibles y coherentes; errores técnicos no son referencias ausentes',
      );
    }
  }
}
