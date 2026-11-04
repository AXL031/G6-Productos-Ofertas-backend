import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';

export type CaracteristicaAdmin = {
  caracteristicaId: string;
  nombre: string;
  tipo: 'TEXTO' | 'NUMERO' | 'LISTA';
  unidadMedida: string | null;
  estado: 'ACTIVO' | 'INACTIVO';
  version: number;
  valores: {
    valorId: string;
    nombre: string;
    estado: 'ACTIVO' | 'INACTIVO';
    version: number;
  }[];
};
type Fila = Record<string, unknown>;
function dto(row: Fila): CaracteristicaAdmin {
  const tipo = row.tipo;
  const estado = row.estado;
  const version = Number(row.taxonomy_version);
  if (
    typeof row.id !== 'string' ||
    typeof row.nombre !== 'string' ||
    !['TEXTO', 'NUMERO', 'LISTA'].includes(String(tipo)) ||
    !['ACTIVO', 'INACTIVO'].includes(String(estado)) ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    throw new Error('CARACTERISTICA_INVALIDA');
  const valores = row.valores === undefined ? [] : row.valores;
  if (
    !Array.isArray(valores) ||
    !valores.every(
      (valor): valor is CaracteristicaAdmin['valores'][number] =>
        typeof valor === 'object' &&
        valor !== null &&
        typeof valor.valorId === 'string' &&
        typeof valor.nombre === 'string' &&
        (valor.estado === 'ACTIVO' || valor.estado === 'INACTIVO') &&
        Number.isSafeInteger(Number(valor.version)) &&
        Number(valor.version) >= 0,
    )
  )
    throw new Error('VALORES_CARACTERISTICA_INVALIDOS');
  return {
    caracteristicaId: row.id,
    nombre: row.nombre,
    tipo: tipo as CaracteristicaAdmin['tipo'],
    unidadMedida: row.unidad_medida as string | null,
    estado: estado as CaracteristicaAdmin['estado'],
    version,
    valores: valores as CaracteristicaAdmin['valores'],
  };
}

@Injectable()
export class CharacteristicService {
  constructor(private readonly database: Database) {}

  async listar(f: {
    pagina: number;
    tamanio: number;
    estado?: string;
    tipo?: string;
  }) {
    return this.database.read(async (db) =>
      db.transaction(async (tx) => {
        const count =
          await tx.execute(sql`SELECT count(*)::int AS total FROM taxonomy.characteristics
        WHERE estado::text IN ('ACTIVO', 'INACTIVO')
        AND (${f.estado ?? null}::text IS NULL OR estado::text = ${f.estado ?? null}::text)
        AND (${f.tipo ?? null}::text IS NULL OR tipo::text = ${f.tipo ?? null}::text)`);
        const rows =
          await tx.execute(sql`SELECT c.id,c.nombre,c.tipo,c.unidad_medida,c.estado,c.taxonomy_version,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('valorId',v.id,'nombre',v.nombre,'estado',v.estado,'version',v.taxonomy_version) ORDER BY v.nombre,v.id)
          FROM taxonomy.characteristic_values v WHERE v.caracteristica_id=c.id AND v.estado::text IN ('ACTIVO','INACTIVO')),'[]'::jsonb) AS valores
        FROM taxonomy.characteristics c WHERE c.estado::text IN ('ACTIVO', 'INACTIVO')
        AND (${f.estado ?? null}::text IS NULL OR c.estado::text = ${f.estado ?? null}::text)
        AND (${f.tipo ?? null}::text IS NULL OR c.tipo::text = ${f.tipo ?? null}::text)
        ORDER BY c.nombre,c.id LIMIT ${f.tamanio} OFFSET ${(f.pagina - 1) * f.tamanio}`);
        const total = Number(count.rows[0]?.total ?? 0);
        return {
          items: rows.rows.map(dto),
          meta: {
            pagina: f.pagina,
            tamanio: f.tamanio,
            total,
            totalPaginas: Math.ceil(total / f.tamanio),
          },
        };
      }),
    );
  }

  async obtener(id: string): Promise<CaracteristicaAdmin | undefined> {
    if (!esUuid(id)) return undefined;
    return this.database.read(async (db) => {
      const r =
        await db.execute(sql`SELECT c.id,c.nombre,c.tipo,c.unidad_medida,c.estado,c.taxonomy_version,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('valorId',v.id,'nombre',v.nombre,'estado',v.estado,'version',v.taxonomy_version) ORDER BY v.nombre,v.id)
          FROM taxonomy.characteristic_values v WHERE v.caracteristica_id=c.id AND v.estado::text IN ('ACTIVO','INACTIVO')),'[]'::jsonb) AS valores
        FROM taxonomy.characteristics c WHERE c.id=${id}::uuid AND c.estado::text IN ('ACTIVO', 'INACTIVO')`);
      return r.rows[0] ? dto(r.rows[0]) : undefined;
    });
  }

  async crear(input: {
    nombre: string;
    tipo: string;
    unidadMedida?: string | null;
  }): Promise<CaracteristicaAdmin | null> {
    return this.database.read(async (db) => {
      try {
        return await db.transaction(async (tx) => {
          const duplicada = await tx.execute(
            sql`SELECT 1 FROM taxonomy.characteristics WHERE nombre=${input.nombre.trim()}`,
          );
          if (duplicada.rows.length) return null;
          const r =
            await tx.execute(sql`INSERT INTO taxonomy.characteristics(nombre,tipo,unidad_medida)
        VALUES (${input.nombre.trim()},${input.tipo}::taxonomy.tipo_caracteristica,
          ${input.tipo === 'NUMERO' ? (input.unidadMedida?.trim() ?? null) : null})
        RETURNING id,nombre,tipo,unidad_medida,estado,taxonomy_version`);
          return r.rows[0] ? dto(r.rows[0]) : null;
        });
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === '23505'
        )
          return null;
        throw error;
      }
    });
  }

  async actualizar(
    id: string,
    input: {
      nombre?: string;
      unidadMedida?: string | null;
      tipo?: string;
      version: number;
    },
  ) {
    if (!esUuid(id)) return 'NO_ENCONTRADA' as const;
    return this.database.read(async (db) => {
      try {
        return await db.transaction(async (tx) => {
          const current = await tx.execute(
            sql`SELECT id,nombre,tipo,unidad_medida,estado,taxonomy_version FROM taxonomy.characteristics WHERE id=${id}::uuid FOR UPDATE`,
          );
          const row = current.rows[0];
          if (!row) return 'NO_ENCONTRADA' as const;
          if (String(row.taxonomy_version) !== String(input.version))
            return 'VERSION_CONFLICT' as const;
          if (input.tipo !== undefined && row.tipo !== input.tipo)
            return 'TIPO_CARACTERISTICA_INMUTABLE' as const;
          if (row.estado === 'PENDING_DEACTIVATION')
            return 'BAJA_EN_PROCESO' as const;
          const unit =
            row.tipo === 'NUMERO'
              ? input.unidadMedida === undefined
                ? row.unidad_medida
                : input.unidadMedida
              : null;
          if (
            row.tipo !== 'NUMERO' &&
            input.unidadMedida !== undefined &&
            input.unidadMedida !== null
          )
            return 'UNIDAD_INCOMPATIBLE' as const;
          if (
            row.tipo === 'NUMERO' &&
            !(typeof unit === 'string' && unit.trim())
          )
            return 'INVALIDA' as const;
          if (input.nombre !== undefined) {
            const duplicate = await tx.execute(
              sql`SELECT 1 FROM taxonomy.characteristics WHERE nombre=${input.nombre.trim()} AND id <> ${id}::uuid`,
            );
            if (duplicate.rows.length) return 'NOMBRE_DUPLICADO' as const;
          }
          await tx.execute(
            sql`UPDATE taxonomy.characteristics SET nombre=${input.nombre?.trim() ?? row.nombre}, unidad_medida=${unit}, taxonomy_version=taxonomy_version+1,updated_at=statement_timestamp() WHERE id=${id}::uuid`,
          );
          const updated = await tx.execute(
            sql`SELECT c.id,c.nombre,c.tipo,c.unidad_medida,c.estado,c.taxonomy_version,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('valorId',v.id,'nombre',v.nombre,'estado',v.estado,'version',v.taxonomy_version) ORDER BY v.nombre,v.id)
          FROM taxonomy.characteristic_values v WHERE v.caracteristica_id=c.id AND v.estado::text IN ('ACTIVO','INACTIVO')),'[]'::jsonb) AS valores
          FROM taxonomy.characteristics c WHERE c.id=${id}::uuid`,
          );
          return dto(updated.rows[0]!);
        });
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === '23505'
        )
          return 'NOMBRE_DUPLICADO' as const;
        throw error;
      }
    });
  }

  async cambiarEstado(
    id: string,
    estado: 'ACTIVO' | 'INACTIVO',
  ): Promise<CaracteristicaAdmin | 'BAJA_EN_PROCESO' | undefined> {
    if (!esUuid(id)) return undefined;
    return this.database.read(async (db) =>
      db.transaction(async (tx) => {
        const current = await tx.execute(
          sql`SELECT id,estado FROM taxonomy.characteristics WHERE id=${id}::uuid FOR UPDATE`,
        );
        if (!current.rows[0]) return undefined;
        if (current.rows[0].estado === 'PENDING_DEACTIVATION')
          return 'BAJA_EN_PROCESO' as const;
        if (current.rows[0].estado === estado) {
          const existing =
            await tx.execute(sql`SELECT c.id,c.nombre,c.tipo,c.unidad_medida,c.estado,c.taxonomy_version,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('valorId',v.id,'nombre',v.nombre,'estado',v.estado,'version',v.taxonomy_version) ORDER BY v.nombre,v.id) FROM taxonomy.characteristic_values v WHERE v.caracteristica_id=c.id AND v.estado::text IN ('ACTIVO','INACTIVO')),'[]'::jsonb) AS valores
          FROM taxonomy.characteristics c WHERE c.id=${id}::uuid`);
          return dto(existing.rows[0]!);
        }
        await tx.execute(sql`UPDATE taxonomy.characteristics SET estado=${estado}::taxonomy.estado_entidad,
        taxonomy_version=taxonomy_version+1,updated_at=statement_timestamp() WHERE id=${id}::uuid AND estado <> 'PENDING_DEACTIVATION'`);
        const next =
          await tx.execute(sql`SELECT c.id,c.nombre,c.tipo,c.unidad_medida,c.estado,c.taxonomy_version,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('valorId',v.id,'nombre',v.nombre,'estado',v.estado,'version',v.taxonomy_version) ORDER BY v.nombre,v.id) FROM taxonomy.characteristic_values v WHERE v.caracteristica_id=c.id AND v.estado::text IN ('ACTIVO','INACTIVO')),'[]'::jsonb) AS valores FROM taxonomy.characteristics c WHERE c.id=${id}::uuid`);
        return dto(next.rows[0]!);
      }),
    );
  }
}
