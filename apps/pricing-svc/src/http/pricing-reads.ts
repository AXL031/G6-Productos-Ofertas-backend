import { Inject, Injectable } from '@nestjs/common';
import { cents, contains, scheduledStatus } from '../domain/price.js';
import { PricingRepository } from '../persistence/pricing.repository.js';
import { PricingHttpError } from './pricing-http.error.js';

const importCodes = new Set([
  'VALIDACION',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'ERROR_INTERNO',
  'SERVICIO_NO_DISPONIBLE',
  'SKU_INVALIDO',
  'SKU_NO_ENCONTRADO',
  'SKU_INACTIVO',
  'PRODUCTO_NO_ENCONTRADO',
  'PRECIO_NO_ENCONTRADO',
  'PRECIO_INVALIDO',
  'OFERTA_INVALIDA',
  'MOTIVO_CAMBIO_REQUERIDO',
  'VIGENCIA_SUPERPUESTA',
  'ACCION_OFERTA_INVALIDA',
  'SCOPE_PRECIO_INVALIDO',
  'ARCHIVO_INVALIDO',
  'ARCHIVO_EXCEDE_LIMITE',
  'PLANTILLA_INCOMPATIBLE',
]);

export function wireVersion(version: bigint): number {
  if (version < 1n || version > BigInt(Number.MAX_SAFE_INTEGER))
    throw new PricingHttpError(500, 'ERROR_INTERNO');
  return Number(version);
}

// OpenAPI publica number; comprobar el viaje decimal sin redondear centavos.
export function wireMoney(value: string): number {
  try {
    const amount = cents(value);
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || cents(String(numeric)) !== amount)
      throw new Error();
    return numeric;
  } catch {
    throw new PricingHttpError(500, 'ERROR_INTERNO');
  }
}

@Injectable()
export class PricingReads {
  constructor(
    @Inject(PricingRepository) private readonly repository: PricingRepository,
  ) {}

  async product(productId: string) {
    const now = new Date();
    const result = await this.repository.readProduct(productId);
    const validity = result?.validities.find((value) => contains(value, now));
    if (!result || !validity)
      throw new PricingHttpError(404, 'PRECIO_NO_ENCONTRADO');
    return {
      product_id: productId,
      precio_regular: wireMoney(validity.precioRegular),
      precio_oferta:
        validity.precioOferta === null
          ? null
          : wireMoney(validity.precioOferta),
      currency: validity.currency,
      channel_id: result.definition.channelId,
      valid_from: validity.validFrom.toISOString(),
      valid_until: validity.validUntil?.toISOString() ?? null,
      price_version: wireVersion(result.definition.priceVersion),
    };
  }

  async schedules(
    target: { productId: string } | { sku: string },
    pagina: number,
    tamanio: number,
  ) {
    const result = await this.repository.readSchedules(target, pagina, tamanio);
    if (!result) throw new PricingHttpError(404, 'PRECIO_NO_ENCONTRADO');
    const now = new Date();
    return {
      items: result.items.map(({ schedule, validity, definition }) => ({
        programacionId: schedule.id,
        ...('productId' in target
          ? { product_id: target.productId }
          : { sku: target.sku }),
        tipoPrecio: schedule.tipoPrecio,
        importe: wireMoney(schedule.importe),
        moneda: validity.currency,
        channelId: definition.channelId,
        validFrom: validity.validFrom.toISOString(),
        validUntil: validity.validUntil?.toISOString() ?? null,
        estado: scheduledStatus(schedule.status, validity, now),
        priceVersion: wireVersion(validity.priceVersion),
      })),
      meta: {
        pagina,
        tamanio,
        total: result.total,
        totalPaginas: Math.ceil(result.total / tamanio),
      },
    };
  }

  async imported(batchId: string) {
    const result = await this.repository.readImport(batchId);
    if (!result) throw new PricingHttpError(404, 'LOTE_NO_ENCONTRADO');
    const { job, rows } = result;
    return {
      batch_id: job.id,
      status: job.status,
      allow_partial: job.allowPartial,
      total_rows: job.totalRows,
      completed_rows: job.completedRows,
      failed_rows: job.failedRows,
      // No exponer row_input, actor, report_uri ni detalles libres persistidos.
      ...(rows === undefined
        ? {}
        : {
            rows: rows.map((row) => ({
              row_id: row.rowId,
              sku: row.sku,
              status: row.status,
              ...(row.code
                ? {
                    code: importCodes.has(row.code)
                      ? row.code
                      : 'ERROR_INTERNO',
                  }
                : {}),
            })),
          }),
    };
  }
}
