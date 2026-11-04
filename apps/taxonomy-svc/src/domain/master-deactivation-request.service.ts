import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';
import { DeactivationIntentService } from './deactivation-intent.service.js';

export type SolicitudMaestra =
  | { tipo: 'PRODUCT_TYPE'; id: string }
  | { tipo: 'CHARACTERISTIC_VALUE'; id: string; caracteristicaId: string }
  | {
      tipo: 'PRODUCT_TYPE_CHARACTERISTIC';
      tipoProductoId: string;
      caracteristicaId: string;
    };

@Injectable()
export class MasterDeactivationRequestService {
  constructor(
    private readonly database: Database,
    private readonly intentos: DeactivationIntentService,
  ) {}

  async solicitar(
    solicitud: SolicitudMaestra,
    correlationId: string = randomUUID(),
  ): Promise<
    | { estado: 'NO_ENCONTRADA' }
    | { estado: 'CONFLICTO' }
    | {
        estado: 'ACEPTADA';
        operation_id: string;
        correlation_id: string;
        status: 'ACCEPTED';
      }
  > {
    const ids =
      solicitud.tipo === 'PRODUCT_TYPE'
        ? [solicitud.id]
        : solicitud.tipo === 'CHARACTERISTIC_VALUE'
          ? [solicitud.id, solicitud.caracteristicaId]
          : [solicitud.tipoProductoId, solicitud.caracteristicaId];
    if (!esUuid(correlationId) || !ids.every(esUuid))
      return { estado: 'NO_ENCONTRADA' };
    const fuente = await this.database.read(async (db) => {
      if (solicitud.tipo === 'PRODUCT_TYPE')
        return db.execute(
          sql`SELECT id, taxonomy_version AS version FROM taxonomy.product_types WHERE id = ${solicitud.id}::uuid`,
        );
      if (solicitud.tipo === 'CHARACTERISTIC_VALUE')
        return db.execute(
          sql`SELECT id, taxonomy_version AS version FROM taxonomy.characteristic_values WHERE id = ${solicitud.id}::uuid AND caracteristica_id = ${solicitud.caracteristicaId}::uuid`,
        );
      return db.execute(
        sql`SELECT a.id, t.schema_version AS version FROM taxonomy.product_type_characteristics a JOIN taxonomy.product_types t ON t.id = a.tipo_producto_id WHERE a.tipo_producto_id = ${solicitud.tipoProductoId}::uuid AND a.caracteristica_id = ${solicitud.caracteristicaId}::uuid`,
      );
    });
    const row = fuente.rows[0];
    if (!row || typeof row.id !== 'string') return { estado: 'NO_ENCONTRADA' };
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 0)
      return { estado: 'CONFLICTO' };
    const operationId = randomUUID();
    const resultado = await this.intentos.registrar({
      operationId,
      correlationId,
      entityType: solicitud.tipo,
      entityId: row.id,
      version,
      ...(solicitud.tipo === 'PRODUCT_TYPE_CHARACTERISTIC'
        ? {
            tipoProductoId: solicitud.tipoProductoId,
            caracteristicaId: solicitud.caracteristicaId,
          }
        : {}),
    });
    if (resultado !== 'REGISTRADA' && resultado !== 'REINTENTO')
      return { estado: 'CONFLICTO' };
    return {
      estado: 'ACEPTADA',
      operation_id: operationId,
      correlation_id: correlationId,
      status: 'ACCEPTED',
    };
  }
}
