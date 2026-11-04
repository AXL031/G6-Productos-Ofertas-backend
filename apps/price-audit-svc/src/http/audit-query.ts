import { AuditHttpError } from './audit-http.error.js';
import { uuid } from '../domain/audit.js';

export interface AuditFilters {
  sku?: string;
  desde?: string;
  hasta?: string;
  usuarioId?: string;
  canal?: string;
  batchId?: string;
}
export function parseFilters(
  query: Record<string, unknown>,
  pagination = true,
) {
  const allowed = [
    'sku',
    'desde',
    'hasta',
    'usuarioId',
    'canal',
    'batchId',
    ...(pagination ? ['pagina', 'tamanio'] : []),
  ];
  const invalid = () => {
    throw new AuditHttpError(400, 'VALIDACION');
  };
  if (Object.keys(query).some((k) => !allowed.includes(k))) invalid();
  const filters: AuditFilters = {};
  for (const key of [
    'sku',
    'desde',
    'hasta',
    'usuarioId',
    'canal',
    'batchId',
  ] as const) {
    const value = query[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) return invalid();
    filters[key] = value;
  }
  for (const value of [filters.desde, filters.hasta]) {
    if (
      value !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value.slice(0, 10) + 'T00:00:00Z')
          .toISOString()
          .slice(0, 10) !== value.slice(0, 10))
    )
      invalid();
  }
  if (
    filters.desde &&
    filters.hasta &&
    Date.parse(filters.desde) > Date.parse(filters.hasta)
  )
    invalid();
  if (filters.batchId && !uuid.test(filters.batchId)) invalid();
  function positive(value: unknown, fallback: number, max: number) {
    if (value === undefined) return fallback;
    if (
      typeof value !== 'string' ||
      !/^[1-9]\d*$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) > max
    )
      return invalid();
    return Number(value);
  }
  const size = positive(query.tamanio, 20, 200);
  return {
    filters,
    page: positive(query.pagina, 1, Math.floor(Number.MAX_SAFE_INTEGER / size)),
    size,
  };
}
