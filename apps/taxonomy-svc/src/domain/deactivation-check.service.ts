import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';
import { leerTimeoutBaja } from './deactivation-timeout.js';
import {
  evaluarCheckBaja,
  type IdentidadBaja,
  type ResultadoEvaluacion,
  type TipoMaestro,
} from './deactivation-check.js';

/** Evalúa un check persistido; no cambia estados ni publica eventos. */
@Injectable()
export class DeactivationCheckService {
  constructor(private readonly database: Database) {}

  async evaluar(
    respuesta: IdentidadBaja & { result: unknown },
  ): Promise<ResultadoEvaluacion> {
    if (!esUuid(respuesta.operationId)) return 'IGNORAR';
    const fila = await this.database.read(async (db) => {
      const timeout = await leerTimeoutBaja(db);
      const consulta = await db.execute(sql`
        SELECT o.operation_id, o.correlation_id, o.entity_type, o.entity_id,
               o.source_version, p.tipo_producto_id, p.caracteristica_id
          FROM taxonomy.master_deactivation_operations o
          LEFT JOIN taxonomy.product_type_characteristics p
            ON o.entity_type = 'PRODUCT_TYPE_CHARACTERISTIC' AND p.id = o.entity_id
         WHERE o.operation_id = ${respuesta.operationId}::uuid
           AND o.status = 'IN_PROGRESS'
           AND o.created_at > statement_timestamp() - (${timeout} * interval '1 second')
      `);
      return consulta.rows[0];
    });
    if (
      !fila ||
      typeof fila.operation_id !== 'string' ||
      typeof fila.correlation_id !== 'string' ||
      typeof fila.entity_type !== 'string' ||
      typeof fila.entity_id !== 'string' ||
      (typeof fila.source_version !== 'string' &&
        typeof fila.source_version !== 'number')
    )
      return 'IGNORAR';
    const version = Number(fila.source_version);
    if (!Number.isSafeInteger(version) || version < 0) return 'IGNORAR';
    const identidad: IdentidadBaja = {
      operationId: fila.operation_id,
      correlationId: fila.correlation_id,
      entityType: fila.entity_type as TipoMaestro,
      entityId: fila.entity_id,
      version,
      tipoProductoId:
        typeof fila.tipo_producto_id === 'string'
          ? fila.tipo_producto_id
          : undefined,
      caracteristicaId:
        typeof fila.caracteristica_id === 'string'
          ? fila.caracteristica_id
          : undefined,
    };
    return evaluarCheckBaja(identidad, respuesta);
  }
}
