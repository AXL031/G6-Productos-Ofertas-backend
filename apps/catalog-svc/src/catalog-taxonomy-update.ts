import { sql, type SQLWrapper } from 'drizzle-orm';

export const taxonomyUpdates = [
  'taxonomy.category.updated',
  'taxonomy.product-type-schema.changed',
  'taxonomy.characteristic-value.updated',
] as const;
export const taxonomyUpdateHandler = 'catalog.taxonomy-updates.v1';

export interface TaxonomyUpdate {
  key: string;
  revision: bigint;
}

/** SPEC-008/009/010: producer fields, not the envelope schema_version. */
export function taxonomyUpdate(
  name: string,
  data: Record<string, unknown>,
): TaxonomyUpdate | undefined {
  const id = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;
  const version = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0;
  const timestamp = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value));
  if (
    name === taxonomyUpdates[0] &&
    id(data.categoria_id) &&
    version(data.version)
  )
    return {
      key: 'category:' + data.categoria_id,
      revision: BigInt(data.version),
    };
  if (
    name === taxonomyUpdates[1] &&
    id(data.tipo_producto_id) &&
    version(data.schema_version) &&
    [
      'CHARACTERISTIC_ASSOCIATED',
      'REQUIRED_CHANGED',
      'CHARACTERISTIC_DISASSOCIATED',
    ].includes(String(data.change_type)) &&
    id(data.caracteristica_id) &&
    timestamp(data.updated_at)
  )
    return {
      key: 'type:' + data.tipo_producto_id,
      revision: BigInt(data.schema_version),
    };
  if (
    name === taxonomyUpdates[2] &&
    id(data.caracteristica_id) &&
    id(data.valor_id) &&
    id(data.nombre) &&
    data.change_type === 'RENAMED' &&
    timestamp(data.updated_at)
  )
    return {
      key: 'value:' + JSON.stringify([data.caracteristica_id, data.valor_id]),
      revision:
        BigInt(Date.parse(data.updated_at)) * 1000n +
        BigInt(
          (data.updated_at.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3),
        ),
    };
  return undefined;
}

/** Read-time projection: current LISTA label without rewriting historical values or SKU keys.
 * Inbox is the durable projection source; no in-memory state is required after a restart.
 */
export function currentTaxonomyValue(attributes: {
  caracteristica_id: SQLWrapper;
  valor_id: SQLWrapper;
  valor: SQLWrapper;
}) {
  return sql<unknown>`COALESCE((SELECT to_jsonb(u.payload #>> '{data,nombre}')
    FROM catalog.inbox u
    WHERE u.handler = 'catalog.taxonomy-updates.v1' AND u.result = 'APPLIED'
      AND u.event_name = 'taxonomy.characteristic-value.updated'
      AND u.payload #>> '{data,caracteristica_id}' = ${attributes.caracteristica_id}
      AND u.payload #>> '{data,valor_id}' = ${attributes.valor_id}
    ORDER BY (u.payload #>> '{data,updated_at}')::timestamptz DESC LIMIT 1), ${attributes.valor})`;
}
