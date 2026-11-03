import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
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
        sql`SELECT id FROM taxonomy.characteristics WHERE id = ${caracteristicaId}::uuid`,
      );
      if (!padre.rows.length) return null;
      const result =
        await db.execute(sql`SELECT id, nombre, estado, taxonomy_version
        FROM taxonomy.characteristic_values WHERE caracteristica_id = ${caracteristicaId}::uuid AND (${estado ?? null}::text IS NULL OR estado::text = ${estado ?? null}::text) ORDER BY nombre, id`);
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
        const activos = await tx.execute(
          sql`SELECT count(*)::int AS total FROM taxonomy.characteristic_values WHERE caracteristica_id = ${caracteristicaId}::uuid AND estado = 'ACTIVO'`,
        );
        if (Number(activos.rows[0]?.total) >= 50)
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
}
