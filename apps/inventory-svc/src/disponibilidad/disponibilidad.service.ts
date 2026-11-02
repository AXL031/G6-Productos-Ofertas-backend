import { Injectable, Inject } from '@nestjs/common';
import { loadInventoryConfig } from '../config/inventory.config.js';
import {
  CanalComercial,
  ConsultaDisponibilidadResponse,
  ConsultaDisponibilidadComercialResponse,
  DisponibilidadComercial,
  DisponibilidadStock,
  EstadoStock,
  VerificarCantidadComercialRequest,
  VerificarCantidadComercialResponse,
  VerificarCantidadComercialItem,
} from '../types/inventory.dto.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  STOCK_BALANCE_REPOSITORY,
  COMMERCIAL_ROUTES_REPOSITORY,
} from '../repositories/interfaces/repository.tokens.js';
import type { IStockBalanceRepository } from '../repositories/interfaces/stock-balance.repository.interface.js';
import type { ICommercialRoutesRepository } from '../repositories/interfaces/commercial-routes.repository.interface.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_FULFILLMENT_MODES = [
  'ENVIO_DOMICILIO',
  'RETIRO_TIENDA',
  'VENTA_TIENDA',
];

const CANALES_COMERCIALES: readonly CanalComercial[] = [
  'MARKETPLACE',
  'CHATBOT',
  'RETAIL',
];

@Injectable()
export class DisponibilidadService {
  constructor(
    @Inject(STOCK_BALANCE_REPOSITORY)
    private readonly stockBalanceRepository: IStockBalanceRepository,
    @Inject(COMMERCIAL_ROUTES_REPOSITORY)
    private readonly commercialRoutesRepository: ICommercialRoutesRepository,
  ) {}

  /**
   * Consulta la disponibilidad autoritativa detallada por SKU y ubicación (GET /api/v1/inventario/disponibilidad)
   */
  async consultarDisponibilidad(
    skus: string[],
    locationId?: string,
    correlationId?: string,
  ): Promise<ConsultaDisponibilidadResponse> {
    if (!Array.isArray(skus) || skus.length === 0) {
      throw ProblemDetailsException.validation(
        'El parámetro skus es obligatorio y debe contener al menos un elemento',
        correlationId,
      );
    }
    if (skus.length > 100) {
      throw ProblemDetailsException.validation(
        'El parámetro skus no puede exceder 100 elementos',
        correlationId,
      );
    }
    if (
      locationId !== undefined &&
      (typeof locationId !== 'string' || !UUID_REGEX.test(locationId))
    ) {
      throw ProblemDetailsException.validation(
        'location_id debe ser un UUID válido',
        correlationId,
      );
    }

    const config = loadInventoryConfig();
    const defaultThreshold = config.defaultLowStockThreshold;

    // Obtener overrides de umbral
    const thresholdOverrides =
      await this.stockBalanceRepository.findThresholdOverrides();

    let globalThreshold = defaultThreshold;
    const skuThresholdMap = new Map<string, number>();

    for (const row of thresholdOverrides) {
      if (row.sku_id === null) {
        globalThreshold = Number(row.umbral_efectivo);
      } else {
        skuThresholdMap.set(row.sku_id, Number(row.umbral_efectivo));
      }
    }

    // Consultar saldos a través del repositorio
    const balances = await this.stockBalanceRepository.findBySkus(
      skus,
      locationId,
    );

    if (
      locationId === undefined &&
      new Set(balances.map((row) => row.location_id)).size > 1
    ) {
      throw ProblemDetailsException.validation(
        'Debe especificar location_id cuando hay más de una ubicación de inventario',
        correlationId,
      );
    }

    const items: DisponibilidadStock[] = balances.map((row) => {
      const onHand = Number(row.on_hand);
      const reserved = Number(row.reserved);
      const blocked = Number(row.blocked);
      const available = Math.max(0, onHand - reserved - blocked);

      const threshold = skuThresholdMap.get(row.sku_id) ?? globalThreshold;

      return {
        sku: row.sku_id,
        location_id: row.location_id,
        on_hand: onHand,
        reserved,
        blocked,
        available,
        status: this.clasificarEstado(available, threshold),
        threshold,
      };
    });

    return { items };
  }

