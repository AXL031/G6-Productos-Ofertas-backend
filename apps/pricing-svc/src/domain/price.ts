// Tipos internos; los adaptadores traducen los contratos HTTP/AsyncAPI.
export type PriceErrorCode =
  | 'PRECIO_INVALIDO'
  | 'OFERTA_INVALIDA'
  | 'ACCION_OFERTA_INVALIDA'
  | 'MOTIVO_CAMBIO_REQUERIDO'
  | 'SCOPE_PRECIO_INVALIDO'
  | 'VALIDACION'
  | 'VERSION_CONFLICT'
  | 'VIGENCIA_SUPERPUESTA'
  | 'PRECIO_NO_ENCONTRADO'
  | 'IDEMPOTENCY_CONFLICT';

export class PriceRuleError extends Error {
  constructor(readonly code: PriceErrorCode) {
    super(code);
  }
}

export function requireRule(
  condition: boolean,
  code: PriceErrorCode,
): asserts condition {
  if (!condition) throw new PriceRuleError(code);
}

export type PriceTarget =
  { productId: string; sku: null } | { productId: null; sku: string };

export interface PriceTerms {
  precioRegular: string;
  precioOferta: string | null;
  currency: string;
  motivoCambio: string;
  usuarioId: string | null;
}

export interface PriceValidity extends PriceTerms {
  validFrom: Date;
  validUntil: Date | null;
  priceVersion: bigint;
  isCancelled: boolean;
}

export interface PriceDefinition {
  target: PriceTarget;
  channelId: string | null;
  priceVersion: bigint;
  validities: readonly PriceValidity[];
}

export function validateTarget(target: PriceTarget): void {
  requireRule(
    (target.productId === null &&
      typeof target.sku === 'string' &&
      target.sku.length > 0) ||
      (target.sku === null &&
        typeof target.productId === 'string' &&
        target.productId.length > 0),
    'SCOPE_PRECIO_INVALIDO',
  );
}

// Centavos exactos: nunca parseFloat ni redondeo de entradas monetarias.
export function cents(
  value: string,
  code: PriceErrorCode = 'PRECIO_INVALIDO',
): bigint {
  requireRule(
    typeof value === 'string' && /^\d{1,10}(\.\d{1,2})?$/.test(value),
    code,
  );
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  requireRule(amount > 0n, code);
  return amount;
}

export function validateTerms(terms: PriceTerms): void {
  const regular = cents(terms.precioRegular);
  if (terms.precioOferta !== null) {
    requireRule(
      cents(terms.precioOferta, 'OFERTA_INVALIDA') < regular,
      'OFERTA_INVALIDA',
    );
  }
  requireRule(
    typeof terms.currency === 'string' &&
      terms.currency.length === 3 &&
      terms.currency.trim().length === 3,
    'VALIDACION',
  );
  requireRule(
    typeof terms.motivoCambio === 'string' &&
      terms.motivoCambio.trim().length > 0,
    'MOTIVO_CAMBIO_REQUERIDO',
  );
}

export function validateInterval(from: Date, until: Date | null): void {
  requireRule(
    Number.isFinite(from.getTime()) &&
      (until === null || (Number.isFinite(until.getTime()) && until > from)),
    'VALIDACION',
  );
}

export function contains(validity: PriceValidity, at: Date): boolean {
  return (
    !validity.isCancelled &&
    validity.validFrom <= at &&
    (validity.validUntil === null || at < validity.validUntil)
  );
}

export function nextVersion(current: bigint, expected?: bigint): bigint {
  requireRule(
    current >= 1n && current < 9223372036854775807n,
    'VERSION_CONFLICT',
  );
  requireRule(
    expected === undefined || current === expected,
    'VERSION_CONFLICT',
  );
  return current + 1n;
}

export interface Initialization {
  productId: string;
  skuBase: string;
  precioRegular: string;
  currency: string;
  channelId: null;
  motivoCambio: 'ALTA_PRODUCTO';
}

