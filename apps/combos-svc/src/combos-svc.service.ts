import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CatalogSkuContextClient,
  IntegrationFailure,
} from './integrations/catalog-sku-context.client.js';
import { PricingClient, sumPrice } from './integrations/pricing.client.js';
import { CombosDatabase } from './persistence/combos.database.js';
import {
  CombosRepository,
  type ComboAggregate,
  type ComboComponentRecord,
} from './persistence/combos.repository.js';

export interface ComponentInput {
  sku: string;
  cantidad: number;
}
export interface ComboInput {
  nombre?: string;
  descripcion?: string | null;
  componentes?: ComponentInput[];
  precioCombo?: number;
  version?: number;
}
export class ComboError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function decimal(value: unknown): bigint {
  const text = String(value);
  if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(text))
    throw new ComboError(400, 'VALIDACION', 'Precio inválido');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
function priceString(cents: bigint): string {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
function wire(aggregate: ComboAggregate) {
  return {
    combo_id: aggregate.combo.id,
    status: aggregate.combo.status,
    price: Number(aggregate.combo.comboPrice),
    components: aggregate.components.map((item: ComboComponentRecord) => ({
      sku: item.sku,
      quantity: item.quantity,
    })),
    informative_availability: null,
    calculated_at: null,
    freshness: null,
    name: aggregate.combo.name,
    description: aggregate.combo.description,
    version: Number(aggregate.combo.version),
  };
}

@Injectable()
export class CombosSvcService {
  constructor(
    private readonly database: CombosDatabase,
    private readonly repository: CombosRepository,
  ) {}

  getHealth() {
    return { status: 'ok', service: 'combos-svc' };
  }
  async readiness() {
    return (await this.database.ready())
      ? {
          status: 'ok',
          service: 'combos-svc',
          dependencies: { postgres: 'ok' },
        }
      : {
          status: 'error',
          service: 'combos-svc',
          dependencies: { postgres: 'error' },
        };
  }

  async get(id: string) {
    const aggregate = await this.repository.get(id);
    if (!aggregate)
      throw new ComboError(404, 'COMBO_NO_ENCONTRADO', 'Combo no encontrado');
    return wire(aggregate);
  }

  async list(query: Record<string, string | undefined>) {
    if (
      Object.keys(query).some(
        (key) => !['pagina', 'tamanio', 'estado'].includes(key),
      )
    )
      throw new ComboError(400, 'VALIDACION', 'Filtro no permitido');
    const pagina = Number(query.pagina ?? 1);
    const tamanio = Number(query.tamanio ?? 20);
    if (
      !Number.isInteger(pagina) ||
      pagina < 1 ||
      !Number.isInteger(tamanio) ||
      tamanio < 1 ||
      tamanio > 200 ||
      (query.estado !== undefined &&
        !['ACTIVO', 'INACTIVO'].includes(query.estado))
    )
      throw new ComboError(400, 'VALIDACION', 'Paginación inválida');
    const result = await this.repository.list({
      page: pagina,
      size: tamanio,
      ...(query.estado === undefined
        ? {}
        : { status: query.estado as 'ACTIVO' | 'INACTIVO' }),
    });
    return {
      items: result.items.map(wire),
      meta: {
        pagina,
        tamanio,
        total: result.total,
        totalPaginas: Math.ceil(result.total / tamanio),
      },
    };
  }

  private validateComponents(components: ComponentInput[] | undefined) {
    if (!Array.isArray(components) || components.length < 2)
      throw new ComboError(
        422,
        'COMBO_COMPONENTES_INSUFICIENTES',
        'El combo requiere al menos dos componentes',
      );
    const seen = new Set<string>();
    for (const item of components) {
      if (
        !item ||
        typeof item.sku !== 'string' ||
        !item.sku.trim() ||
        !Number.isSafeInteger(item.cantidad) ||
        item.cantidad < 1
      )
        throw new ComboError(400, 'VALIDACION', 'Componente inválido');
      if (seen.has(item.sku))
        throw new ComboError(
          422,
          'COMBO_COMPONENTE_DUPLICADO',
          'Hay componentes repetidos',
        );
      seen.add(item.sku);
    }
  }
  private validateCreate(input: ComboInput) {
    if (
      !input ||
      typeof input !== 'object' ||
      typeof input.nombre !== 'string' ||
      !input.nombre.trim() ||
      (input.descripcion !== undefined &&
        input.descripcion !== null &&
        typeof input.descripcion !== 'string')
    )
      throw new ComboError(400, 'VALIDACION', 'Solicitud inválida');
    this.validateComponents(input.componentes);
    if (input.precioCombo === undefined)
      throw new ComboError(400, 'VALIDACION', 'precioCombo es requerido');
    decimal(input.precioCombo);
  }

  private async validateReferences(
    items: ComponentInput[],
    comboPrice: bigint,
    correlationId: string = randomUUID(),
  ): Promise<string> {
    const catalogUrl = process.env.COMBOS_CATALOG_URL;
    const pricingUrl = process.env.COMBOS_PRICING_URL;
    if (
      !catalogUrl ||
      !pricingUrl ||
      process.env.COMBOS_CATALOG_CONTEXT_AUTHORIZED !== 'true'
    )
      throw new ComboError(
        503,
        'SERVICIO_NO_DISPONIBLE',
        'La integración requiere URL, credenciales de servicio y autorización de consumidor de Catalog',
      );
    try {
      const catalog = new CatalogSkuContextClient(
        catalogUrl,
        () => process.env.COMBOS_CATALOG_SERVICE_BEARER,
      );
      for (const item of items)
        await catalog.getContext(item.sku, correlationId);
      const pricing = new PricingClient(
        pricingUrl,
        () => process.env.COMBOS_PRICING_SERVICE_BEARER,
      );
      const prices = await pricing.getPrices(
        items.map((item) => item.sku),
        new Date().toISOString(),
        undefined,
        correlationId,
      );
      const quantities = new Map(
        items.map((item) => [item.sku, item.cantidad]),
      );
      const regular = sumPrice(prices, quantities, 'precio_regular');
      const publicTotal = sumPrice(prices, quantities, 'precio_publico');
      if (
        comboPrice <= 0n ||
        comboPrice >= regular ||
        comboPrice >= publicTotal
      )
        throw new ComboError(
          422,
          'COMBO_PRECIO_INVALIDO',
          'El precio del combo debe ser menor que los totales regular y público',
        );
      return prices[0]!.currency;
    } catch (error) {
      if (error instanceof ComboError) throw error;
      if (
        error instanceof IntegrationFailure &&
        error.dependency === 'CATALOG' &&
        ['SKU_NO_ENCONTRADO', 'SKU_INACTIVO', 'SKU_INELEGIBLE'].includes(
          error.reason,
        )
      )
        throw new ComboError(
          404,
          'SKU_NO_ENCONTRADO',
          error.reason === 'SKU_NO_ENCONTRADO'
            ? 'SKU no encontrado'
            : error.reason === 'SKU_INACTIVO'
              ? 'SKU inactivo'
              : 'SKU inelegible para combos',
        );
      throw new ComboError(
        503,
        'SERVICIO_NO_DISPONIBLE',
        'Servicio temporalmente no disponible',
      );
    }
  }

  async create(input: ComboInput, correlationId?: string) {
    this.validateCreate(input);
    const components = input.componentes!;
    const price = decimal(input.precioCombo!);
    const currency = await this.validateReferences(
      components,
      price,
      correlationId,
    );
    const id = await this.repository.create({
      name: input.nombre!,
      description: input.descripcion ?? null,
      price: priceString(price),
      currency,
      components: components.map((item) => ({
        sku: item.sku,
        quantity: item.cantidad,
      })),
    });
    return this.get(id);
  }

  async update(id: string, input: ComboInput, correlationId?: string) {
    if (!input || typeof input !== 'object')
      throw new ComboError(400, 'VALIDACION', 'Cuerpo inválido');
    if (
      input.nombre !== undefined &&
      (typeof input.nombre !== 'string' || !input.nombre.trim())
    )
      throw new ComboError(400, 'VALIDACION', 'nombre inválido');
    if (
      input.descripcion !== undefined &&
      input.descripcion !== null &&
      typeof input.descripcion !== 'string'
    )
      throw new ComboError(400, 'VALIDACION', 'descripcion inválida');
    if (input.componentes !== undefined)
      this.validateComponents(input.componentes);
    if (input.precioCombo !== undefined) decimal(input.precioCombo);
    if (
      input.version !== undefined &&
      (!Number.isSafeInteger(input.version) || input.version < 0)
    )
      throw new ComboError(400, 'VALIDACION', 'version inválida');
    const current = await this.repository.get(id);
    if (!current)
      throw new ComboError(404, 'COMBO_NO_ENCONTRADO', 'Combo no encontrado');
    const components =
      input.componentes ??
      current.components.map((item) => ({
        sku: item.sku,
        cantidad: item.quantity,
      }));
    const cents =
      input.precioCombo === undefined
        ? decimal(current.combo.comboPrice)
        : decimal(input.precioCombo);
    const expectedVersion =
      input.version === undefined
        ? current.combo.version
        : BigInt(input.version);
    const currency =
      input.componentes === undefined && input.precioCombo === undefined
        ? current.combo.currency.trim()
        : await this.validateReferences(components, cents, correlationId);
    const changed = await this.repository.update(id, {
      name: input.nombre ?? current.combo.name,
      description: Object.hasOwn(input, 'descripcion')
        ? (input.descripcion ?? null)
        : current.combo.description,
      price: priceString(cents),
      currency,
      expectedVersion,
      ...(input.componentes === undefined
        ? {}
        : {
            components: components.map((item) => ({
              sku: item.sku,
              quantity: item.cantidad,
            })),
          }),
    });
    if (!changed) {
      if (!(await this.repository.get(id)))
        throw new ComboError(404, 'COMBO_NO_ENCONTRADO', 'Combo no encontrado');
      throw new ComboError(
        409,
        'VERSION_CONFLICT',
        'La versión del combo cambió',
      );
    }
    return this.get(id);
  }

  async deactivate(id: string) {
    if (!(await this.repository.deactivate(id)))
      throw new ComboError(404, 'COMBO_NO_ENCONTRADO', 'Combo no encontrado');
    return this.get(id);
  }
  async availability(id: string) {
    const combo = await this.get(id);
    return {
      comboId: combo.combo_id,
      verificable: false,
      cantidadInformativa: null,
      calculated_at: new Date().toISOString(),
      estadoActualizacion: 'INCOMPLETA',
    };
  }
  async componentProjections(id: string) {
    if (!(await this.repository.get(id)))
      throw new ComboError(404, 'COMBO_NO_ENCONTRADO', 'Combo no encontrado');
    return this.repository.projections(id);
  }
}
