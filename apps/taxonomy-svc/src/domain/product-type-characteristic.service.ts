import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';

export type AsociacionDto = {
  caracteristicaId: string;
  obligatoria: boolean;
  estado: string;
  schemaVersion: number;
};
function mapear(row: Record<string, unknown>): AsociacionDto {
  const version = Number(row.schema_version);
  if (
    typeof row.caracteristica_id !== 'string' ||
    typeof row.obligatoria !== 'boolean' ||
    typeof row.estado !== 'string' ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw new Error('ASOCIACION_INVALIDA');
  return {
    caracteristicaId: row.caracteristica_id,
    obligatoria: row.obligatoria,
    estado: row.estado,
    schemaVersion: version,
  };
}

@Injectable()
export class ProductTypeCharacteristicService {
  constructor(private readonly database: Database) {}

  async listar(tipoId: string): Promise<AsociacionDto[]> {
    if (!esUuid(tipoId)) return [];
    return this.database.read(async (db) => {
      const result =
        await db.execute(sql`SELECT a.caracteristica_id, a.obligatoria, a.estado, t.schema_version
        FROM taxonomy.product_type_characteristics a JOIN taxonomy.product_types t ON t.id = a.tipo_producto_id
        WHERE a.tipo_producto_id = ${tipoId}::uuid AND a.estado = 'ACTIVO' ORDER BY a.caracteristica_id`);
      return result.rows.map(mapear);
    });
  }

  async actualizar(
    tipoId: string,
    caracteristicaId: string,
    obligatoria: boolean,
    version: number,
    correlationId: string = randomUUID(),
  ): Promise<
    | { estado: 'OK'; asociacion: AsociacionDto }
    | { estado: 'TIPO_AUSENTE' | 'ASOCIACION_AUSENTE' | 'VERSION_CONFLICT' }
  > {
    if (!esUuid(tipoId)) return { estado: 'TIPO_AUSENTE' };
    if (!esUuid(caracteristicaId)) return { estado: 'ASOCIACION_AUSENTE' };
    if (!esUuid(correlationId) || !Number.isSafeInteger(version) || version < 0)
      return { estado: 'VERSION_CONFLICT' };
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const tipo = (
          await tx.execute(
            sql`SELECT estado, schema_version FROM taxonomy.product_types WHERE id = ${tipoId}::uuid FOR UPDATE`,
          )
        ).rows[0];
        if (!tipo || tipo.estado !== 'ACTIVO')
          return { estado: 'TIPO_AUSENTE' } as const;
        if (String(tipo.schema_version) !== String(version))
          return { estado: 'VERSION_CONFLICT' } as const;
        const asociacion = (
          await tx.execute(
            sql`SELECT caracteristica_id, obligatoria, estado FROM taxonomy.product_type_characteristics WHERE tipo_producto_id=${tipoId}::uuid AND caracteristica_id=${caracteristicaId}::uuid FOR UPDATE`,
          )
        ).rows[0];
        if (!asociacion) return { estado: 'ASOCIACION_AUSENTE' } as const;
        if (asociacion.estado !== 'ACTIVO')
          return { estado: 'VERSION_CONFLICT' } as const;
        if (asociacion.obligatoria === obligatoria)
          return {
            estado: 'OK',
            asociacion: mapear({
              ...asociacion,
              schema_version: tipo.schema_version,
            }),
          } as const;
        const actualizada = (
          await tx.execute(sql`UPDATE taxonomy.product_type_characteristics SET obligatoria=${obligatoria}
        WHERE tipo_producto_id=${tipoId}::uuid AND caracteristica_id=${caracteristicaId}::uuid
        RETURNING caracteristica_id, obligatoria, estado`)
        ).rows[0];
        const vigente = (
          await tx.execute(
            sql`SELECT schema_version FROM taxonomy.product_types WHERE id=${tipoId}::uuid`,
          )
        ).rows[0];
        const schemaVersion = Number(vigente?.schema_version);
        if (
          !actualizada ||
          !Number.isSafeInteger(schemaVersion) ||
          schemaVersion !== version + 1
        )
          throw new Error('VERSION_INVALIDA');
        await tx.execute(sql`WITH evento AS (SELECT gen_random_uuid() AS message_id, statement_timestamp() AS fecha)
        INSERT INTO taxonomy.outbox (message_id, event_name, kind, schema_version, correlation_id, occurred_at, payload)
        SELECT evento.message_id, 'taxonomy.product-type-schema.changed', 'event', 1, ${correlationId}::uuid, evento.fecha,
          jsonb_build_object('message_id', evento.message_id, 'schema_version', 1, 'occurred_at', evento.fecha,
            'correlation_id', ${correlationId}::uuid, 'producer', 'taxonomy-svc', 'kind', 'event',
            'name', 'taxonomy.product-type-schema.changed', 'data', jsonb_build_object(
              'tipo_producto_id', ${tipoId}::text, 'schema_version', ${schemaVersion}::bigint,
              'change_type', 'REQUIRED_CHANGED', 'caracteristica_id', ${caracteristicaId}::text, 'updated_at', evento.fecha)) FROM evento`);
        return {
          estado: 'OK',
          asociacion: mapear({ ...actualizada, schema_version: schemaVersion }),
        } as const;
      }),
    );
  }

  async crear(
    tipoId: string,
    caracteristicaId: string,
    obligatoria: boolean,
    version?: number | null,
    correlationId: string = randomUUID(),
  ): Promise<
    | { estado: 'OK'; asociacion: AsociacionDto }
    | {
        estado:
          | 'TIPO_AUSENTE'
          | 'CARACTERISTICA_AUSENTE'
          | 'VERSION_CONFLICT'
          | 'ASOCIACION_DUPLICADA'
          | 'LIMITE';
      }
  > {
    if (!esUuid(tipoId)) return { estado: 'TIPO_AUSENTE' };
    if (!esUuid(caracteristicaId)) return { estado: 'CARACTERISTICA_AUSENTE' };
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const tipo = await tx.execute(
          sql`SELECT estado, schema_version FROM taxonomy.product_types WHERE id = ${tipoId}::uuid FOR UPDATE`,
        );
        if (!tipo.rows[0] || tipo.rows[0].estado !== 'ACTIVO')
          return { estado: 'TIPO_AUSENTE' } as const;
        if (
          version != null &&
          String(tipo.rows[0].schema_version) !== String(version)
        )
          return { estado: 'VERSION_CONFLICT' } as const;
        const caracteristica = await tx.execute(
          sql`SELECT estado FROM taxonomy.characteristics WHERE id = ${caracteristicaId}::uuid FOR UPDATE`,
        );
        if (
          !caracteristica.rows[0] ||
          caracteristica.rows[0].estado !== 'ACTIVO'
        )
          return { estado: 'CARACTERISTICA_AUSENTE' } as const;
        const existente = await tx.execute(
          sql`SELECT id FROM taxonomy.product_type_characteristics WHERE tipo_producto_id = ${tipoId}::uuid AND caracteristica_id = ${caracteristicaId}::uuid`,
        );
        if (existente.rows.length)
          return { estado: 'ASOCIACION_DUPLICADA' } as const;
        const limite = await tx.execute(
          sql`SELECT valor_integer FROM taxonomy.runtime_settings WHERE clave = 'MAX_PRODUCT_TYPE_ATTRIBUTES' FOR UPDATE`,
        );
        const maximo = Number(limite.rows[0]?.valor_integer);
        if (!Number.isSafeInteger(maximo) || maximo < 1)
          throw new Error('CONFIGURACION_INVALIDA');
        const activos = await tx.execute(
          sql`SELECT count(*)::int AS total FROM taxonomy.product_type_characteristics WHERE tipo_producto_id = ${tipoId}::uuid AND estado = 'ACTIVO'`,
        );
        if (Number(activos.rows[0]?.total) >= maximo)
          return { estado: 'LIMITE' } as const;
        const insertado =
          await tx.execute(sql`INSERT INTO taxonomy.product_type_characteristics (tipo_producto_id, caracteristica_id, obligatoria)
        VALUES (${tipoId}::uuid, ${caracteristicaId}::uuid, ${obligatoria}) ON CONFLICT (tipo_producto_id, caracteristica_id) DO NOTHING
        RETURNING caracteristica_id, obligatoria, estado`);
        if (!insertado.rows[0])
          return { estado: 'ASOCIACION_DUPLICADA' } as const;
        const actual = await tx.execute(
          sql`SELECT schema_version FROM taxonomy.product_types WHERE id = ${tipoId}::uuid`,
        );
        const schemaVersion = Number(actual.rows[0]?.schema_version);
        if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1)
          throw new Error('VERSION_INVALIDA');
        await tx.execute(sql`WITH evento AS (SELECT gen_random_uuid() AS message_id, statement_timestamp() AS fecha)
          INSERT INTO taxonomy.outbox (message_id, event_name, kind, schema_version, correlation_id, occurred_at, payload)
          SELECT evento.message_id, 'taxonomy.product-type-schema.changed', 'event', 1, ${correlationId}::uuid, evento.fecha,
            jsonb_build_object('message_id', evento.message_id, 'schema_version', 1, 'occurred_at', evento.fecha,
              'correlation_id', ${correlationId}::uuid, 'producer', 'taxonomy-svc', 'kind', 'event',
              'name', 'taxonomy.product-type-schema.changed', 'data', jsonb_build_object(
                'tipo_producto_id', ${tipoId}::text, 'schema_version', ${schemaVersion}::bigint,
                'change_type', 'CHARACTERISTIC_ASSOCIATED', 'caracteristica_id', ${caracteristicaId}::text, 'updated_at', evento.fecha))
          FROM evento`);
        return {
          estado: 'OK',
          asociacion: mapear({
            ...insertado.rows[0],
            schema_version: actual.rows[0]?.schema_version,
          }),
        } as const;
      }),
    );
  }
}
