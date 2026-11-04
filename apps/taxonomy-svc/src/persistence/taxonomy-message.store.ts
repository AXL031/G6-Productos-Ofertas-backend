import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';
import { DeactivationIntentService } from '../domain/deactivation-intent.service.js';
import type {
  IdentidadBaja,
  TipoMaestro,
} from '../domain/deactivation-check.js';

export interface CheckedEnvelope {
  message_id: string;
  correlation_id: string;
  operation_id: string;
  causation_id?: string | null;
  schema_version: 1;
  occurred_at: string;
  producer: 'catalog-svc';
  kind: 'result';
  name: 'catalog.master.deactivation.checked';
  data: {
    entity_type: TipoMaestro;
    entity_id: string;
    version: number;
    result: 'CLEAR' | 'IN_USE';
    tipo_producto_id?: string;
    caracteristica_id?: string;
  };
}
const tipos = [
  'CATEGORY',
  'BRAND',
  'PRODUCT_TYPE',
  'CHARACTERISTIC_VALUE',
  'PRODUCT_TYPE_CHARACTERISTIC',
];
const objeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export function parseChecked(value: unknown): CheckedEnvelope {
  if (!objeto(value) || !objeto(value.data))
    throw new Error('INVALID_ENVELOPE');
  const d = value.data;
  if (
    typeof value.message_id !== 'string' ||
    !esUuid(value.message_id) ||
    typeof value.operation_id !== 'string' ||
    !esUuid(value.operation_id) ||
    typeof value.correlation_id !== 'string' ||
    !esUuid(value.correlation_id) ||
    (value.causation_id != null && typeof value.causation_id !== 'string') ||
    value.schema_version !== 1 ||
    typeof value.occurred_at !== 'string' ||
    !Number.isFinite(Date.parse(value.occurred_at)) ||
    value.producer !== 'catalog-svc' ||
    value.kind !== 'result' ||
    value.name !== 'catalog.master.deactivation.checked' ||
    typeof d.entity_type !== 'string' ||
    !tipos.includes(d.entity_type) ||
    typeof d.entity_id !== 'string' ||
    !esUuid(d.entity_id) ||
    typeof d.version !== 'number' ||
    !Number.isSafeInteger(d.version) ||
    d.version < 0 ||
    (d.result !== 'CLEAR' && d.result !== 'IN_USE') ||
    (d.entity_type === 'PRODUCT_TYPE_CHARACTERISTIC' &&
      (typeof d.tipo_producto_id !== 'string' ||
        !esUuid(d.tipo_producto_id) ||
        typeof d.caracteristica_id !== 'string' ||
        !esUuid(d.caracteristica_id)))
  )
    throw new Error('INVALID_ENVELOPE');
  return value as unknown as CheckedEnvelope;
}

