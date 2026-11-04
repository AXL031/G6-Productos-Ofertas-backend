import {
  BadRequestException,
  HttpException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CatalogQueryRepository } from './catalog-query.repository.js';
import { CommercialService } from './commercial.service.js';
import type { Canal } from './commercial.types.js';
import type { TaxonomyIdentity } from './taxonomy.client.js';
import { BarcodeService } from './barcode.service.js';

const channels: readonly Canal[] = [
  'MARKETPLACE',
  'CHATBOT',
  'RETAIL',
  'VENTAS',
];

export function parseVariantPage(input: Record<string, unknown>): {
  pagina: number;
  tamanio: number;
  estado?: 'BORRADOR' | 'ACTIVA' | 'INACTIVA';
} {
  for (const [key, value] of Object.entries(input))
    if (
      !['pagina', 'tamanio', 'estado'].includes(key) ||
      typeof value !== 'string'
    )
      throw new BadRequestException();
  const parseInteger = (
    key: 'pagina' | 'tamanio',
    fallback: number,
    max: number,
  ) => {
    const value = input[key];
    if (value === undefined) return fallback;
    if (
      typeof value !== 'string' ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1 ||
      Number(value) > max
    )
      throw new BadRequestException();
    return Number(value);
  };
  const pagina = parseInteger('pagina', 1, Number.MAX_SAFE_INTEGER);
  const tamanio = parseInteger('tamanio', 20, 200);
  if (!Number.isSafeInteger((pagina - 1) * tamanio))
    throw new BadRequestException();
  const status = input.estado;
  if (
    status !== undefined &&
    !['BORRADOR', 'ACTIVA', 'INACTIVA'].includes(String(status))
  )
    throw new BadRequestException();
  return {
    pagina,
    tamanio,
    estado: status as 'BORRADOR' | 'ACTIVA' | 'INACTIVA' | undefined,
  };
}

@Injectable()
export class CatalogQueryService {
  constructor(
    private readonly repository: CatalogQueryRepository,
    private readonly commercial: CommercialService,
    @Optional() private readonly barcode?: BarcodeService,
  ) {}

  product(
    productId: string,
    channel: unknown,
    correlationId?: string,
    identity?: TaxonomyIdentity,
  ) {
    if (
      (channel === undefined &&
        !(identity?.user || identity?.restrictedDemo)) ||
      (channel !== undefined &&
        (typeof channel !== 'string' || !channels.includes(channel as Canal)))
    )
      throw new BadRequestException();
    return this.commercial.productById(
      productId,
      channel as Canal | undefined,
      correlationId,
      identity,
    );
  }

  async physicalData(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException();
    const skus = (body as Record<string, unknown>).skus;
    if (
      !Array.isArray(skus) ||
      skus.length < 1 ||
      skus.length > 100 ||
      !skus.every((sku) => typeof sku === 'string' && sku.length > 0) ||
      new Set(skus).size !== skus.length
    )
      throw new HttpException({ code: 'SKU_INVALIDO' }, 422);
    try {
      return await this.repository.physicalData(skus);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 422)
        throw error;
      throw new ServiceUnavailableException();
    }
  }

  async preparation(productId: string) {
    const result = await this.repository.productPreparation(productId);
    if (!result)
      throw new HttpException({ code: 'PRODUCTO_NO_ENCONTRADO' }, 404);
    return result;
  }

  async variants(productId: string, input: Record<string, unknown>) {
    const page = parseVariantPage(input);
    const result = await this.repository.listVariants(
      productId,
      page.pagina,
      page.tamanio,
      page.estado,
    );
    if (!result)
      throw new HttpException({ code: 'PRODUCTO_NO_ENCONTRADO' }, 404);
    return result;
  }

  async variant(productId: string, variantId: string) {
    const result = await this.repository.findVariant(productId, variantId);
    if (!result)
      throw new HttpException({ code: 'VARIANTE_NO_ENCONTRADA' }, 404);
    return result;
  }

  resolveBarcode(body: unknown): Promise<{ sku: string }> {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'codigo_barras') ||
      typeof (body as Record<string, unknown>).codigo_barras !== 'string' ||
      (body as Record<string, string>).codigo_barras.length === 0
    )
      throw new BadRequestException();
    if (!this.barcode) throw new ServiceUnavailableException();
    return this.barcode.resolve((body as Record<string, string>).codigo_barras);
  }
}
