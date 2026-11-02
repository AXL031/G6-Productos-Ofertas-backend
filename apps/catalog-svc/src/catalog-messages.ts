import { randomUUID } from 'node:crypto';
import { object } from './catalog-mutation.input.js';
import {
  masterTypes,
  associationCoordinates,
  type MasterType,
} from './catalog-master-barriers.js';
export interface MasterData extends Record<string, unknown> {
  entity_type: MasterType;
  entity_id: string;
  version: number;
}
export function assertMasterData(
  data: Record<string, unknown>,
  operationId: unknown,
): asserts data is MasterData {
  if (
    !UUID.test(String(operationId)) ||
    !masterTypes.includes(data.entity_type as MasterType) ||
    typeof data.entity_id !== 'string' ||
    data.entity_id.length === 0 ||
    !Number.isSafeInteger(data.version) ||
    (data.version as number) < 0
  )
    throw new InvalidCatalogMessage();
}
export const CATALOG_PREPARATION_CONFIG = Symbol('CATALOG_PREPARATION_CONFIG');
export interface CatalogPreparationConfig {
  timeoutMs?: number;
}

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const preparationResults = [
  'pricing.product.initialization.completed',
  'pricing.product.initialization.rejected',
  'inventory.sku.initialization.completed',
  'inventory.sku.initialization.rejected',
] as const;
export const catalogBindings = [
  ...preparationResults,
  'taxonomy.category.updated',
  'taxonomy.product-type-schema.changed',
  'taxonomy.characteristic-value.updated',
  'taxonomy.master.deactivation.check.requested',
  'taxonomy.master.deactivated',
  'taxonomy.master.deactivation.rejected',
  'catalog.bulk.upsert.requested',
] as const;
export const catalogProduced = [
  'pricing.product.initialization.requested',
  'inventory.sku.initialization.requested',
  'catalog.product.deactivated',
  'catalog.sku.deactivated',
  'catalog.master.deactivation.checked',
  'catalog.bulk.upsert.completed',
  'catalog.bulk.upsert.rejected',
] as const;
export interface CatalogEnvelope extends Record<string, unknown> {
  message_id: string;
  schema_version: number;
  occurred_at: string;
  correlation_id: string;
  causation_id: string | null;
  operation_id: string | null;
  producer: string;
  kind: 'command' | 'event' | 'result';
  name: string;
  data: Record<string, unknown>;
}
export class InvalidCatalogMessage extends Error {
  constructor() {
    super('INVALID_CATALOG_MESSAGE');
  }
}
export class BlockedCatalogHandler extends Error {
  constructor() {
    super('BLOCKED_CONTRACT');
  }
}
export function assertCatalogPublication(message: CatalogEnvelope): void {
  if (
    !(catalogProduced as readonly string[]).includes(message.name) ||
    message.producer !== 'catalog-svc' ||
    message.schema_version !== 1 ||
    !UUID.test(message.message_id) ||
    !UUID.test(message.correlation_id) ||
    !object(message.data)
  )
    throw new InvalidCatalogMessage();
  const data = message.data;
  if (message.name === 'catalog.master.deactivation.checked') {
    assertMasterData(data, message.operation_id);
    if (
      message.kind !== 'result' ||
      (data.result !== 'CLEAR' && data.result !== 'IN_USE') ||
      (data.entity_type === 'PRODUCT_TYPE_CHARACTERISTIC' &&
        !associationCoordinates(data))
    )
      throw new InvalidCatalogMessage();
  }
  if (message.name === 'pricing.product.initialization.requested') {
    if (
      !UUID.test(String(message.operation_id)) ||
      typeof data.product_id !== 'string' ||
      !data.product_id ||
      typeof data.sku_base !== 'string' ||
      !data.sku_base ||
      typeof data.precio_regular !== 'number' ||
      !Number.isFinite(data.precio_regular) ||
      data.precio_regular <= 0 ||
      typeof data.moneda !== 'string' ||
      data.moneda.length !== 3 ||
      data.channel_id !== null ||
      data.motivo_cambio !== 'ALTA_PRODUCTO' ||
      message.kind !== 'command'
    )
      throw new InvalidCatalogMessage();
  }
  if (message.name === 'inventory.sku.initialization.requested') {
    if (
      !UUID.test(String(message.operation_id)) ||
      typeof data.product_id !== 'string' ||
      !data.product_id ||
      typeof data.sku !== 'string' ||
      !data.sku ||
      (data.variant_id != null && typeof data.variant_id !== 'string') ||
      (data.default_location_id != null &&
        typeof data.default_location_id !== 'string') ||
      message.kind !== 'command'
    )
      throw new InvalidCatalogMessage();
  }
}
export function envelope(
  name: string,
  data: Record<string, unknown>,
  correlationId: string,
  operationId: string | null = null,
  causationId: string | null = null,
): CatalogEnvelope {
  if (!(catalogProduced as readonly string[]).includes(name))
    throw new InvalidCatalogMessage();
  const message: CatalogEnvelope = {
    message_id: randomUUID(),
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: correlationId,
    operation_id: operationId,
    causation_id: causationId,
    producer: 'catalog-svc',
    kind: name.endsWith('.requested')
      ? 'command'
      : name.endsWith('.deactivated')
        ? 'event'
        : 'result',
    name,
    data,
  };
  assertCatalogPublication(message);
  return message;
}
export function parseCatalogMessage(value: unknown): CatalogEnvelope {
  if (
    !object(value) ||
    !UUID.test(String(value.message_id)) ||
    !UUID.test(String(value.correlation_id)) ||
    value.schema_version !== 1 ||
    typeof value.occurred_at !== 'string' ||
    !Number.isFinite(Date.parse(value.occurred_at)) ||
    typeof value.name !== 'string' ||
    !(catalogBindings as readonly string[]).includes(value.name) ||
    typeof value.producer !== 'string' ||
    !object(value.data) ||
    !['event', 'command', 'result'].includes(String(value.kind))
  )
    throw new InvalidCatalogMessage();
  const result = (preparationResults as readonly string[]).includes(value.name);
  const expectedProducer = value.name.startsWith('pricing.')
    ? 'pricing-svc'
    : value.name.startsWith('inventory.')
      ? 'inventory-svc'
      : value.name.startsWith('taxonomy.')
        ? 'taxonomy-svc'
        : 'bulk-svc';
  if (
    value.producer !== expectedProducer ||
    value.kind !==
      (result
        ? 'result'
        : value.name === 'taxonomy.master.deactivation.rejected'
          ? 'result'
          : value.name.endsWith('.requested')
            ? 'command'
            : 'event')
  )
    throw new InvalidCatalogMessage();
  if (value.name.startsWith('taxonomy.master.')) {
    assertMasterData(value.data, value.operation_id);
    if (value.data.entity_type === 'PRODUCT_TYPE_CHARACTERISTIC') {
      if (
        (value.name.endsWith('.check.requested') ||
          Object.hasOwn(value.data, 'tipo_producto_id') ||
          Object.hasOwn(value.data, 'caracteristica_id')) &&
        !associationCoordinates(value.data)
      )
        throw new InvalidCatalogMessage();
      if (
        value.name === 'taxonomy.master.deactivated' &&
        (!Number.isSafeInteger(value.data.schema_version_resultante) ||
          (value.data.schema_version_resultante as number) <=
            value.data.version)
      )
        throw new InvalidCatalogMessage();
    }
    if (
      value.name.endsWith('.rejected') &&
      (typeof value.data.reason !== 'string' || value.data.reason.length === 0)
    )
      throw new InvalidCatalogMessage();
  }
  if (result) {
    const d = value.data;
    const completed = value.name.endsWith('.completed');
    const status = completed
      ? value.name.startsWith('pricing.')
        ? 'READY'
        : 'INITIALIZED'
      : 'REJECTED';
    if (
      !UUID.test(String(value.operation_id)) ||
      !UUID.test(String(value.causation_id)) ||
      typeof d.product_id !== 'string' ||
      !d.product_id ||
      d.status !== status ||
      typeof d.completed_at !== 'string' ||
      !Number.isFinite(Date.parse(d.completed_at)) ||
      (d.code != null && typeof d.code !== 'string') ||
      (value.name.startsWith('pricing.')
        ? typeof d.sku_base !== 'string' ||
          !d.sku_base ||
          (d.price_version != null &&
            (!Number.isSafeInteger(d.price_version) ||
              (d.price_version as number) < 1)) ||
          (d.vigencia_id != null && typeof d.vigencia_id !== 'string')
        : typeof d.sku !== 'string' ||
          !d.sku ||
          (d.variant_id != null && typeof d.variant_id !== 'string'))
    )
      throw new InvalidCatalogMessage();
  }
  return value as CatalogEnvelope;
}
export interface RequestedAttempt {
  message_id: string;
  causation_id: string | null;
  published_at: Date | null;
  occurred_at: Date;
}
export class UnresolvedCatalogAttempt extends Error {
  constructor() {
    super('UNRESOLVED_CATALOG_ATTEMPT');
  }
}
/** Each manual retry causally references the previous requested message. No mutable pointer is needed. */
export function activeAttempt<T extends RequestedAttempt>(
  attempts: readonly T[],
): T | undefined {
  if (!attempts.length) return undefined;
  const ids = new Set(attempts.map((a) => a.message_id));
  if (
    ids.size !== attempts.length ||
    attempts.filter((a) => !a.causation_id || !ids.has(a.causation_id))
      .length !== 1
  )
    throw new UnresolvedCatalogAttempt();
  const parents = new Set(
    attempts
      .map((a) => a.causation_id)
      .filter((id): id is string => id !== null),
  );
  const leaves = attempts.filter((a) => !parents.has(a.message_id));
  if (leaves.length !== 1) throw new UnresolvedCatalogAttempt();
  let current: RequestedAttempt | undefined = leaves[0];
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.message_id)) throw new UnresolvedCatalogAttempt();
    visited.add(current.message_id);
    current = attempts.find((a) => a.message_id === current?.causation_id);
  }
  if (visited.size !== attempts.length) throw new UnresolvedCatalogAttempt();
  return leaves[0];
}
export function preparationTimeout(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.CATALOG_PREPARATION_TIMEOUT_MS;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1)
    throw new Error('CATALOG_PREPARATION_TIMEOUT_MS inválido');
  return n;
}
export function manualRetryAllowed(
  state: string,
  attempt: RequestedAttempt | undefined,
  timeout: number | undefined,
  now = Date.now(),
): boolean {
  return (
    state === 'PENDING' &&
    timeout !== undefined &&
    attempt?.published_at != null &&
    now - attempt.published_at.getTime() >= timeout
  );
}
