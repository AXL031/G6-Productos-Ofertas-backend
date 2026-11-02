import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import {
  CreateIncidenciaInput,
  IIncidentsRepository,
  IncidenciaEntity,
  ResolveIncidenciaInput,
} from '../interfaces/incidents.repository.interface.js';

const SELECT_COLUMNS = `
  id, incidencia_id, sku_id, location_id, external_incident_id, act_ref,
  estado, tipo_resolucion, cantidad_bloqueada, idempotency_key,
  correlation_id, created_at, updated_at, resolved_at
`;

@Injectable()
export class DrizzleIncidentsRepository implements IIncidentsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  private mapRow(row: any): IncidenciaEntity {
    return {
      id: row.id,
      incidencia_id: row.incidencia_id,
      sku_id: row.sku_id,
      location_id: row.location_id,
      external_incident_id: row.external_incident_id ?? null,
      act_ref: row.act_ref ?? null,
      estado: row.estado,
      tipo_resolucion: row.tipo_resolucion ?? null,
      cantidad_bloqueada: Number(row.cantidad_bloqueada),
      idempotency_key: row.idempotency_key,
      correlation_id: row.correlation_id ?? null,
      created_at:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
      updated_at:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : row.updated_at,
      resolved_at:
        row.resolved_at instanceof Date
          ? row.resolved_at.toISOString()
          : (row.resolved_at ?? null),
    };
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
    client?: IDatabaseClient,
  ): Promise<IncidenciaEntity | null> {
    const sql = `SELECT ${SELECT_COLUMNS} FROM inventory.incidencias WHERE idempotency_key = $1`;
    const res = client
      ? await client.query(sql, [idempotencyKey])
      : await this.databaseService.query(sql, [idempotencyKey]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findByIncidenciaIdForUpdate(
    client: IDatabaseClient,
    incidenciaId: string,
  ): Promise<IncidenciaEntity | null> {
    const sql = `SELECT ${SELECT_COLUMNS} FROM inventory.incidencias WHERE incidencia_id = $1 FOR UPDATE`;
    const res = await client.query(sql, [incidenciaId]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async create(
    client: IDatabaseClient,
    input: CreateIncidenciaInput,
  ): Promise<IncidenciaEntity> {
    const sql = `
      INSERT INTO inventory.incidencias (
        incidencia_id, sku_id, location_id, external_incident_id,
        estado, cantidad_bloqueada, idempotency_key, correlation_id
      ) VALUES ($1, $2, $3, $4, 'ABIERTA', $5, $6, $7)
      RETURNING ${SELECT_COLUMNS}
    `;
    const res = await client.query(sql, [
      input.incidencia_id,
      input.sku_id,
      input.location_id,
      input.external_incident_id ?? null,
      input.cantidad_bloqueada,
      input.idempotency_key,
      input.correlation_id ?? null,
    ]);
    return this.mapRow(res.rows[0]);
  }

  async resolve(
    client: IDatabaseClient,
    input: ResolveIncidenciaInput,
  ): Promise<IncidenciaEntity> {
    const sql = `
      UPDATE inventory.incidencias
         SET estado = $1, tipo_resolucion = $2, act_ref = $3,
             resolved_at = now(), updated_at = now()
       WHERE id = $4
      RETURNING ${SELECT_COLUMNS}
    `;
    const res = await client.query(sql, [
      input.estado,
      input.tipo_resolucion,
      input.act_ref,
      input.id,
    ]);
    return this.mapRow(res.rows[0]);
  }
}
