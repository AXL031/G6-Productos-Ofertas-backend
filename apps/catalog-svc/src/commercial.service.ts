import {
  Inject,
  Injectable,
  HttpException,
  ForbiddenException,
  ServiceUnavailableException,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { CatalogConfig } from './config.js';
import { CatalogTelemetry } from './catalog-telemetry.js';
import { CatalogPriceFilter } from './catalog-price-filter.js';
import { DEMO_PRICING, type CurrentProductPrice } from './pricing.client.js';
import type {
  ProductQuery,
  ProductDetail,
  ProductPage,
  DemoProduct,
  ProductSummary,
} from './commercial.types.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { TaxonomyClient } from './taxonomy.client.js';
import type { TaxonomyIdentity } from './taxonomy.client.js';
import {
  CATALOG_READ_DEMO,
  type CatalogReadDemo,
} from './catalog-read-demo.js';

@Injectable()
export class CommercialService {
  constructor(
    private readonly repository: PostgresCatalogRepository,
    private readonly taxonomy: TaxonomyClient,
    @Optional()
    @Inject(CATALOG_READ_DEMO)
    private readonly readDemo: CatalogReadDemo = { enabled: false },
    @Optional() private readonly config?: CatalogConfig,
    @Optional()
    @Inject(DEMO_PRICING)
    private readonly pricing?: {
      currentPrice(
        id: string,
        timeoutMs?: number,
        correlationId?: string,
      ): Promise<CurrentProductPrice | null>;
    },
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

  private demoEnabled(query: ProductQuery): boolean {
    return (
      this.config?.marketplaceDemoPreview === true &&
      query.canal === 'MARKETPLACE'
    );
  }

  private async demoPrices<T extends { product_id: string }>(
    rows: T[],
    correlationId?: string,
  ): Promise<Array<T & CurrentProductPrice>> {
    if (!this.pricing) throw new ServiceUnavailableException();
    const output: Array<T & CurrentProductPrice> = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < rows.length) {
        const index = cursor++;
        const price = await this.pricing!.currentPrice(
          rows[index].product_id,
          undefined,
          correlationId,
        );
        if (price) output[index] = Object.assign(rows[index], price);
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, rows.length) }, worker),
      );
    } catch {
      throw new ServiceUnavailableException();
    }
    return output.filter(
      (row): row is T & CurrentProductPrice => row !== undefined,
    );
  }
  async list(
    query: ProductQuery,
    correlationId?: string,
    administrativeState = false,
    identity?: TaxonomyIdentity,
  ): Promise<ProductPage> {
    const monetary =
      query.precioMin !== undefined || query.precioMax !== undefined;
    // Administrative non-active and demo searches retain their previous scope.
    if (
      monetary &&
      (this.readDemo.enabled ||
        this.demoEnabled(query) ||
        (query.estado !== undefined && query.estado !== 'ACTIVO'))
    )
      throw new ServiceUnavailableException();
    if (!this.readDemo.enabled && this.demoEnabled(query)) {
      return this.telemetry.measure(
        'DEMO_LIST_TOTAL',
        async () => {
          if (query.estado !== undefined)
            throw new BadRequestException(
              'estado no está disponible en preview',
            );
          if (query.categoriaId !== undefined)
            await this.taxonomy.category(query.categoriaId, correlationId);
          if (query.marcaId !== undefined)
            await this.taxonomy.brand(query.marcaId, correlationId);
          let candidates: ProductSummary[];
          try {
            candidates = await this.repository.listDemoCandidates(
              query,
              100,
              correlationId,
            );
          } catch {
            throw new ServiceUnavailableException();
          }
          const priced = await this.telemetry.measure(
            'DEMO_PRICING',
            () => this.demoPrices(candidates, correlationId),
            correlationId,
          );
          const ordered = priced.sort((a, b) => {
            const order = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
            const idOrder =
              a.product_id < b.product_id
                ? -1
                : a.product_id > b.product_id
                  ? 1
                  : 0;
            return (query.orden === 'NOMBRE_DESC' ? -order : order) || idOrder;
          });
          const start = (query.pagina - 1) * query.tamanio;
          return {
            items: ordered.slice(start, start + query.tamanio) as DemoProduct[],
            pagina: query.pagina,
            tamanio: query.tamanio,
            total: ordered.length,
          };
        },
        correlationId,
      );
    }
    if (query.categoriaId !== undefined)
      await this.taxonomy.category(query.categoriaId, correlationId, identity);
    if (query.marcaId !== undefined)
      await this.taxonomy.brand(query.marcaId, correlationId, identity);
    const isAdministrativeState =
      query.estado !== undefined && query.estado !== 'ACTIVO';
    if (isAdministrativeState && !administrativeState)
      throw new ForbiddenException();
    if (this.readDemo.enabled)
      return this.repository.listCandidates(query, true);
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
    if (!this.readDemo.enabled && this.demoEnabled(query)) {
      let product: Awaited<
        ReturnType<PostgresCatalogRepository['findDemoCandidateBySlug']>
      >;
      try {
        product = await this.repository.findDemoCandidateBySlug(slug);
      } catch {
        throw new ServiceUnavailableException();
      }
      if (!product)
        throw new HttpException({ code: 'PRODUCTO_NO_ENCONTRADO' }, 404);
      if (!this.pricing) throw new ServiceUnavailableException();
      let price: CurrentProductPrice | null;
      try {
        price = await this.pricing.currentPrice(
          product.product_id,
          undefined,
          correlationId,
        );
      } catch {
        throw new ServiceUnavailableException();
      }
      if (!price)
        throw new HttpException({ code: 'PRODUCTO_NO_ENCONTRADO' }, 404);
      try {
        return {
          ...product,
          ...price,
          marca: await this.taxonomy.brand(product.marca_id, correlationId),
        };
      } catch {
        throw new ServiceUnavailableException();
      }
    }
    const product = this.readDemo.enabled
      ? await this.repository.findCandidateBySlug(slug, query.canal, true)
      : await this.read(() =>
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
    const product = this.readDemo.enabled
      ? await this.repository.findCandidateByProductId(productId, canal, true)
      : await this.read(() =>
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