export function initializeProduct(input: Initialization, at: Date) {
  validateTarget({ productId: input.productId, sku: null });
  requireRule(
    typeof input.skuBase === 'string' &&
      input.skuBase.length > 0 &&
      input.channelId === null,
    'SCOPE_PRECIO_INVALIDO',
  );
  requireRule(
    input.motivoCambio === 'ALTA_PRODUCTO',
    'MOTIVO_CAMBIO_REQUERIDO',
  );
  const validity: PriceValidity = {
    precioRegular: input.precioRegular,
    precioOferta: null,
    currency: input.currency,
    motivoCambio: input.motivoCambio,
    usuarioId: null,
    validFrom: at,
    validUntil: null,
    priceVersion: 1n,
    isCancelled: false,
  };
  validateTerms(validity);
  validateInterval(at, null);
  return {
    definition: {
      target: { productId: input.productId, sku: null },
      channelId: null,
      priceVersion: 1n,
      validities: [validity],
    } satisfies PriceDefinition,
    tipoOperacion: 'CREACION' as const,
    precioAnterior: null,
    variacionPorcentual: null,
  };
}

// El caller carga la aceptación durable por operation_id; no es un ledger en memoria.
export function replayInitialization<T>(
  input: Initialization,
  accepted: { input: Initialization; result: T },
): T {
  initializeProduct(input, new Date(0));
  const before = accepted.input;
  requireRule(
    input.productId === before.productId &&
      input.skuBase === before.skuBase &&
      cents(input.precioRegular) === cents(before.precioRegular) &&
      input.currency === before.currency &&
      input.channelId === before.channelId &&
      input.motivoCambio === before.motivoCambio,
    'IDEMPOTENCY_CONFLICT',
  );
  return accepted.result;
}

export interface PriceUpdate {
  precioRegular?: string | null;
  precioOferta?: string | null;
  accionPrecioOferta: 'CONSERVAR' | 'ESTABLECER' | 'ELIMINAR';
  currency: string;
  motivoCambio: string;
  usuarioId: string | null;
}

export function updateTerms(current: PriceTerms, input: PriceUpdate) {
  requireRule(
    ['CONSERVAR', 'ESTABLECER', 'ELIMINAR'].includes(input.accionPrecioOferta),
    'ACCION_OFERTA_INVALIDA',
  );
  requireRule(
    input.accionPrecioOferta !== 'ESTABLECER' || input.precioOferta != null,
    'ACCION_OFERTA_INVALIDA',
  );
  const terms: PriceTerms = {
    precioRegular: input.precioRegular ?? current.precioRegular,
    precioOferta:
      input.accionPrecioOferta === 'CONSERVAR'
        ? current.precioOferta
        : input.accionPrecioOferta === 'ELIMINAR'
          ? null
          : input.precioOferta!,
    currency: input.currency,
    motivoCambio: input.motivoCambio,
    usuarioId: input.usuarioId,
  };
  validateTerms(terms);
  return {
    terms,
    tipoOperacion:
      input.accionPrecioOferta === 'ELIMINAR' && current.precioOferta !== null
        ? ('RETIRO_OFERTA' as const)
        : ('MODIFICACION' as const),
  };
}

// Plan puro: cerrar solo la vigencia abierta anterior; nunca borrar historia/futuros.
export function insertValidity(
  existing: readonly PriceValidity[],
  incoming: PriceValidity,
): PriceValidity[] {
  validateTerms(incoming);
  validateInterval(incoming.validFrom, incoming.validUntil);
  requireRule(incoming.priceVersion >= 1n, 'VERSION_CONFLICT');
  const adjusted = existing.map((validity) => {
    if (
      !incoming.isCancelled &&
      !validity.isCancelled &&
      validity.validUntil === null &&
      validity.validFrom < incoming.validFrom
    ) {
      return { ...validity, validUntil: incoming.validFrom };
    }
    return validity;
  });
  for (const validity of adjusted) {
    if (validity.isCancelled || incoming.isCancelled) continue;
    requireRule(
      (incoming.validUntil !== null &&
        incoming.validUntil <= validity.validFrom) ||
        (validity.validUntil !== null &&
          validity.validUntil <= incoming.validFrom),
      'VIGENCIA_SUPERPUESTA',
    );
  }
  return [...adjusted, incoming];
}

