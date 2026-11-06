// Date.parse normaliza días inexistentes y 24:00; no deben alterar la trazabilidad.
export function validAuditTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const day = value.slice(0, 10);
  return new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day;
}
