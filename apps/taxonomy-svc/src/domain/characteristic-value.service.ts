import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';

export type ValorCaracteristicaDto = {
  valorId: string;
  nombre: string;
  estado: string;
  version: number;
};
function mapear(row: Record<string, unknown>): ValorCaracteristicaDto {
  const version = Number(row.taxonomy_version);
  if (
    typeof row.id !== 'string' ||
    typeof row.nombre !== 'string' ||
    typeof row.estado !== 'string' ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    throw new Error('VALOR_CARACTERISTICA_INVALIDO');
  return { valorId: row.id, nombre: row.nombre, estado: row.estado, version };
}

@Injectable()
export class CharacteristicValueService {
  constructor(private readonly database: Database) {}

  async listar(
    caracteristicaId: string,
    estado?: string,
  ): Promise<ValorCaracteristicaDto[] | null> {
    if (!esUuid(caracteristicaId)) return null;
    return this.database.read(async (db) => {
      const padre = await db.execute(
        sql`SELECT id,estado FROM taxonomy.characteristics WHERE id = ${caracteristicaId}::uuid`,
      );
      if (
        !padre.rows.length ||
        padre.rows[0]?.estado === 'PENDING_DEACTIVATION'
      )
        return null;
      const result =
        await db.execute(sql`SELECT id, nombre, estado, taxonomy_version
        FROM taxonomy.characteristic_values WHERE caracteristica_id = ${caracteristicaId}::uuid
          AND estado::text IN ('ACTIVO', 'INACTIVO')
          AND (${estado ?? null}::text IS NULL OR estado::text = ${estado ?? null}::text) ORDER BY nombre, id`);
      return result.rows.map(mapear);
    });
  }

  async crear(
    caracteristicaId: string,
    nombre: string,
  ): Promise<
    | { estado: 'OK'; valor: ValorCaracteristicaDto }
    | { estado: 'NO_ENCONTRADA' }
    | { estado: 'INVALIDO' }
    | { estado: 'LIMITE' }
  > {
    if (!esUuid(caracteristicaId)) return { estado: 'NO_ENCONTRADA' };
    if (!nombre.trim()) return { estado: 'INVALIDO' };
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const padre = await tx.execute(
          sql`SELECT tipo, estado FROM taxonomy.characteristics WHERE id = ${caracteristicaId}::uuid FOR UPDATE`,
        );
        if (!padre.rows[0]) return { estado: 'NO_ENCONTRADA' } as const;
        if (padre.rows[0].tipo !== 'LISTA' || padre.rows[0].estado !== 'ACTIVO')
          return { estado: 'INVALIDO' } as const;
        const ajuste = await tx.execute(
          sql`SELECT valor_integer FROM taxonomy.runtime_settings WHERE clave = 'MAX_ACTIVE_LIST_VALUES' FOR UPDATE`,
        );
        const limite = Number(ajuste.rows[0]?.valor_integer);
        if (!Number.isSafeInteger(limite) || limite < 1)
          throw new Error('CONFIGURACION_INVALIDA');
        const activos = await tx.execute(
          sql`SELECT count(*)::int AS total FROM taxonomy.characteristic_values WHERE caracteristica_id = ${caracteristicaId}::uuid AND estado = 'ACTIVO'`,
        );
        if (Number(activos.rows[0]?.total) >= limite)
          return { estado: 'LIMITE' } as const;
        const insertado =
          await tx.execute(sql`INSERT INTO taxonomy.characteristic_values (caracteristica_id, nombre)
        VALUES (${caracteristicaId}::uuid, ${nombre}) ON CONFLICT (caracteristica_id, nombre) DO NOTHING
        RETURNING id, nombre, estado, taxonomy_version`);
        return insertado.rows[0]
          ? ({ estado: 'OK', valor: mapear(insertado.rows[0]) } as const)
          : ({ estado: 'INVALIDO' } as const);
      }),
    );
  }

  async actualizar(
    caracteristicaId: string,
    id: string,
    nombre: string,
    version?: number | null,
    correlationId: string = randomUUID(),
  ): Promise<
    | { estado: 'OK'; valor: ValorCaracteristicaDto }
    | { estado: 'NO_ENCONTRADA' }
    | { estado: 'VERSION_CONFLICT' }
    | { estado: 'INVALIDO' }
  > {
    if (!esUuid(caracteristicaId) || !esUuid(id))
      return { estado: 'NO_ENCONTRADA' };
    if (!esUuid(correlationId) || !nombre.trim()) return { estado: 'INVALIDO' };
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const padre = await tx.execute(
          sql`SELECT tipo, estado FROM taxonomy.characteristics WHERE id = ${caracteristicaId}::uuid FOR UPDATE`,
        );
        if (!padre.rows[0]) return { estado: 'NO_ENCONTRADA' } as const;
        if (padre.rows[0].tipo !== 'LISTA' || padre.rows[0].estado !== 'ACTIVO')
          return { estado: 'INVALIDO' } as const;
        const actual = await tx.execute(
          sql`SELECT id, nombre, estado, taxonomy_version FROM taxonomy.characteristic_values WHERE id = ${id}::uuid AND caracteristica_id = ${caracteristicaId}::uuid FOR UPDATE`,
        );
        const row = actual.rows[0];
        if (!row) return { estado: 'NO_ENCONTRADA' } as const;
        if (
          row.estado !== 'ACTIVO' ||
          (version != null && String(row.taxonomy_version) !== String(version))
        )
          return { estado: 'VERSION_CONFLICT' } as const;
        if (row.nombre === nombre)
          return { estado: 'OK', valor: mapear(row) } as const;
        const duplicado = await tx.execute(
          sql`SELECT id FROM taxonomy.characteristic_values WHERE caracteristica_id = ${caracteristicaId}::uuid AND nombre = ${nombre} AND id <> ${id}::uuid`,
        );
        if (duplicado.rows.length) return { estado: 'INVALIDO' } as const;
        const actualizada = await tx.execute(
          sql`UPDATE taxonomy.characteristic_values SET nombre = ${nombre}, taxonomy_version = taxonomy_version + 1 WHERE id = ${id}::uuid RETURNING id, nombre, estado, taxonomy_version, updated_at`,
        );
        const fila = actualizada.rows[0];
        if (!fila) throw new Error('VALOR_CARACTERISTICA_INVALIDO');
        await tx.execute(sql`WITH evento AS (SELECT gen_random_uuid() AS message_id, statement_timestamp() AS fecha)
        INSERT INTO taxonomy.outbox (message_id, event_name, kind, schema_version, correlation_id, occurred_at, payload)
        SELECT evento.message_id, 'taxonomy.characteristic-value.updated', 'event', 1, ${correlationId}::uuid, evento.fecha,
          jsonb_build_object('message_id', evento.message_id, 'schema_version', 1, 'occurred_at', evento.fecha,
            'correlation_id', ${correlationId}::uuid, 'producer', 'taxonomy-svc', 'kind', 'event',
            'name', 'taxonomy.characteristic-value.updated', 'data', jsonb_build_object('caracteristica_id', ${caracteristicaId}::text,
              'valor_id', ${id}::text, 'nombre', ${nombre}::text, 'change_type', 'RENAMED', 'updated_at', ${fila.updated_at}::timestamptz)) FROM evento`);
        return { estado: 'OK', valor: mapear(fila) } as const;
      }),
    );
  }

  async reactivar(
    caracteristicaId: string,
    id: string,
  ): Promise<ValorCaracteristicaDto | null> {
    if (!esUuid(caracteristicaId) || !esUuid(id)) return null;
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const parent =
          await tx.execute(sql`SELECT tipo,estado FROM taxonomy.characteristics
        WHERE id=${caracteristicaId}::uuid FOR UPDATE`);
        const characteristic = parent.rows[0];
        if (
          !characteristic ||
          characteristic.tipo !== 'LISTA' ||
          characteristic.estado !== 'ACTIVO'
        )
          return null;
        const current =
          await tx.execute(sql`SELECT id,nombre,estado,taxonomy_version FROM taxonomy.characteristic_values
        WHERE id=${id}::uuid AND caracteristica_id=${caracteristicaId}::uuid FOR UPDATE`);
        const row = current.rows[0];
        if (!row || row.estado === 'PENDING_DEACTIVATION') return null;
        if (row.estado === 'INACTIVO') {
          const limit = await tx.execute(
            sql`SELECT valor_integer FROM taxonomy.runtime_settings WHERE clave='MAX_ACTIVE_LIST_VALUES' FOR UPDATE`,
          );
          const max = Number(limit.rows[0]?.valor_integer);
          if (!Number.isSafeInteger(max) || max < 1)
            throw new Error('CONFIGURACION_INVALIDA');
          const count = await tx.execute(
            sql`SELECT count(*)::int AS total FROM taxonomy.characteristic_values WHERE caracteristica_id=${caracteristicaId}::uuid AND estado='ACTIVO'`,
          );
          if (Number(count.rows[0]?.total) >= max) return null;
          const updated =
            await tx.execute(sql`UPDATE taxonomy.characteristic_values SET estado='ACTIVO',taxonomy_version=taxonomy_version+1,updated_at=statement_timestamp()
          WHERE id=${id}::uuid AND estado='INACTIVO' RETURNING id,nombre,estado,taxonomy_version`);
          return updated.rows[0] ? mapear(updated.rows[0]) : null;
        }
        return mapear(row);
      }),
    );
  }
}