export function scheduleValidity(
  existing: readonly PriceValidity[],
  incoming: PriceValidity,
  now: Date,
): PriceValidity[] {
  requireRule(
    Number.isFinite(now.getTime()) && incoming.validFrom > now,
    'VALIDACION',
  );
  return insertValidity(existing, incoming);
}

export function changePrice(
  definition: PriceDefinition,
  input: PriceUpdate,
  expectedVersion: bigint,
  now: Date,
) {
  validateTarget(definition.target);
  requireRule(Number.isFinite(now.getTime()), 'VALIDACION');
  const priceVersion = nextVersion(definition.priceVersion, expectedVersion);
  const current = definition.validities.find((validity) =>
    contains(validity, now),
  );
  requireRule(current !== undefined, 'PRECIO_NO_ENCONTRADO');
  const change = updateTerms(current, input);
  const validity: PriceValidity = {
    ...current,
    ...change.terms,
    validFrom: now,
    priceVersion,
  };
  const previous = definition.validities.map((candidate) =>
    candidate === current && candidate.validFrom < now
      ? { ...candidate, validUntil: now }
      : candidate,
  );
  return {
    definition: {
      ...definition,
      priceVersion,
      validities: insertValidity(previous, validity),
    },
    tipoOperacion: change.tipoOperacion,
  };
}

export function schedulePrice(
  definition: PriceDefinition,
  input: {
    tipoPrecio: 'REGULAR' | 'OFERTA';
    importe: string;
    currency: string;
    motivoCambio: string;
    usuarioId: string | null;
    validFrom: Date;
    validUntil: Date | null;
  },
  now: Date,
): PriceDefinition {
  validateTarget(definition.target);
  validateInterval(input.validFrom, input.validUntil);
  requireRule(
    Number.isFinite(now.getTime()) && input.validFrom > now,
    'VALIDACION',
  );
  requireRule(
    input.tipoPrecio === 'REGULAR' || input.tipoPrecio === 'OFERTA',
    'VALIDACION',
  );
  const current = definition.validities.find((validity) =>
    contains(validity, input.validFrom),
  );
  requireRule(current !== undefined, 'PRECIO_NO_ENCONTRADO');
  const priceVersion = nextVersion(definition.priceVersion);
  const validity: PriceValidity = {
    precioRegular:
      input.tipoPrecio === 'REGULAR' ? input.importe : current.precioRegular,
    precioOferta:
      input.tipoPrecio === 'OFERTA' ? input.importe : current.precioOferta,
    currency: input.currency,
    motivoCambio: input.motivoCambio,
    usuarioId: input.usuarioId,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    priceVersion,
    isCancelled: false,
  };
  return {
    ...definition,
    priceVersion,
    validities: scheduleValidity(definition.validities, validity, now),
  };
}

export type ScheduledStatus =
  'SCHEDULED' | 'ACTIVE' | 'HISTORICAL' | 'CANCELLED';

export function scheduledStatus(
  current: ScheduledStatus,
  validity: PriceValidity,
  now: Date,
): ScheduledStatus {
  validateInterval(validity.validFrom, validity.validUntil);
  requireRule(Number.isFinite(now.getTime()), 'VALIDACION');
  if (current === 'CANCELLED' || validity.isCancelled) return 'CANCELLED';
  if (current === 'HISTORICAL') return current;
  if (validity.validUntil !== null && now >= validity.validUntil)
    return 'HISTORICAL';
  return now >= validity.validFrom ? 'ACTIVE' : 'SCHEDULED';
}
