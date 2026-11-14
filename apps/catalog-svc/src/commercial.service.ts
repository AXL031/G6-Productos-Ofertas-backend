import {
  Injectable,
  HttpException,
  ForbiddenException,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { CatalogTelemetry } from './catalog-telemetry.js';
import { CatalogPriceFilter } from './catalog-price-filter.js';
import type {
  ProductQuery,
  ProductDetail,
  ProductPage,
} from './commercial.types.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { TaxonomyClient } from './taxonomy.client.js';
import type { TaxonomyIdentity } from './taxonomy.client.js';

@Injectable()
export class CommercialService {
  constructor(
    private readonly repository: PostgresCatalogRepository,
    private readonly taxonomy: TaxonomyClient,
    @Optional() private readonly priceFilter?: CatalogPriceFilter,
    @Optional()
    private readonly telemetry: CatalogTelemetry = new CatalogTelemetry(),
  ) {}

  private async read<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new ServiceUnavailableException();
    }
  }

  async list(
    query: ProductQuery,
    correlationId?: string,
    administrativeState = false,
    identity?: TaxonomyIdentity,
  ): Promise<ProductPage> {
    const monetary =
      query.precioMin !== undefined || query.precioMax !== undefined;
    if (monetary && query.estado !== undefined && query.estado !== 'ACTIVO')
      throw new ServiceUnavailableException();
    if (query.categoriaId !== undefined)
      await this.taxonomy.category(query.categoriaId, correlationId, identity);
    if (query.marcaId !== undefined)
      await this.taxonomy.brand(query.marcaId, correlationId, identity);
    const isAdministrativeState =
      query.estado !== undefined && query.estado !== 'ACTIVO';
    if (isAdministrativeState && !administrativeState)
      throw new ForbiddenException();
    if (monetary)
      return this.read(async () => {
        if (!this.priceFilter) throw new ServiceUnavailableException();
        const candidates = await this.repository.priceCandidates(query);
        const productIds = await this.priceFilter.matchingProducts(
          candidates,
          query,
          correlationId,
        );
        return this.repository.listCandidates(
          { ...query, precioMin: undefined, precioMax: undefined },
          false,
          productIds,
        );
      });
    return this.read(() => this.repository.listCandidates(query));
  }
  async detail(
    slug: string,
    query: ProductQuery,
    correlationId?: string,
    identity?: TaxonomyIdentity,
  ): Promise<ProductDetail> {
    const product = await this.read(() =>
      this.repository.findCandidateBySlug(slug, query.canal),
    );
    if (!product)
      throw new HttpException({ code: 'PRODUCTO_NO_ENCONTRADO' }, 404);
    try {
      return {
        ...product,
        marca: await this.taxonomy.brand(
          product.marca_id,
          correlationId,
          identity,
        ),
      };
    } catch {
      // La marca obligatoria no se fabrica ni se reemplaza por el ID.
      throw new ServiceUnavailableException();
    }
  }

  async productById(
    productId: string,
    canal: ProductQuery['canal'],
    correlationId?: string,
    identity?: TaxonomyIdentity,
  ): Promise<ProductDetail> {
    const product = await this.read(() =>
      this.repository.findCandidateByProductId(productId, canal),
    );
    if (!product)
      throw new HttpException({ code: 'PRODUCTO_NO_ENCONTRADO' }, 404);
    try {
      return {
        ...product,
        marca: await this.taxonomy.brand(
          product.marca_id,
          correlationId,
          identity,
        ),
      };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