  /**
   * Proyección comercial informativa (GET /api/v1/inventario/disponibilidad/comercial).
   * No expone cantidades ni ubicación interna. Conforme a D-INV-01: si no existe
   * una ruta de cumplimiento única y ejecutable, el estado es INDETERMINADO
   * (nunca AGOTADO por ausencia de ruta).
   */
  async consultarDisponibilidadComercial(
    skus: string[],
    canal: CanalComercial,
    correlationId?: string,
  ): Promise<ConsultaDisponibilidadComercialResponse> {
    if (!CANALES_COMERCIALES.includes(canal)) {
      throw ProblemDetailsException.validation(
        `El parámetro canal '${canal}' no pertenece a ${CANALES_COMERCIALES.join(', ')}`,
        correlationId,
      );
    }
    if (!Array.isArray(skus) || skus.length === 0) {
      throw ProblemDetailsException.validation(
        'El parámetro skus es obligatorio y debe contener al menos un elemento',
        correlationId,
      );
    }
    if (skus.length > 100) {
      throw ProblemDetailsException.validation(
        'El parámetro skus no puede exceder 100 elementos',
        correlationId,
      );
    }

    const uniqueSkus = [...new Set(skus)];

    // D-INV-01: una sola ubicación física elegible por canal de cumplimiento.
    const targetLocationId =
      await this.commercialRoutesRepository.findActiveByChannel(canal);

    if (!targetLocationId) {
      const items: DisponibilidadComercial[] = uniqueSkus.map((sku) => ({
        sku,
        status: 'INDETERMINADO',
      }));
      return { items };
    }

    const { globalThreshold, skuThresholdMap } =
      await this.resolverUmbralesEfectivos();

    const balances = await this.stockBalanceRepository.findBySkus(
      uniqueSkus,
      targetLocationId,
    );
    const balanceBySku = new Map(balances.map((row) => [row.sku_id, row]));

    const items: DisponibilidadComercial[] = uniqueSkus.map((sku) => {
      const row = balanceBySku.get(sku);
      if (!row) {
        // Sin saldo no se ha demostrado la existencia/evaluabilidad del SKU (HU-015 CA-46).
        return { sku, status: 'INDETERMINADO' };
      }
      const available = Math.max(
        0,
        Number(row.on_hand) - Number(row.reserved) - Number(row.blocked),
      );
      const threshold = skuThresholdMap.get(sku) ?? globalThreshold;
      return { sku, status: this.clasificarEstado(available, threshold) };
    });

    return { items };
  }

  /**
   * Resuelve el umbral efectivo global y por SKU a partir de los overrides
   * persistidos y del umbral por defecto configurado.
   */
  private async resolverUmbralesEfectivos(): Promise<{
    globalThreshold: number;
    skuThresholdMap: Map<string, number>;
  }> {
    const defaultThreshold = loadInventoryConfig().defaultLowStockThreshold;
    const thresholdOverrides =
      await this.stockBalanceRepository.findThresholdOverrides();

    let globalThreshold = defaultThreshold;
    const skuThresholdMap = new Map<string, number>();

    for (const row of thresholdOverrides) {
      if (row.sku_id === null) {
        globalThreshold = Number(row.umbral_efectivo);
      } else {
        skuThresholdMap.set(row.sku_id, Number(row.umbral_efectivo));
      }
    }

    return { globalThreshold, skuThresholdMap };
  }

  /**
   * Clasifica el estado de stock a partir de las unidades disponibles y el umbral.
   */
  private clasificarEstado(available: number, threshold: number): EstadoStock {
    if (available === 0) {
      return 'AGOTADO';
    }
    if (available <= threshold) {
      return 'STOCK_BAJO';
    }
    return 'DISPONIBLE';
  }

