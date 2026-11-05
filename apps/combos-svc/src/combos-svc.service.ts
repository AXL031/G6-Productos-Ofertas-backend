import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CatalogSkuContextClient,
  IntegrationFailure,
} from './integrations/catalog-sku-context.client.js';
import { PricingClient, sumPrice } from './integrations/pricing.client.js';
import { CombosServiceIdentity } from './integrations/combos-service-identity.js';
import { CombosDatabase } from './persistence/combos.database.js';
import {
  CatalogComponentDeactivatedError,
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
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'number' && !Number.isFinite(value))
  )
    throw new ComboError(400, 'VALIDACION', 'Precio inválido');
  const text = String(value);
  if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(text))
    throw new ComboError(400, 'VALIDACION', 'Precio inválido');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    @Optional()
    @Inject(CombosServiceIdentity)
    private readonly identity?: CombosServiceIdentity,
  ) {}

  getHealth() {
    return { status: 'ok', service: 'combos-svc' };
  }
  private serviceBearer(
    scope: 'catalogo:leer' | 'precios:leer',
    signal?: AbortSignal,
  ) {
    if (this.identity) return this.identity.authorization(scope, signal);
    if (process.env.COMBOS_TEST_EPHEMERAL === '1')
      return Promise.resolve(
        scope === 'catalogo:leer'
          ? process.env.COMBOS_CATALOG_SERVICE_BEARER
          : process.env.COMBOS_PRICING_SERVICE_BEARER,
      );
    return Promise.resolve(undefined);
  }
  async readiness(
    amqpStatus: 'disabled' | 'ready' | 'not_ready' = process.env
      .COMBOS_AMQP_ENABLED === 'true'
      ? 'not_ready'
      : 'disabled',
  ) {
    const postgresReady = await this.database.ready();
    const amqpRequired =
      process.env.COMBOS_AMQP_ENABLED === 'true' || amqpStatus !== 'disabled';
    const amqpReady = amqpStatus === 'ready';
    const ready = postgresReady && (!amqpRequired || amqpReady);
    return {
      status: ready ? 'ok' : 'error',
      service: 'combos-svc',
      dependencies: {
        postgres: postgresReady ? 'ok' : 'error',
        ...(amqpRequired ? { rabbitmq: amqpReady ? 'ok' : 'error' } : {}),
      },
    };
  }

  async get(id: string) {
    if (!UUID.test(id))
      throw new ComboError(400, 'VALIDACION', 'Identificador inválido');
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
    const paginaTexto = query.pagina ?? '1';
    const tamanioTexto = query.tamanio ?? '20';
    const pagina = Number(paginaTexto);
    const tamanio = Number(tamanioTexto);
    if (
      !/^[1-9]\d*$/.test(paginaTexto) ||
      !/^[1-9]\d*$/.test(tamanioTexto) ||
      !Number.isSafeInteger(pagina) ||
      pagina < 1 ||
      !Number.isSafeInteger(tamanio) ||
      tamanio < 1 ||
      tamanio > 200 ||
      !Number.isSafeInteger((pagina - 1) * tamanio) ||
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
        typeof item !== 'object' ||
        typeof item.sku !== 'string' ||
        !item.sku.trim() ||
        !Number.isSafeInteger(item.cantidad) ||
        item.cantidad < 1 ||
        item.cantidad > 2147483647
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
      Array.isArray(input) ||
      typeof input.nombre !== 'string' ||
      !input.nombre.trim() ||
      (input.descripcion !== undefined &&
        input.descripcion !== null &&
        typeof input.descripcion !== 'string')
    )
      throw new ComboError(400, 'VALIDACION', 'Solicitud inválida');
    this.validateComponents(input.componentes);
    if (typeof input.precioCombo !== 'number')
      throw new ComboError(400, 'VALIDACION', 'precioCombo es requerido');
    decimal(input.precioCombo);
  }

  private async validateReferences(
    items: ComponentInput[],
    comboPrice: bigint,
    correlationId: string = randomUUID(),
  ): Promise<{
    currency: string;
    productIds: Map<string, string>;
    catalogObservedAt: Map<string, string>;
  }> {
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
      const operationSignal = AbortSignal.timeout(20000);
      const pricingInstant = new Date().toISOString();
      const catalog = new CatalogSkuContextClient(
        catalogUrl,
        (signal) => this.serviceBearer('catalogo:leer', signal),
        fetch,
        () => this.identity?.invalidate('catalogo:leer'),
      );
      const productIds = new Map<string, string>();
      const catalogObservedAt = new Map<string, string>();
      const contexts = await mapWithConcurrency(items, 5, async (item) => {
        // Capture before the provider read. This local instant is only a
        // conservative race detector; Catalog has no authoritative revision
        // in its context DTO, so cross-service ordering cannot be proven.
        const requestedAt = new Date().toISOString();
        const context = await catalog.getContext(
          item.sku,
          correlationId,
          operationSignal,
        );
        return { context, requestedAt };
      });
      for (const [index, result] of contexts.entries()) {
        const { context } = result;
        const item = items[index]!;
        productIds.set(item.sku, context.productId);
        catalogObservedAt.set(item.sku, result.requestedAt);
      }
      const pricing = new PricingClient(
        pricingUrl,
        (signal) => this.serviceBearer('precios:leer', signal),
        fetch,
        () => this.identity?.invalidate('precios:leer'),
      );
      const prices = await pricing.getPrices(
        items.map((item) => item.sku),
        pricingInstant,
        undefined,
        correlationId,
        { signal: operationSignal },
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
      return { currency: prices[0]!.currency, productIds, catalogObservedAt };
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
    const references = await this.validateReferences(
      components,
      price,
      correlationId,
    );
    let id: string;
    try {
      id = await this.repository.create({
        name: input.nombre!,
        description: input.descripcion ?? null,
        price: priceString(price),
        currency: references.currency,
        components: components.map((item) => ({
          sku: item.sku,
          quantity: item.cantidad,
          productId: references.productIds.get(item.sku)!,
          catalogObservedAt: references.catalogObservedAt.get(item.sku)!,
        })),
      });
    } catch (error) {
      if (error instanceof CatalogComponentDeactivatedError)
        throw new ComboError(404, 'SKU_NO_ENCONTRADO', 'SKU inactivo');
      throw error;
    }
    return this.get(id);
  }

  async update(id: string, input: ComboInput, correlationId?: string) {
    if (!UUID.test(id))
      throw new ComboError(400, 'VALIDACION', 'Identificador inválido');
    if (!input || typeof input !== 'object')
      throw new ComboError(400, 'VALIDACION', 'Cuerpo inválido');
    if (Array.isArray(input))
      throw new ComboError(400, 'VALIDACION', 'Campo no permitido');
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
    if (input.precioCombo !== undefined) {
      if (typeof input.precioCombo !== 'number')
        throw new ComboError(400, 'VALIDACION', 'precioCombo inválido');
      decimal(input.precioCombo);
    }
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
    const references =
      input.componentes === undefined && input.precioCombo === undefined
        ? undefined
        : await this.validateReferences(components, cents, correlationId);
    const currency = references?.currency ?? current.combo.currency.trim();
    let changed: boolean;
    try {
      changed = await this.repository.update(id, {
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
                productId: references!.productIds.get(item.sku)!,
                catalogObservedAt: references!.catalogObservedAt.get(item.sku)!,
              })),
            }),
      });
    } catch (error) {
      if (error instanceof CatalogComponentDeactivatedError)
        throw new ComboError(404, 'SKU_NO_ENCONTRADO', 'SKU inactivo');
      throw error;
    }
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
    if (!UUID.test(id))
      throw new ComboError(400, 'VALIDACION', 'Identificador inválido');
    if (!(await this.repository.deactivate(id)))
      throw new ComboError(404, 'COMBO_NO_ENCONTRADO', 'Combo no encontrado');
    return this.get(id);
  }
  async availability(id: string) {
    if (!UUID.test(id))
      throw new ComboError(400, 'VALIDACION', 'Identificador inválido');
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

  async evaluateEligibility(id: string) {
    if (!UUID.test(id))
      throw new ComboError(400, 'VALIDACION', 'Identificador inválido');
    const aggregate = await this.repository.get(id);
    if (!aggregate)
      throw new ComboError(404, 'COMBO_NO_ENCONTRADO', 'Combo no encontrado');
    const projections = await this.repository.projections(id);
    const byItemId = new Map(projections.map((item) => [item.id, item]));
    const components = aggregate.components.map((item) => {
      const projection = byItemId.get(item.id);
      const status =
        projection?.catalogDeactivated === true
          ? 'INACTIVO'
          : projection?.catalogDeactivated === false &&
              projection.catalogObservedAt !== null
            ? 'ACTIVO'
            : 'INDETERMINADO';
      return { sku: item.sku, status } as const;
    });
    const commercialEligibility =
      aggregate.combo.status === 'INACTIVO' ||
      components.some((item) => item.status === 'INACTIVO')
        ? 'INELEGIBLE'
        : components.some((item) => item.status === 'INDETERMINADO')
          ? 'NO_VERIFICABLE'
          : 'ELEGIBLE';
    return {
      administrativeStatus: aggregate.combo.status,
      components,
      commercialEligibility,
    } as const;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}
