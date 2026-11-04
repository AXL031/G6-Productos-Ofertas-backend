import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';
import { leerTimeoutBaja } from './deactivation-timeout.js';
import {
  evaluarCheckBaja,
  type IdentidadBaja,
  type TipoMaestro,
} from './deactivation-check.js';
import {
  bloquearFuenteBaja,
  transicionarFuenteBaja,
} from '../persistence/deactivation-source.js';

export type ResultadoRegistro =
  'REGISTRADA' | 'REINTENTO' | 'CONFLICTO' | 'NO_DISPONIBLE';
const INTERVALO_AVISOS_MS = 5 * 60 * 1000;
const UUID_NULO = '00000000-0000-0000-0000-000000000000';

/** Admisión durable; registra en outbox sin publicar al broker. */
@Injectable()
export class DeactivationIntentService {
  private readonly logger = new Logger(DeactivationIntentService.name);
  private proximaInspeccion = 0;
  private cursorInspeccion: string | null = null;
  private proximoAvisoConcurrente = 0;
  constructor(private readonly database: Database) {}

  async obtenerOperacion(operationId: string) {
    if (!esUuid(operationId)) return undefined;
    return this.database.read(async (db) => {
      const r =
        await db.execute(sql`SELECT operation_id,entity_type,entity_id,source_version,status,reason,updated_at
        FROM taxonomy.master_deactivation_operations WHERE operation_id=${operationId}::uuid`);
      const row = r.rows[0];
      if (!row) return undefined;
      const status =
        row.status === 'COMPLETED'
          ? 'COMPLETED'
          : row.status === 'REJECTED' || row.status === 'FAILED'
            ? 'REJECTED'
            : 'PENDING_DEACTIVATION';
      const reason = typeof row.reason === 'string' ? row.reason : null;
      return {
        operation_id: row.operation_id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        version: Number(row.source_version),
        status,
        result:
          status === 'COMPLETED'
            ? 'CLEAR'
            : reason === 'IN_USE'
              ? 'IN_USE'
              : null,
        code: null,
        updated_at: new Date(String(row.updated_at)).toISOString(),
      };
    });
  }