  /**
   * Verificación comercial de cantidades conforme a la política D-INV-01 (POST /api/v1/inventario/disponibilidad/comercial/verificar)
   */
  async verificarCantidadComercial(
    dto: VerificarCantidadComercialRequest,
    correlationId?: string,
  ): Promise<VerificarCantidadComercialResponse> {
    if (
      !dto ||
      typeof dto !== 'object' ||
      Array.isArray(dto) ||
      Object.keys(dto).some(
        (key) => !['channel_id', 'fulfillment', 'lines'].includes(key),
      ) ||
      !CANALES_COMERCIALES.some((canal) => canal === dto.channel_id) ||
      !Array.isArray(dto.lines) ||
      dto.lines.length === 0
    ) {
      throw ProblemDetailsException.validation(
        'Solicitud inválida para verificación comercial',
        correlationId,
      );
    }

    // Validar objeto fulfillment
    if (
      !dto.fulfillment ||
      typeof dto.fulfillment !== 'object' ||
      Array.isArray(dto.fulfillment) ||
      typeof dto.fulfillment.mode !== 'string' ||
      Object.keys(dto.fulfillment).some(
        (key) => !['mode', 'fulfillment_ref'].includes(key),
      )
    ) {
      throw ProblemDetailsException.validation(
        'El objeto fulfillment con su modo es obligatorio en la verificación comercial',
        correlationId,
      );
    }

    if (!VALID_FULFILLMENT_MODES.includes(dto.fulfillment.mode)) {
      throw ProblemDetailsException.contextoAbastecimientoInvalido(
        `Modo de fulfillment inválido '${dto.fulfillment.mode}'. Valores permitidos: ${VALID_FULFILLMENT_MODES.join(', ')}`,
        correlationId,
      );
    }

    if (
      dto.fulfillment.fulfillment_ref !== undefined &&
      dto.fulfillment.fulfillment_ref !== null &&
      (typeof dto.fulfillment.fulfillment_ref !== 'string' ||
        dto.fulfillment.fulfillment_ref.trim().length === 0)
    ) {
      throw ProblemDetailsException.contextoAbastecimientoInvalido(
        'fulfillment_ref debe ser una cadena no vacía cuando se proporcione',
        correlationId,
      );
    }

    if (dto.lines.length > 100) {
      throw ProblemDetailsException.validation(
        'El número máximo de líneas permitidas en la verificación comercial es 100',
        correlationId,
      );
    }

    for (const line of dto.lines) {
      if (
        !line ||
        typeof line !== 'object' ||
        Array.isArray(line) ||
        !line.sku ||
        typeof line.sku !== 'string' ||
        Object.keys(line).some((key) => !['sku', 'quantity'].includes(key))
      ) {
        throw ProblemDetailsException.validation(
          'Cada línea debe especificar sku',
          correlationId,
        );
      }
      if (
        typeof line.quantity !== 'number' ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity <= 0
      ) {
        throw ProblemDetailsException.validation(
          'La cantidad debe ser un entero positivo',
          correlationId,
        );
      }
    }

    const evaluatedAt = new Date().toISOString();

    // D-INV-01: resolución de ruta de cumplimiento unívoca
    const targetLocationId =
      await this.commercialRoutesRepository.findActiveByChannelAndFulfillment(
        dto.channel_id,
        dto.fulfillment.mode,
        dto.fulfillment.fulfillment_ref ?? null,
      );

    // Si falta la correspondencia o es ambigua: devolver INDETERMINADO sin mutar ni inventar almacén
    if (!targetLocationId) {
      const indeterminateItems: VerificarCantidadComercialItem[] =
        dto.lines.map((line) => ({
          sku: line.sku,
          requested_quantity: line.quantity,
          result: 'INDETERMINADO',
          reason_code: 'RUTA_CUMPLIMIENTO_NO_RESUELTA',
        }));

      return {
        evaluated_at: evaluatedAt,
        binding: false,
        items: indeterminateItems,
      };
    }

    // Ubicación resuelta: verificar capacidad en esa ubicación única
    const items: VerificarCantidadComercialItem[] = [];

    // Evaluar todas las líneas contra el mismo snapshot, incluida la demanda repetida de un SKU.
    const requestedBySku = new Map<string, number>();
    for (const line of dto.lines) {
      requestedBySku.set(
        line.sku,
        (requestedBySku.get(line.sku) ?? 0) + line.quantity,
      );
    }
    const balances = await this.stockBalanceRepository.findBySkus(
      [...requestedBySku.keys()],
      targetLocationId,
    );
    const balanceBySku = new Map(balances.map((row) => [row.sku_id, row]));

    for (const line of dto.lines) {
      const bal = balanceBySku.get(line.sku);

      if (!bal) {
        items.push({
          sku: line.sku,
          requested_quantity: line.quantity,
          result: 'INDETERMINADO',
        });
        continue;
      }

      const available = Math.max(
        0,
        Number(bal.on_hand) - Number(bal.reserved) - Number(bal.blocked),
      );

      if (available >= requestedBySku.get(line.sku)!) {
        items.push({
          sku: line.sku,
          requested_quantity: line.quantity,
          result: 'SUFICIENTE',
          reason_code: null,
        });
      } else {
        items.push({
          sku: line.sku,
          requested_quantity: line.quantity,
          result: 'INSUFICIENTE',
          reason_code: 'STOCK_INSUFICIENTE',
        });
      }
    }

    return {
      evaluated_at: evaluatedAt,
      binding: false,
      items,
    };
  }
}
