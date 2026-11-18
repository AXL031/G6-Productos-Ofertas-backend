import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';
import { DeactivationIntentService } from '../domain/deactivation-intent.service.js';
import { taxonomyCatalogQueue } from '../config/service-bus.js';
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

export interface TaxonomyDeliveryClaim {
  row: Record<string, unknown>;
  messageId: string;
  token: string;
}
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

  async verifyServiceBusStorage(): Promise<void> {
    const result = await this.database.read((db) =>
      db.execute(sql`
      SELECT to_regclass('taxonomy.outbox_delivery') IS NOT NULL
        AND current_setting('g6.taxonomy_messaging', true) = 'AZURE_SERVICE_BUS'
        AND EXISTS (SELECT FROM pg_trigger WHERE tgname = 'trg_taxonomy_catalog_h5'
          AND tgrelid = 'taxonomy.outbox'::regclass AND tgenabled IN ('O','A')) AS ready
    `),
    );
    if (result.rows[0]?.ready !== true)
      throw new Error('TAXONOMY_H5_STORAGE_NOT_READY');
  }

  async claimServiceBusDelivery(): Promise<TaxonomyDeliveryClaim | undefined> {
    const token = randomUUID();
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const result = await tx.execute(sql`
        WITH candidate AS (
          SELECT d.message_id FROM taxonomy.outbox_delivery d
          JOIN taxonomy.outbox o USING (message_id)
          WHERE d.destination = ${taxonomyCatalogQueue} AND d.sent_at IS NULL
            AND d.next_attempt_at <= clock_timestamp()
            AND (d.lease_until IS NULL OR d.lease_until <= clock_timestamp())
            AND NOT EXISTS (
              SELECT FROM taxonomy.outbox earlier
              JOIN taxonomy.outbox_delivery pending USING (message_id)
              WHERE earlier.operation_id = o.operation_id AND pending.sent_at IS NULL
                AND pending.destination = d.destination
                AND (earlier.occurred_at, earlier.id) < (o.occurred_at, o.id)
            )
          ORDER BY o.occurred_at, o.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED
        )
        UPDATE taxonomy.outbox_delivery d
        SET lease_token = ${token}::uuid, lease_until = clock_timestamp() + interval '30 seconds',
            attempts = d.attempts + 1
        FROM candidate c, taxonomy.outbox o
        WHERE d.message_id = c.message_id AND o.message_id = c.message_id
          AND d.destination = ${taxonomyCatalogQueue}
        RETURNING o.message_id, o.event_name, o.correlation_id, o.payload
      `);
        const row = result.rows[0];
        if (!row) return undefined;
        if (typeof row.message_id !== 'string' || !esUuid(row.message_id))
          throw new Error('INVALID_TAXONOMY_MESSAGE');
        return { row, messageId: row.message_id, token };
      }),
    );
  }

  async finishServiceBusDelivery(
    claim: TaxonomyDeliveryClaim,
    outcome: 'sent' | 'pending' | 'terminal',
  ): Promise<boolean> {
    const result = await this.database.read((db) =>
      db.execute(sql`
      UPDATE taxonomy.outbox_delivery
      SET lease_token=NULL, lease_until=NULL,
          sent_at=CASE WHEN ${outcome}='sent' THEN clock_timestamp() ELSE NULL END,
          last_error=CASE WHEN ${outcome}='sent' THEN NULL
                          WHEN ${outcome}='terminal' THEN 'INVALID_OR_OVERSIZE_MESSAGE'
                          ELSE 'SEND_NOT_CONFIRMED' END,
          next_attempt_at=CASE WHEN ${outcome}='terminal' THEN 'infinity'::timestamptz
            ELSE clock_timestamp()+make_interval(secs=>LEAST(60,power(2,LEAST(attempts,6))::int)) END
      WHERE message_id=${claim.messageId}::uuid AND destination=${taxonomyCatalogQueue}
        AND lease_token=${claim.token}::uuid AND lease_until > clock_timestamp() AND sent_at IS NULL
      RETURNING message_id
    `),
    );
    return result.rows.length === 1;
  }
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
            AND COALESCE(to_jsonb(o)->>'delivery_transport', 'RABBITMQ') = 'RABBITMQ'
            AND o.event_name IN ('taxonomy.category.updated', 'taxonomy.product-type-schema.changed', 'taxonomy.characteristic-value.updated', 'taxonomy.master.deactivation.check.requested', 'taxonomy.master.deactivated', 'taxonomy.master.deactivation.rejected')
            AND (${cursor?.fecha ?? null}::timestamptz IS NULL OR
                 (o.occurred_at, o.id) > (${cursor?.fecha ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
            AND NOT EXISTS (
              SELECT 1 FROM taxonomy.outbox anterior
              WHERE anterior.operation_id = o.operation_id AND anterior.published_at IS NULL
                AND COALESCE(to_jsonb(anterior)->>'delivery_transport', 'RABBITMQ') = 'RABBITMQ'
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
