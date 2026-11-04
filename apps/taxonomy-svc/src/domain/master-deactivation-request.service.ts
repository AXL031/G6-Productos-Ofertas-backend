import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';
import { DeactivationIntentService } from './deactivation-intent.service.js';

export type SolicitudMaestra =
  | { tipo: 'CATEGORY' | 'BRAND'; id: string }
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
    | { estado: 'CATEGORIA_CON_HIJOS' }
    | {
        estado: 'ACEPTADA';
        operation_id: string;
        correlation_id: string;
        status: 'ACCEPTED';
      }
  > {
    const ids: string[] = [];
    switch (solicitud.tipo) {
      case 'CATEGORY':
      case 'BRAND':
      case 'PRODUCT_TYPE':
        ids.push(solicitud.id);
        break;
      case 'CHARACTERISTIC_VALUE':
        ids.push(solicitud.id, solicitud.caracteristicaId);
        break;
      case 'PRODUCT_TYPE_CHARACTERISTIC':
        ids.push(solicitud.tipoProductoId, solicitud.caracteristicaId);
        break;
    }
    if (!esUuid(correlationId) || !ids.every(esUuid))
      return { estado: 'NO_ENCONTRADA' };
    const fuente = await this.database.read(async (db) => {
      if (solicitud.tipo === 'CATEGORY')
        return db.execute(
          sql`SELECT id, taxonomy_version AS version FROM taxonomy.categories WHERE id = ${solicitud.id}::uuid`,
        );
      if (solicitud.tipo === 'BRAND')
        return db.execute(
          sql`SELECT id, taxonomy_version AS version FROM taxonomy.brands WHERE id = ${solicitud.id}::uuid`,
        );
      if (solicitud.tipo === 'PRODUCT_TYPE')
        return db.execute(
          sql`SELECT id, taxonomy_version AS version FROM taxonomy.product_types WHERE id = ${solicitud.id}::uuid`,
        );
      if (solicitud.tipo === 'CHARACTERISTIC_VALUE')
        return db.execute(
          sql`SELECT id, taxonomy_version AS version FROM taxonomy.characteristic_values WHERE id = ${solicitud.id}::uuid AND caracteristica_id = ${solicitud.caracteristicaId}::uuid`,
        );
      if ('tipoProductoId' in solicitud)
        return db.execute(
          sql`SELECT a.id, t.schema_version AS version FROM taxonomy.product_type_characteristics a JOIN taxonomy.product_types t ON t.id = a.tipo_producto_id WHERE a.tipo_producto_id = ${solicitud.tipoProductoId}::uuid AND a.caracteristica_id = ${solicitud.caracteristicaId}::uuid`,
        );
      throw new Error('SOLICITUD_MAESTRA_INVALIDA');
    });
    const row = fuente.rows[0];
    if (!row || typeof row.id !== 'string') return { estado: 'NO_ENCONTRADA' };
    if (solicitud.tipo === 'CATEGORY') {
      const hijos = await this.database.read((db) =>
        db.execute(sql`SELECT 1 FROM taxonomy.categories
        WHERE categoria_padre_id=${solicitud.id}::uuid AND estado='ACTIVO' LIMIT 1`),
      );
      if (hijos.rows.length) return { estado: 'CATEGORIA_CON_HIJOS' };
    }
    const existente = await this.database.read((db) =>
      db.execute(sql`SELECT operation_id FROM taxonomy.master_deactivation_operations
      WHERE entity_type=${solicitud.tipo}::taxonomy.tipo_entidad_maestra AND entity_id=${row.id}::uuid
        AND correlation_id=${correlationId}::uuid AND status IN ('REQUESTED','IN_PROGRESS') LIMIT 1`),
    );
    if (typeof existente.rows[0]?.operation_id === 'string')
      return {
        estado: 'ACEPTADA',
        operation_id: existente.rows[0].operation_id,
        correlation_id: correlationId,
        status: 'ACCEPTED',
      };
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 0)
      return { estado: 'CONFLICTO' };
    const operationId = randomUUID();
    const tipoProductoId =
      solicitud.tipo === 'PRODUCT_TYPE_CHARACTERISTIC'
        ? solicitud.tipoProductoId
        : undefined;
    const caracteristicaId =
      solicitud.tipo === 'PRODUCT_TYPE_CHARACTERISTIC' ||
      solicitud.tipo === 'CHARACTERISTIC_VALUE'
        ? solicitud.caracteristicaId
        : undefined;
    const resultado = await this.intentos.registrar({
      operationId,
      correlationId,
      entityType: solicitud.tipo,
      entityId: row.id,
      version,
      ...(solicitud.tipo === 'PRODUCT_TYPE_CHARACTERISTIC'
        ? {
            tipoProductoId,
            caracteristicaId,
          }
        : {}),
    });
    if (resultado !== 'REGISTRADA' && resultado !== 'REINTENTO') {
      const repetida = await this.database.read((db) =>
        db.execute(sql`SELECT operation_id FROM taxonomy.master_deactivation_operations
        WHERE entity_type=${solicitud.tipo}::taxonomy.tipo_entidad_maestra AND entity_id=${row.id}::uuid
          AND correlation_id=${correlationId}::uuid AND status IN ('REQUESTED','IN_PROGRESS') LIMIT 1`),
      );
      if (typeof repetida.rows[0]?.operation_id === 'string')
        return {
          estado: 'ACEPTADA',
          operation_id: repetida.rows[0].operation_id,
          correlation_id: correlationId,
          status: 'ACCEPTED',
        };
      return { estado: 'CONFLICTO' };
    }
    return {
      estado: 'ACEPTADA',
      operation_id: operationId,
      correlation_id: correlationId,
      status: 'ACCEPTED',
    };
  }
}
