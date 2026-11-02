import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';
import { leerTimeoutBaja } from './deactivation-timeout.js';
import { evaluarCheckBaja, type IdentidadBaja } from './deactivation-check.js';

export type ResultadoRegistro =
  'REGISTRADA' | 'REINTENTO' | 'CONFLICTO' | 'NO_DISPONIBLE';
const UUID_NULO = '00000000-0000-0000-0000-000000000000';

/** Admisión durable; registra en outbox sin publicar al broker. */
@Injectable()
export class DeactivationIntentService {
  constructor(private readonly database: Database) {}

  async registrar(intencion: IdentidadBaja): Promise<ResultadoRegistro> {
    if (
      ![
        intencion.operationId,
        intencion.correlationId,
        intencion.entityId,
      ].every((valor) => esUuid(valor) && valor !== UUID_NULO) ||
      !Number.isSafeInteger(intencion.version) ||
      intencion.version < 0
    )
      return 'NO_DISPONIBLE';
    // El runtime actual solo mapea estas fuentes de versión autoritativa.
    if (intencion.entityType !== 'CATEGORY' && intencion.entityType !== 'BRAND')
      return 'NO_DISPONIBLE';
    const entidad =
      intencion.entityType === 'CATEGORY'
        ? sql`taxonomy.categories`
        : sql`taxonomy.brands`;
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const existente =
          await tx.execute(sql`SELECT entity_type, entity_id, correlation_id, source_version
        FROM taxonomy.master_deactivation_operations WHERE operation_id = ${intencion.operationId}::uuid`);
        const comprobar = (fila: Record<string, unknown>): ResultadoRegistro =>
          fila.entity_type === intencion.entityType &&
          typeof fila.entity_id === 'string' &&
          fila.entity_id.toLowerCase() === intencion.entityId.toLowerCase() &&
          typeof fila.correlation_id === 'string' &&
          fila.correlation_id.toLowerCase() ===
            intencion.correlationId.toLowerCase() &&
          fila.source_version !== null &&
          String(fila.source_version) === String(intencion.version)
            ? 'REINTENTO'
            : 'CONFLICTO';
        if (existente.rows[0]) return comprobar(existente.rows[0]);
        const fuente =
          await tx.execute(sql`SELECT taxonomy_version, estado FROM ${entidad}
        WHERE id = ${intencion.entityId}::uuid FOR UPDATE`);
        // Otra transacción pudo completar la admisión mientras se esperaba el lock.
        const trasBloqueo =
          await tx.execute(sql`SELECT entity_type, entity_id, correlation_id, source_version
          FROM taxonomy.master_deactivation_operations WHERE operation_id = ${intencion.operationId}::uuid`);
        if (trasBloqueo.rows[0]) return comprobar(trasBloqueo.rows[0]);
        const activa =
          await tx.execute(sql`SELECT operation_id FROM taxonomy.master_deactivation_operations
          WHERE entity_type = ${intencion.entityType}::taxonomy.tipo_entidad_maestra
            AND entity_id = ${intencion.entityId}::uuid AND status IN ('REQUESTED', 'IN_PROGRESS') LIMIT 1`);
        if (activa.rows.length) return 'CONFLICTO';
        const fila = fuente.rows[0];
        if (
          !fila ||
          fila.estado !== 'ACTIVO' ||
          String(fila.taxonomy_version) !== String(intencion.version)
        )
          return 'NO_DISPONIBLE';
        await leerTimeoutBaja(tx);
        if (intencion.entityType === 'CATEGORY') {
          const hijos = await tx.execute(sql`SELECT id FROM taxonomy.categories
            WHERE categoria_padre_id = ${intencion.entityId}::uuid AND estado = 'ACTIVO' LIMIT 1`);
          if (hijos.rows.length) return 'NO_DISPONIBLE';
        }
        const insertado =
          await tx.execute(sql`INSERT INTO taxonomy.master_deactivation_operations
        (operation_id, correlation_id, entity_type, entity_id, source_version)
        VALUES (${intencion.operationId}::uuid, ${intencion.correlationId}::uuid,
                ${intencion.entityType}::taxonomy.tipo_entidad_maestra, ${intencion.entityId}::uuid, ${intencion.version})
        ON CONFLICT DO NOTHING RETURNING operation_id`);
        if (insertado.rows.length) {
          await tx.execute(sql`UPDATE ${entidad} SET estado = 'PENDING_DEACTIVATION'
            WHERE id = ${intencion.entityId}::uuid AND estado = 'ACTIVO' AND taxonomy_version = ${intencion.version}`);
          await tx.execute(sql`WITH evento AS (SELECT gen_random_uuid() AS message_id, statement_timestamp() AS fecha)
            INSERT INTO taxonomy.outbox (message_id, event_name, kind, schema_version, correlation_id, operation_id, occurred_at, payload)
            SELECT evento.message_id, 'taxonomy.master.deactivation.check.requested', 'command', 1,
              ${intencion.correlationId}::uuid, ${intencion.operationId}::uuid, evento.fecha,
              jsonb_build_object('message_id', evento.message_id, 'schema_version', 1, 'occurred_at', evento.fecha,
                'correlation_id', ${intencion.correlationId}::uuid, 'operation_id', ${intencion.operationId}::uuid,
                'producer', 'taxonomy-svc', 'kind', 'command', 'name', 'taxonomy.master.deactivation.check.requested',
                'data', jsonb_build_object('entity_type', ${intencion.entityType}::text, 'entity_id', ${intencion.entityId}::text,
                  'version', ${intencion.version}::bigint)) FROM evento`);
          await tx.execute(sql`UPDATE taxonomy.master_deactivation_operations SET status = 'IN_PROGRESS'
            WHERE operation_id = ${intencion.operationId}::uuid AND status = 'REQUESTED'`);
          return 'REGISTRADA';
        }
        const reintento =
          await tx.execute(sql`SELECT entity_type, entity_id, correlation_id, source_version
        FROM taxonomy.master_deactivation_operations WHERE operation_id = ${intencion.operationId}::uuid`);
        return reintento.rows[0] ? comprobar(reintento.rows[0]) : 'CONFLICTO';
      }),
    );
  }

  /** Recupera bajas vencidas soportadas y deja el rechazo en outbox, sin emitirlo. */
  async recuperarVencidas(): Promise<number> {
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const timeout = await leerTimeoutBaja(tx);
        const pendientes = await tx.execute(sql`
          SELECT operation_id, correlation_id, entity_type, entity_id, source_version
          FROM taxonomy.master_deactivation_operations
          WHERE status = 'IN_PROGRESS'
            AND created_at <= statement_timestamp() - (${timeout} * interval '1 second')
            AND entity_type IN ('CATEGORY', 'BRAND')
          ORDER BY created_at, operation_id
          LIMIT 50 FOR UPDATE SKIP LOCKED
        `);
        let recuperadas = 0;
        for (const operacion of pendientes.rows) {
          if (
            typeof operacion.operation_id !== 'string' ||
            typeof operacion.correlation_id !== 'string' ||
            typeof operacion.entity_id !== 'string' ||
            (operacion.entity_type !== 'CATEGORY' &&
              operacion.entity_type !== 'BRAND') ||
            (typeof operacion.source_version !== 'string' &&
              typeof operacion.source_version !== 'number')
          )
            continue;
          const version = Number(operacion.source_version);
          if (!Number.isSafeInteger(version) || version < 0) continue;
          const entidad =
            operacion.entity_type === 'CATEGORY'
              ? sql`taxonomy.categories`
              : sql`taxonomy.brands`;
          const restaurada = await tx.execute(sql`
            UPDATE ${entidad} SET estado = 'ACTIVO'
            WHERE id = ${operacion.entity_id}::uuid AND estado = 'PENDING_DEACTIVATION'
              AND taxonomy_version = ${version}
            RETURNING id
          `);
          if (!restaurada.rows.length) continue;
          await tx.execute(sql`
            UPDATE taxonomy.master_deactivation_operations
            SET status = 'FAILED', reason = 'TECHNICAL_FAILURE', updated_at = statement_timestamp()
            WHERE operation_id = ${operacion.operation_id}::uuid AND status = 'IN_PROGRESS'
          `);
          await tx.execute(sql`
            WITH evento AS (SELECT gen_random_uuid() AS message_id, statement_timestamp() AS fecha)
            INSERT INTO taxonomy.outbox
              (message_id, event_name, kind, schema_version, correlation_id, operation_id, occurred_at, payload)
            SELECT evento.message_id, 'taxonomy.master.deactivation.rejected', 'result', 1,
              ${operacion.correlation_id}::uuid, ${operacion.operation_id}::uuid, evento.fecha,
              jsonb_build_object('message_id', evento.message_id, 'schema_version', 1,
                'occurred_at', evento.fecha, 'correlation_id', ${operacion.correlation_id}::uuid,
                'operation_id', ${operacion.operation_id}::uuid, 'producer', 'taxonomy-svc',
                'kind', 'result', 'name', 'taxonomy.master.deactivation.rejected',
                'data', jsonb_build_object('entity_type', ${operacion.entity_type}::text,
                  'entity_id', ${operacion.entity_id}::text, 'version', ${version}::bigint,
                  'reason', 'TECHNICAL_FAILURE'))
            FROM evento
          `);
          recuperadas += 1;
        }
        return recuperadas;
      }),
    );
  }

  /** Persiste la decisión y su evento en outbox; no publica al broker. */
  async finalizar(
    respuesta: IdentidadBaja & { result: unknown },
  ): Promise<'COMPLETADA' | 'RECHAZADA' | 'IGNORADA'> {
    if (!esUuid(respuesta.operationId)) return 'IGNORADA';
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const timeout = await leerTimeoutBaja(tx);
        const consulta = await tx.execute(sql`
        SELECT operation_id, correlation_id, entity_type, entity_id, source_version
        FROM taxonomy.master_deactivation_operations
        WHERE operation_id = ${respuesta.operationId}::uuid AND status = 'IN_PROGRESS'
          AND created_at > statement_timestamp() - (${timeout} * interval '1 second')
        FOR UPDATE
      `);
        const fila = consulta.rows[0];
        if (
          !fila ||
          typeof fila.operation_id !== 'string' ||
          typeof fila.correlation_id !== 'string' ||
          typeof fila.entity_id !== 'string' ||
          (fila.entity_type !== 'CATEGORY' && fila.entity_type !== 'BRAND') ||
          (typeof fila.source_version !== 'string' &&
            typeof fila.source_version !== 'number')
        )
          return 'IGNORADA';
        const version = Number(fila.source_version);
        if (!Number.isSafeInteger(version) || version < 0) return 'IGNORADA';
        const esperada: IdentidadBaja = {
          operationId: fila.operation_id,
          correlationId: fila.correlation_id,
          entityType: fila.entity_type,
          entityId: fila.entity_id,
          version,
        };
        const evaluacion = evaluarCheckBaja(esperada, respuesta);
        if (evaluacion === 'IGNORAR') return 'IGNORADA';
        const completa = evaluacion === 'EVALUAR_BAJA';
        const entidad =
          fila.entity_type === 'CATEGORY'
            ? sql`taxonomy.categories`
            : sql`taxonomy.brands`;
        const cambio = completa
          ? sql`estado = 'INACTIVO', taxonomy_version = taxonomy_version + 1`
          : sql`estado = 'ACTIVO'`;
        const actualizada = await tx.execute(sql`
        UPDATE ${entidad} SET ${cambio}
        WHERE id = ${fila.entity_id}::uuid AND estado = 'PENDING_DEACTIVATION' AND taxonomy_version = ${version}
        RETURNING id
      `);
        if (!actualizada.rows.length) return 'IGNORADA';
        const status = completa ? 'COMPLETED' : 'REJECTED';
        const nombre = completa
          ? 'taxonomy.master.deactivated'
          : 'taxonomy.master.deactivation.rejected';
        const kind = completa ? 'event' : 'result';
        const reason = completa ? null : 'IN_USE';
        await tx.execute(sql`UPDATE taxonomy.master_deactivation_operations
        SET status = ${status}::taxonomy.estado_operacion_baja, reason = ${reason}, updated_at = statement_timestamp()
        WHERE operation_id = ${fila.operation_id}::uuid AND status = 'IN_PROGRESS'`);
        await tx.execute(sql`
        WITH evento AS (SELECT gen_random_uuid() AS message_id, statement_timestamp() AS fecha)
        INSERT INTO taxonomy.outbox (message_id, event_name, kind, schema_version, correlation_id, operation_id, occurred_at, payload)
        SELECT evento.message_id, ${nombre}, ${kind}, 1, ${fila.correlation_id}::uuid, ${fila.operation_id}::uuid, evento.fecha,
          jsonb_build_object('message_id', evento.message_id, 'schema_version', 1, 'occurred_at', evento.fecha,
            'correlation_id', ${fila.correlation_id}::uuid, 'operation_id', ${fila.operation_id}::uuid,
            'producer', 'taxonomy-svc', 'kind', ${kind}::text, 'name', ${nombre}::text,
            'data', jsonb_build_object('entity_type', ${fila.entity_type}::text, 'entity_id', ${fila.entity_id}::text,
              'version', ${version}::bigint) || CASE WHEN ${completa}::boolean THEN '{}'::jsonb ELSE jsonb_build_object('reason', 'IN_USE') END)
        FROM evento
      `);
        return completa ? 'COMPLETADA' : 'RECHAZADA';
      }),
    );
  }
}