@Injectable()
export class TaxonomyMessageStore {
  private cursorOutbox: { fecha: string; id: string } | null = null;
  constructor(
    private readonly database: Database,
    private readonly intentos: DeactivationIntentService,
  ) {}
  async consumir(envelope: CheckedEnvelope): Promise<void> {
    const d = envelope.data;
    const identidad: IdentidadBaja & { result: unknown } = {
      operationId: envelope.operation_id,
      correlationId: envelope.correlation_id,
      entityType: d.entity_type,
      entityId: d.entity_id,
      version: d.version,
      result: d.result,
      tipoProductoId: d.tipo_producto_id,
      caracteristicaId: d.caracteristica_id,
    };
    await this.database.read((db) =>
      db.transaction(async (tx) => {
        const inserted =
          await tx.execute(sql`INSERT INTO taxonomy.inbox (message_id, handler, event_name, correlation_id, payload, result)
        VALUES (${envelope.message_id}::uuid, 'catalog.master.deactivation.checked', ${envelope.name}, ${envelope.correlation_id}::uuid, ${JSON.stringify(envelope)}::jsonb, 'IGNORED')
        ON CONFLICT (message_id, handler) DO NOTHING RETURNING message_id`);
        if (!inserted.rows.length) {
          const same = await tx.execute(
            sql`SELECT 1 FROM taxonomy.inbox WHERE message_id = ${envelope.message_id}::uuid AND handler = 'catalog.master.deactivation.checked' AND payload = ${JSON.stringify(envelope)}::jsonb`,
          );
          if (!same.rows.length) throw new Error('MESSAGE_ID_COLLISION');
          return;
        }
        const solicitud = await tx.execute(
          sql`SELECT 1 FROM taxonomy.outbox WHERE operation_id = ${envelope.operation_id}::uuid AND correlation_id = ${envelope.correlation_id}::uuid AND event_name = 'taxonomy.master.deactivation.check.requested' AND (${envelope.causation_id ?? null}::text IS NULL OR message_id::text = ${envelope.causation_id ?? null}::text)`,
        );
        const resultado = solicitud.rows.length
          ? await this.intentos.finalizarEnTransaccion(tx, identidad)
          : 'IGNORADA';
        if (resultado !== 'IGNORADA')
          await tx.execute(
            sql`UPDATE taxonomy.inbox SET result = 'PROCESSED' WHERE message_id = ${envelope.message_id}::uuid AND handler = 'catalog.master.deactivation.checked'`,
          );
      }),
    );
  }
  async guardarInvalido(
    messageId: string,
    payload: string,
    correlationId: string | null,
  ): Promise<void> {
    await this.database.read((db) =>
      db.transaction(async (tx) => {
        const inserted =
          await tx.execute(sql`INSERT INTO taxonomy.inbox (message_id, handler, event_name, correlation_id, payload, result)
        VALUES (${messageId}::uuid, 'catalog.master.deactivation.checked', 'catalog.master.deactivation.checked', ${correlationId}::uuid, ${JSON.stringify({ reason: 'INVALID_ENVELOPE', digest: payload })}::jsonb, 'FAILED')
        ON CONFLICT (message_id, handler) DO NOTHING RETURNING message_id`);
        if (!inserted.rows.length) {
          const same = await tx.execute(
            sql`SELECT 1 FROM taxonomy.inbox WHERE message_id = ${messageId}::uuid AND handler = 'catalog.master.deactivation.checked' AND payload = ${JSON.stringify({ reason: 'INVALID_ENVELOPE', digest: payload })}::jsonb`,
          );
          if (!same.rows.length) throw new Error('MESSAGE_ID_COLLISION');
        }
      }),
    );
  }
  async publicarUno(
    publicar: (row: Record<string, unknown>) => Promise<void>,
  ): Promise<'VACIO' | 'PENDIENTE' | 'PUBLICADO'> {
    const cursor = this.cursorOutbox;
    const resultado = await this.database.read((db) =>
      db.transaction(async (tx) => {
        // Respetar orden causal por operación, sin bloquear las demás operaciones.
        const result = await tx.execute(sql`
          SELECT o.id, o.message_id, o.event_name, o.kind, o.correlation_id, o.payload,
                 o.occurred_at::text AS cursor_fecha
          FROM taxonomy.outbox o
          WHERE o.published_at IS NULL
            AND o.event_name IN ('taxonomy.category.updated', 'taxonomy.product-type-schema.changed', 'taxonomy.characteristic-value.updated', 'taxonomy.master.deactivation.check.requested', 'taxonomy.master.deactivated', 'taxonomy.master.deactivation.rejected')
            AND (${cursor?.fecha ?? null}::timestamptz IS NULL OR
                 (o.occurred_at, o.id) > (${cursor?.fecha ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
            AND NOT EXISTS (
              SELECT 1 FROM taxonomy.outbox anterior
              WHERE anterior.operation_id = o.operation_id AND anterior.published_at IS NULL
                AND (anterior.occurred_at, anterior.id) < (o.occurred_at, o.id)
            )
          ORDER BY o.occurred_at, o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED
        `);
        const row = result.rows[0];
        if (!row) return { estado: 'VACIO' as const, cursor: null };
        if (typeof row.cursor_fecha !== 'string' || typeof row.id !== 'string')
          throw new Error('INVALID_OUTBOX_CURSOR');
        const siguiente = { fecha: row.cursor_fecha, id: row.id };
        try {
          await publicar(row);
        } catch {
          await tx.execute(
            sql`UPDATE taxonomy.outbox SET attempts = attempts + 1, last_error = 'BROKER_PUBLISH_UNCONFIRMED' WHERE id = ${row.id}::uuid`,
          );
          return { estado: 'PENDIENTE' as const, cursor: siguiente };
        }
        await tx.execute(
          sql`UPDATE taxonomy.outbox SET published_at = statement_timestamp(), attempts = attempts + 1, last_error = NULL WHERE id = ${row.id}::uuid`,
        );
        return { estado: 'PUBLICADO' as const, cursor: siguiente };
      }),
    );
    this.cursorOutbox = resultado.cursor;
    return resultado.estado;
  }
}