  async registrar(intencion: IdentidadBaja): Promise<ResultadoRegistro> {
    if (
      ![
        intencion.operationId,
        intencion.correlationId,
        intencion.entityId,
      ].every((valor) => esUuid(valor) && valor !== UUID_NULO) ||
      !Number.isSafeInteger(intencion.version) ||
      intencion.version < 0 ||
      ![
        'CATEGORY',
        'BRAND',
        'PRODUCT_TYPE',
        'CHARACTERISTIC_VALUE',
        'PRODUCT_TYPE_CHARACTERISTIC',
      ].includes(intencion.entityType)
    )
      return 'NO_DISPONIBLE';
    if (
      intencion.entityType === 'PRODUCT_TYPE_CHARACTERISTIC' &&
      (!esUuid(intencion.tipoProductoId) || !esUuid(intencion.caracteristicaId))
    )
      return 'NO_DISPONIBLE';
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const existente =
          await tx.execute(sql`SELECT entity_type, entity_id, correlation_id, source_version
        FROM taxonomy.master_deactivation_operations WHERE operation_id = ${intencion.operationId}::uuid`);
        const comprobar = async (
          fila: Record<string, unknown>,
        ): Promise<ResultadoRegistro> => {
          const coincide =
            fila.entity_type === intencion.entityType &&
            typeof fila.entity_id === 'string' &&
            fila.entity_id.toLowerCase() === intencion.entityId.toLowerCase() &&
            typeof fila.correlation_id === 'string' &&
            fila.correlation_id.toLowerCase() ===
              intencion.correlationId.toLowerCase() &&
            fila.source_version !== null &&
            String(fila.source_version) === String(intencion.version);
          if (!coincide) return 'CONFLICTO';
          if (intencion.entityType === 'PRODUCT_TYPE_CHARACTERISTIC') {
            const asociacion = await tx.execute(
              sql`SELECT tipo_producto_id, caracteristica_id FROM taxonomy.product_type_characteristics WHERE id = ${intencion.entityId}::uuid`,
            );
            const row = asociacion.rows[0];
            if (
              !row ||
              typeof row.tipo_producto_id !== 'string' ||
              typeof row.caracteristica_id !== 'string' ||
              row.tipo_producto_id.toLowerCase() !==
                intencion.tipoProductoId?.toLowerCase() ||
              row.caracteristica_id.toLowerCase() !==
                intencion.caracteristicaId?.toLowerCase()
            )
              return 'CONFLICTO';
          }
          return 'REINTENTO';
        };
        if (existente.rows[0]) return comprobar(existente.rows[0]);
        const fuente = await bloquearFuenteBaja(
          tx,
          intencion.entityType,
          intencion.entityId,
        );
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
        const fila = fuente;
        if (
          !fila ||
          fila.estado !== 'ACTIVO' ||
          fila.version !== intencion.version ||
          (intencion.entityType === 'PRODUCT_TYPE_CHARACTERISTIC' &&
            (fila.tipoProductoId !== intencion.tipoProductoId ||
              fila.caracteristicaId !== intencion.caracteristicaId))
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
          const transicion = await transicionarFuenteBaja(
            tx,
            intencion.entityType,
            intencion.entityId,
            intencion.version,
            'ACTIVO',
            'PENDING_DEACTIVATION',
          );
          if (!transicion) throw new Error('CAMBIO_CONCURRENTE');
          await tx.execute(sql`WITH evento AS (SELECT gen_random_uuid() AS message_id, statement_timestamp() AS fecha)
            INSERT INTO taxonomy.outbox (message_id, event_name, kind, schema_version, correlation_id, operation_id, occurred_at, payload)
            SELECT evento.message_id, 'taxonomy.master.deactivation.check.requested', 'command', 1,
              ${intencion.correlationId}::uuid, ${intencion.operationId}::uuid, evento.fecha,
              jsonb_build_object('message_id', evento.message_id, 'schema_version', 1, 'occurred_at', evento.fecha,
                'correlation_id', ${intencion.correlationId}::uuid, 'operation_id', ${intencion.operationId}::uuid,
                'producer', 'taxonomy-svc', 'kind', 'command', 'name', 'taxonomy.master.deactivation.check.requested',
                'data', jsonb_build_object('entity_type', ${intencion.entityType}::text, 'entity_id', ${intencion.entityId}::text,
                  'version', ${intencion.version}::bigint) || CASE WHEN ${intencion.entityType}::text = 'PRODUCT_TYPE_CHARACTERISTIC'
                    THEN jsonb_build_object('tipo_producto_id', ${intencion.tipoProductoId ?? null}::text, 'caracteristica_id', ${intencion.caracteristicaId ?? null}::text)
                    ELSE '{}'::jsonb END) FROM evento`);
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
    const ahora = Date.now();
    const inspeccionar = ahora >= this.proximaInspeccion;
    if (inspeccionar) this.proximaInspeccion = ahora + INTERVALO_AVISOS_MS;
    let resultado;
    try {
      resultado = await this.database.read((db) =>
        db.transaction(async (tx) => {
          const timeout = await leerTimeoutBaja(tx);
          const discrepancias = inspeccionar
            ? await tx.execute(sql`
          WITH inspeccion AS (
            SELECT o.operation_id, o.entity_type,
              CASE
                WHEN o.source_version IS NULL OR o.source_version > 9007199254740991 THEN 'VERSION_NO_VALIDA'
                WHEN o.entity_type = 'CATEGORY' AND c.id IS NULL THEN 'ENTIDAD_AUSENTE'
                WHEN o.entity_type = 'BRAND' AND b.id IS NULL THEN 'ENTIDAD_AUSENTE'
                WHEN o.entity_type = 'PRODUCT_TYPE' AND t.id IS NULL THEN 'ENTIDAD_AUSENTE'
                WHEN o.entity_type = 'CHARACTERISTIC_VALUE' AND v.id IS NULL THEN 'ENTIDAD_AUSENTE'
                WHEN o.entity_type = 'PRODUCT_TYPE_CHARACTERISTIC' AND (a.id IS NULL OR p.id IS NULL) THEN 'ENTIDAD_AUSENTE'
                WHEN o.entity_type = 'CATEGORY' AND c.estado <> 'PENDING_DEACTIVATION' THEN 'ESTADO_DISTINTO'
                WHEN o.entity_type = 'BRAND' AND b.estado <> 'PENDING_DEACTIVATION' THEN 'ESTADO_DISTINTO'
                WHEN o.entity_type = 'PRODUCT_TYPE' AND t.estado <> 'PENDING_DEACTIVATION' THEN 'ESTADO_DISTINTO'
                WHEN o.entity_type = 'CHARACTERISTIC_VALUE' AND v.estado <> 'PENDING_DEACTIVATION' THEN 'ESTADO_DISTINTO'
                WHEN o.entity_type = 'PRODUCT_TYPE_CHARACTERISTIC' AND a.estado <> 'PENDING_DEACTIVATION' THEN 'ESTADO_DISTINTO'
                WHEN o.entity_type = 'CATEGORY' AND c.taxonomy_version <> o.source_version THEN 'VERSION_DISTINTA'
                WHEN o.entity_type = 'BRAND' AND b.taxonomy_version <> o.source_version THEN 'VERSION_DISTINTA'
                WHEN o.entity_type = 'PRODUCT_TYPE' AND t.taxonomy_version <> o.source_version THEN 'VERSION_DISTINTA'
                WHEN o.entity_type = 'CHARACTERISTIC_VALUE' AND v.taxonomy_version <> o.source_version THEN 'VERSION_DISTINTA'
                WHEN o.entity_type = 'PRODUCT_TYPE_CHARACTERISTIC' AND p.schema_version <> o.source_version THEN 'VERSION_DISTINTA'
              END AS motivo
            FROM taxonomy.master_deactivation_operations o
            LEFT JOIN taxonomy.categories c ON o.entity_type = 'CATEGORY' AND c.id = o.entity_id
            LEFT JOIN taxonomy.brands b ON o.entity_type = 'BRAND' AND b.id = o.entity_id
            LEFT JOIN taxonomy.product_types t ON o.entity_type = 'PRODUCT_TYPE' AND t.id = o.entity_id
            LEFT JOIN taxonomy.characteristic_values v ON o.entity_type = 'CHARACTERISTIC_VALUE' AND v.id = o.entity_id
            LEFT JOIN taxonomy.product_type_characteristics a ON o.entity_type = 'PRODUCT_TYPE_CHARACTERISTIC' AND a.id = o.entity_id
            LEFT JOIN taxonomy.product_types p ON p.id = a.tipo_producto_id
            WHERE o.status = 'IN_PROGRESS' AND o.entity_type IN ('CATEGORY', 'BRAND', 'PRODUCT_TYPE', 'CHARACTERISTIC_VALUE', 'PRODUCT_TYPE_CHARACTERISTIC')
              AND o.created_at <= statement_timestamp() - (${timeout} * interval '1 second')
              AND (${this.cursorInspeccion}::uuid IS NULL OR o.operation_id > ${this.cursorInspeccion}::uuid)
          )
          SELECT operation_id, entity_type, motivo
          FROM inspeccion WHERE motivo IS NOT NULL ORDER BY operation_id LIMIT 51
        `)
            : { rows: [] };
          const pendientes = await tx.execute(sql`
          SELECT o.operation_id, o.correlation_id, o.entity_type, o.entity_id, o.source_version
          FROM taxonomy.master_deactivation_operations o
          WHERE o.status = 'IN_PROGRESS'
            AND o.created_at <= statement_timestamp() - (${timeout} * interval '1 second')
            AND o.source_version BETWEEN 0 AND 9007199254740991
            AND ((o.entity_type = 'CATEGORY' AND EXISTS (
              SELECT 1 FROM taxonomy.categories c WHERE c.id = o.entity_id
                AND c.estado = 'PENDING_DEACTIVATION' AND c.taxonomy_version = o.source_version
            )) OR (o.entity_type = 'BRAND' AND EXISTS (
              SELECT 1 FROM taxonomy.brands b WHERE b.id = o.entity_id
                AND b.estado = 'PENDING_DEACTIVATION' AND b.taxonomy_version = o.source_version
            )) OR (o.entity_type = 'PRODUCT_TYPE' AND EXISTS (
              SELECT 1 FROM taxonomy.product_types t WHERE t.id = o.entity_id AND t.estado = 'PENDING_DEACTIVATION' AND t.taxonomy_version = o.source_version
            )) OR (o.entity_type = 'CHARACTERISTIC_VALUE' AND EXISTS (
              SELECT 1 FROM taxonomy.characteristic_values v WHERE v.id = o.entity_id AND v.estado = 'PENDING_DEACTIVATION' AND v.taxonomy_version = o.source_version
            )) OR (o.entity_type = 'PRODUCT_TYPE_CHARACTERISTIC' AND EXISTS (
              SELECT 1 FROM taxonomy.product_type_characteristics a JOIN taxonomy.product_types p ON p.id = a.tipo_producto_id
              WHERE a.id = o.entity_id AND a.estado = 'PENDING_DEACTIVATION' AND p.schema_version = o.source_version
            )))
          ORDER BY o.created_at, o.operation_id
          LIMIT 50 FOR UPDATE OF o SKIP LOCKED
        `);
          let recuperadas = 0;
          const cambiosConcurrentes: string[] = [];
          for (const operacion of pendientes.rows) {
            if (
              typeof operacion.operation_id !== 'string' ||
              typeof operacion.correlation_id !== 'string' ||
              typeof operacion.entity_id !== 'string' ||
              ![
                'CATEGORY',
                'BRAND',
                'PRODUCT_TYPE',
                'CHARACTERISTIC_VALUE',
                'PRODUCT_TYPE_CHARACTERISTIC',
              ].includes(String(operacion.entity_type)) ||
              (typeof operacion.source_version !== 'string' &&
                typeof operacion.source_version !== 'number')
            )
              continue;
            const version = Number(operacion.source_version);
            if (!Number.isSafeInteger(version) || version < 0) continue;
            const tipo = operacion.entity_type as TipoMaestro;
            const fuente = await bloquearFuenteBaja(
              tx,
              tipo,
              operacion.entity_id,
            );
            const restaurada = await transicionarFuenteBaja(
              tx,
              tipo,
              operacion.entity_id,
              version,
              'PENDING_DEACTIVATION',
              'ACTIVO',
            );
            if (!restaurada || !fuente) {
              cambiosConcurrentes.push(operacion.operation_id);
              continue;
            }
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
                  'reason', 'TECHNICAL_FAILURE') || CASE WHEN ${tipo}::text = 'PRODUCT_TYPE_CHARACTERISTIC'
                  THEN jsonb_build_object('tipo_producto_id', ${fuente.tipoProductoId ?? null}::text, 'caracteristica_id', ${fuente.caracteristicaId ?? null}::text) ELSE '{}'::jsonb END)
            FROM evento
          `);
            recuperadas += 1;
          }
          return {
            recuperadas,
            discrepancias: discrepancias.rows,
            cambiosConcurrentes,
          };
        }),
      );
    } catch (error) {
      if (inspeccionar) this.proximaInspeccion = 0;
      throw error;
    }
    if (inspeccionar) {
      const ultima = resultado.discrepancias[49]?.operation_id;
      this.cursorInspeccion =
        resultado.discrepancias.length > 50 && typeof ultima === 'string'
          ? ultima
          : null;
    }
    for (const incidencia of resultado.discrepancias.slice(0, 50)) {
      this.logger.warn({
        event: 'taxonomy.deactivation.recovery_discrepancy',
        operation_id: incidencia.operation_id,
        entity_type: incidencia.entity_type,
        reason: incidencia.motivo,
        muestra_truncada: resultado.discrepancias.length > 50,
      });
    }
    const avisarConcurrentes =
      resultado.cambiosConcurrentes.length > 0 &&
      Date.now() >= this.proximoAvisoConcurrente;
    if (avisarConcurrentes)
      this.proximoAvisoConcurrente = Date.now() + INTERVALO_AVISOS_MS;
    for (const operationId of avisarConcurrentes
      ? resultado.cambiosConcurrentes
      : []) {
      this.logger.warn({
        event: 'taxonomy.deactivation.recovery_discrepancy',
        operation_id: operationId,
        reason: 'CAMBIO_CONCURRENTE',
      });
    }
    return resultado.recuperadas;
  }

  /** Persiste la decisión y su evento en outbox; no publica al broker. */
  async finalizar(
    respuesta: IdentidadBaja & { result: unknown },
  ): Promise<'COMPLETADA' | 'RECHAZADA' | 'IGNORADA'> {
    if (!esUuid(respuesta.operationId)) return 'IGNORADA';
    return this.database.read((db) =>
      db.transaction((tx) => this.finalizarEnTransaccion(tx, respuesta)),
    );
  }

  async finalizarEnTransaccion(
    tx: Pick<NodePgDatabase, 'execute'>,
    respuesta: IdentidadBaja & { result: unknown },
  ): Promise<'COMPLETADA' | 'RECHAZADA' | 'IGNORADA'> {
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
      ![
        'CATEGORY',
        'BRAND',
        'PRODUCT_TYPE',
        'CHARACTERISTIC_VALUE',
        'PRODUCT_TYPE_CHARACTERISTIC',
      ].includes(String(fila.entity_type)) ||
      (typeof fila.source_version !== 'string' &&
        typeof fila.source_version !== 'number')
    )
      return 'IGNORADA';
    const version = Number(fila.source_version);
    if (!Number.isSafeInteger(version) || version < 0) return 'IGNORADA';
    const tipo = fila.entity_type as TipoMaestro;
    const fuente = await bloquearFuenteBaja(tx, tipo, fila.entity_id);
    if (
      !fuente ||
      fuente.estado !== 'PENDING_DEACTIVATION' ||
      fuente.version !== version
    )
      return 'IGNORADA';
    const esperada: IdentidadBaja = {
      operationId: fila.operation_id,
      correlationId: fila.correlation_id,
      entityType: tipo,
      entityId: fila.entity_id,
      version,
      tipoProductoId: fuente.tipoProductoId,
      caracteristicaId: fuente.caracteristicaId,
    };
    const evaluacion = evaluarCheckBaja(esperada, respuesta);
    if (evaluacion === 'IGNORAR') return 'IGNORADA';
    const completa = evaluacion === 'EVALUAR_BAJA';
    const actualizada = await transicionarFuenteBaja(
      tx,
      tipo,
      fila.entity_id,
      version,
      'PENDING_DEACTIVATION',
      completa ? 'INACTIVO' : 'ACTIVO',
    );
    if (!actualizada) return 'IGNORADA';
    const status = completa ? 'COMPLETED' : 'REJECTED';
    const nombre = completa
      ? 'taxonomy.master.deactivated'
      : 'taxonomy.master.deactivation.rejected';
    const kind = completa ? 'event' : 'result';
    const reason = completa ? null : 'IN_USE';
    const asociacionFinal =
      completa && tipo === 'PRODUCT_TYPE_CHARACTERISTIC'
        ? await bloquearFuenteBaja(tx, tipo, fila.entity_id)
        : undefined;
    if (
      completa &&
      tipo === 'PRODUCT_TYPE_CHARACTERISTIC' &&
      (!asociacionFinal ||
        asociacionFinal.version !== version + 1 ||
        !asociacionFinal.tipoProductoId ||
        !asociacionFinal.caracteristicaId)
    )
      throw new Error('VERSION_ASOCIACION_INCONSISTENTE');
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
              'version', ${version}::bigint) || CASE WHEN ${completa}::boolean THEN '{}'::jsonb ELSE jsonb_build_object('reason', 'IN_USE') END
              || CASE WHEN ${tipo}::text = 'PRODUCT_TYPE_CHARACTERISTIC' THEN jsonb_build_object('tipo_producto_id', ${fuente.tipoProductoId ?? null}::text, 'caracteristica_id', ${fuente.caracteristicaId ?? null}::text) ELSE '{}'::jsonb END
              || CASE WHEN ${asociacionFinal?.version ?? null}::bigint IS NOT NULL THEN jsonb_build_object('schema_version_resultante', ${asociacionFinal?.version ?? null}::bigint) ELSE '{}'::jsonb END)
        FROM evento
      `);
    if (completa && tipo === 'PRODUCT_TYPE_CHARACTERISTIC') {
      const actual = asociacionFinal;
      if (
        !actual ||
        actual.version !== version + 1 ||
        !actual.tipoProductoId ||
        !actual.caracteristicaId
      )
        throw new Error('VERSION_ASOCIACION_INCONSISTENTE');
      await tx.execute(sql`WITH evento AS (SELECT gen_random_uuid() AS message_id, statement_timestamp() AS fecha)
        INSERT INTO taxonomy.outbox (message_id, event_name, kind, schema_version, correlation_id, operation_id, occurred_at, payload)
        SELECT evento.message_id, 'taxonomy.product-type-schema.changed', 'event', 1, ${fila.correlation_id}::uuid, ${fila.operation_id}::uuid, evento.fecha,
          jsonb_build_object('message_id', evento.message_id, 'schema_version', 1, 'occurred_at', evento.fecha,
            'correlation_id', ${fila.correlation_id}::uuid, 'operation_id', ${fila.operation_id}::uuid,
            'producer', 'taxonomy-svc', 'kind', 'event', 'name', 'taxonomy.product-type-schema.changed',
            'data', jsonb_build_object('tipo_producto_id', ${actual.tipoProductoId}::text, 'schema_version', ${actual.version}::bigint,
              'change_type', 'CHARACTERISTIC_DISASSOCIATED', 'caracteristica_id', ${actual.caracteristicaId}::text, 'updated_at', evento.fecha))
        FROM evento`);
    }
    return completa ? 'COMPLETADA' : 'RECHAZADA';
  }
}
