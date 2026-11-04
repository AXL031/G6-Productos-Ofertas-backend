import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import {
  CreateRecepcionTrasladoInput,
  CreateTrasladoInput,
  ITrasladosRepository,
  ListTrasladosFilters,
  RecepcionTrasladoEntity,
  TrasladoEntity,
  UpdateTrasladoInput,
} from '../interfaces/traslados.repository.interface.js';

const TRASLADO_COLUMNS = `
  id, traslado_id, source_incident_id, sku_id, source_location_id,
  target_location_id, quantity_shipped, quantity_received, missing_quantity,
  estado, created_at, updated_at
`;

const RECEPCION_COLUMNS = `
  id, recepcion_id, cantidad_recibida, disposicion, es_recepcion_final,
  sub_gestor, idempotency_key, received_at
`;

@Injectable()
export class DrizzleTrasladosRepository implements ITrasladosRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  private mapTraslado(row: any): TrasladoEntity {
    return {
      id: row.id,
      traslado_id: row.traslado_id,
      source_incident_id: row.source_incident_id ?? null,
      sku_id: row.sku_id,
      source_location_id: row.source_location_id,
      target_location_id: row.target_location_id,
      quantity_shipped: Number(row.quantity_shipped),
      quantity_received: Number(row.quantity_received),
      missing_quantity:
        row.missing_quantity === null || row.missing_quantity === undefined
          ? null
          : Number(row.missing_quantity),
      estado: row.estado,
      created_at:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
      updated_at:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : row.updated_at,
    };
  }

  private mapRecepcion(row: any): RecepcionTrasladoEntity {
    return {
      id: row.id,
      recepcion_id: row.recepcion_id,
      cantidad_recibida: Number(row.cantidad_recibida),
      disposicion: row.disposicion,
      es_recepcion_final: Boolean(row.es_recepcion_final),
      sub_gestor: row.sub_gestor,
      idempotency_key: row.idempotency_key,
      received_at:
        row.received_at instanceof Date
          ? row.received_at.toISOString()
          : row.received_at,
    };
  }

  async findByIdForUpdate(
    client: IDatabaseClient,
    trasladoId: string,
  ): Promise<TrasladoEntity | null> {
    const res = await client.query(
      `SELECT ${TRASLADO_COLUMNS} FROM inventory.traslados WHERE traslado_id = $1 FOR UPDATE`,
      [trasladoId],
    );
    if (res.rows.length === 0) return null;
    return this.mapTraslado(res.rows[0]);
  }

  async findByTrasladoId(
    trasladoId: string,
    client?: IDatabaseClient,
  ): Promise<TrasladoEntity | null> {
    const sql = `SELECT ${TRASLADO_COLUMNS} FROM inventory.traslados WHERE traslado_id = $1`;
    const res = client
      ? await client.query(sql, [trasladoId])
      : await this.databaseService.query(sql, [trasladoId]);
    if (res.rows.length === 0) return null;
    return this.mapTraslado(res.rows[0]);
  }

  async findRecepcionByRecepcionId(
    recepcionId: string,
    client?: IDatabaseClient,
  ): Promise<RecepcionTrasladoEntity | null> {
    const sql = `SELECT ${RECEPCION_COLUMNS} FROM inventory.traslado_recepciones WHERE recepcion_id = $1`;
    const res = client
      ? await client.query(sql, [recepcionId])
      : await this.databaseService.query(sql, [recepcionId]);
    if (res.rows.length === 0) return null;
    return this.mapRecepcion(res.rows[0]);
  }

  async findRecepcionByIdempotencyKey(
    idempotencyKey: string,
    client?: IDatabaseClient,
  ): Promise<RecepcionTrasladoEntity | null> {
    const sql = `SELECT ${RECEPCION_COLUMNS} FROM inventory.traslado_recepciones WHERE idempotency_key = $1`;
    const res = client
      ? await client.query(sql, [idempotencyKey])
      : await this.databaseService.query(sql, [idempotencyKey]);
    if (res.rows.length === 0) return null;
    return this.mapRecepcion(res.rows[0]);
  }

  async list(
    filters: ListTrasladosFilters,
    client?: IDatabaseClient,
  ): Promise<{ items: TrasladoEntity[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    if (filters.estado) {
      params.push(filters.estado);
      conditions.push(`estado = $${params.length}`);
    }
    if (filters.targetLocationId) {
      params.push(filters.targetLocationId);
      conditions.push(`target_location_id = $${params.length}`);
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*)::int AS total FROM inventory.traslados ${where}`;
    const offset = (filters.pagina - 1) * filters.tamanio;
    const listParams = [...params, filters.tamanio, offset];
    const listSql = `
      SELECT ${TRASLADO_COLUMNS}
      FROM inventory.traslados
      ${where}
      ORDER BY created_at ASC, traslado_id ASC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;

    const runner = client ?? this.databaseService;
    const countRes = await runner.query(countSql, params);
    const listRes = await runner.query(listSql, listParams);
    return {
      items: listRes.rows.map((row: any) => this.mapTraslado(row)),
      total: Number((countRes.rows[0] as any)?.total ?? 0),
    };
  }

  async create(
    client: IDatabaseClient,
    input: CreateTrasladoInput,
  ): Promise<TrasladoEntity> {
    const sql = `
      INSERT INTO inventory.traslados (
        traslado_id, source_incident_id, sku_id, source_location_id,
        target_location_id, quantity_shipped, quantity_received, estado
      ) VALUES ($1, $2, $3, $4, $5, $6, 0, 'EN_TRANSITO')
      RETURNING ${TRASLADO_COLUMNS}
    `;
    const res = await client.query(sql, [
      input.traslado_id,
      input.source_incident_id ?? null,
      input.sku_id,
      input.source_location_id,
      input.target_location_id,
      input.quantity_shipped,
    ]);
    return this.mapTraslado(res.rows[0]);
  }

  async createRecepcion(
    client: IDatabaseClient,
    input: CreateRecepcionTrasladoInput,
  ): Promise<RecepcionTrasladoEntity> {
    const sql = `
      INSERT INTO inventory.traslado_recepciones (
        recepcion_id, traslado_id, cantidad_recibida, disposicion,
        es_recepcion_final, sub_gestor, idempotency_key, received_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING ${RECEPCION_COLUMNS}
    `;
    const res = await client.query(sql, [
      input.recepcion_id,
      input.traslado_pk,
      input.cantidad_recibida,
      input.disposicion,
      input.es_recepcion_final,
      input.sub_gestor,
      input.idempotency_key,
      input.received_at,
    ]);
    return this.mapRecepcion(res.rows[0]);
  }

  async update(
    client: IDatabaseClient,
    input: UpdateTrasladoInput,
  ): Promise<TrasladoEntity> {
    const sql = `
      UPDATE inventory.traslados
         SET quantity_received = $1, missing_quantity = $2, estado = $3,
             updated_at = now()
       WHERE id = $4
      RETURNING ${TRASLADO_COLUMNS}
    `;
    const res = await client.query(sql, [
      input.quantity_received,
      input.missing_quantity,
      input.estado,
      input.id,
    ]);
    return this.mapTraslado(res.rows[0]);
  }
}
