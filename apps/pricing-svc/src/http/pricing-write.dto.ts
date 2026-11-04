import {
  cents,
  requireRule,
  type PriceUpdate,
  type schedulePrice,
} from '../domain/price.js';
import { record } from './pricing-read.guard.js';
import { channels } from './commercial-prices.js';

// DTO contractual; autorizar escrituras y construir PriceFact exige providers aprobados.
function money(value: unknown): string {
  requireRule(
    typeof value === 'number' && Number.isFinite(value),
    'VALIDACION',
  );
  const decimal = String(value);
  cents(decimal);
  return decimal;
}

function text(value: unknown): string {
  requireRule(
    typeof value === 'string' && value.trim().length > 0,
    'VALIDACION',
  );
  return value;
}

function currency(value: unknown): string {
  const result = text(value);
  requireRule(result.length === 3 && result.trim().length === 3, 'VALIDACION');
  return result;
}

function channel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  requireRule(
    channels.some((channel) => channel === value),
    'VALIDACION',
  );
  return text(value);
}

function instant(value: unknown): Date {
  const source = text(value);
  requireRule(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      source,
    ),
    'VALIDACION',
  );
  const result = new Date(source);
  requireRule(Number.isFinite(result.getTime()), 'VALIDACION');
  // Date normaliza fechas como 30 de febrero; no aceptar esa corrección implícita.
  const calendar = new Date(`${source.slice(0, 10)}T00:00:00Z`);
  requireRule(
    calendar.toISOString().slice(0, 10) === source.slice(0, 10),
    'VALIDACION',
  );
  return result;
}

export function parsePriceUpdateRequest(body: unknown): {
  channelId: string | null;
  expectedVersion: bigint;
  input: Omit<PriceUpdate, 'usuarioId'>;
} {
  requireRule(record(body), 'VALIDACION');
  const action = body.accionPrecioOferta;
  requireRule(
    action === 'CONSERVAR' || action === 'ESTABLECER' || action === 'ELIMINAR',
    'ACCION_OFERTA_INVALIDA',
  );
  requireRule(
    typeof body.priceVersion === 'number' &&
      Number.isSafeInteger(body.priceVersion) &&
      body.priceVersion >= 0,
    'VALIDACION',
  );
  const regular =
    body.precioRegular == null ? undefined : money(body.precioRegular);
  const offer = body.precioOferta == null ? null : money(body.precioOferta);
  requireRule(
    action !== 'ESTABLECER' || offer !== null,
    'ACCION_OFERTA_INVALIDA',
  );
  return {
    channelId: channel(body.channelId),
    expectedVersion: BigInt(body.priceVersion),
    input: {
      precioRegular: regular,
      precioOferta: offer,
      accionPrecioOferta: action,
      currency: currency(body.moneda),
      motivoCambio: text(body.motivoCambio),
    },
  };
}

export function parsePriceScheduleRequest(body: unknown): {
  channelId: string | null;
  input: Omit<Parameters<typeof schedulePrice>[1], 'usuarioId'>;
} {
  requireRule(record(body), 'VALIDACION');
  const kind = body.tipoPrecio;
  requireRule(kind === 'REGULAR' || kind === 'OFERTA', 'VALIDACION');
  return {
    channelId: channel(body.channelId),
    input: {
      tipoPrecio: kind,
      importe: money(body.importe),
      currency: currency(body.moneda),
      motivoCambio: text(body.motivoCambio),
      validFrom: instant(body.validFrom),
      validUntil: body.validUntil == null ? null : instant(body.validUntil),
    },
  };
}
