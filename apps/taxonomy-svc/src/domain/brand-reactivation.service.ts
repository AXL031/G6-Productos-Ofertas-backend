import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';

export type ResultadoReactivacionMarca =
  | { estado: 'NO_ENCONTRADA' }
  | { estado: 'BAJA_EN_PROCESO' }
  | { estado: 'ACTIVA'; marca: MarcaReactivada };

export interface MarcaReactivada {
  marcaId: string;
  nombre: string;
  descripcion: string | null;
  logoUrl: string | null;
  paisOrigenIso: string | null;
  estado: 'ACTIVO';
  version: number;
  createdAt: string;
  updatedAt: string;
}

function fechaIso(valor: unknown): string | undefined {
  if (!(valor instanceof Date) && typeof valor !== 'string') return undefined;
  const fecha = new Date(valor);
  return Number.isFinite(fecha.getTime()) ? fecha.toISOString() : undefined;
}

/** Reactiva una marca sin alterar una baja maestra en curso. */
@Injectable()
export class BrandReactivationService {
  constructor(private readonly database: Database) {}

  async reactivar(marcaId: string): Promise<ResultadoReactivacionMarca> {
    if (!esUuid(marcaId)) return { estado: 'NO_ENCONTRADA' };
    return this.database.read((db) =>
      db.transaction(async (tx) => {
        const current = await tx.execute(
          sql`SELECT id, estado FROM taxonomy.brands WHERE id = ${marcaId}::uuid FOR UPDATE`,
        );
        if (!current.rows[0]) return { estado: 'NO_ENCONTRADA' } as const;
        const active = await tx.execute(
          sql`SELECT 1 FROM taxonomy.master_deactivation_operations WHERE entity_type = 'BRAND' AND entity_id = ${marcaId}::uuid AND status IN ('REQUESTED', 'IN_PROGRESS') LIMIT 1`,
        );
        if (
          current.rows[0].estado === 'PENDING_DEACTIVATION' ||
          active.rows.length
        )
          return { estado: 'BAJA_EN_PROCESO' } as const;
        const result = await tx.execute(
          sql`UPDATE taxonomy.brands SET estado = 'ACTIVO', taxonomy_version = taxonomy_version + CASE WHEN estado = 'INACTIVO' THEN 1 ELSE 0 END, updated_at = CASE WHEN estado = 'INACTIVO' THEN statement_timestamp() ELSE updated_at END WHERE id = ${marcaId}::uuid AND estado IN ('ACTIVO', 'INACTIVO') RETURNING id, nombre, descripcion, logo_url, pais_origen_iso, estado, taxonomy_version, created_at, updated_at`,
        );
        const row = result.rows[0];
        const createdAt = fechaIso(row?.created_at);
        const updatedAt = fechaIso(row?.updated_at);
        if (
          !row ||
          typeof row.id !== 'string' ||
          typeof row.nombre !== 'string' ||
          row.estado !== 'ACTIVO' ||
          !Number.isSafeInteger(Number(row.taxonomy_version)) ||
          !createdAt ||
          !updatedAt
        )
          throw new Error('Estado de marca inválido');
        return {
          estado: 'ACTIVA',
          marca: {
            marcaId: row.id,
            nombre: row.nombre,
            descripcion:
              typeof row.descripcion === 'string' ? row.descripcion : null,
            logoUrl: typeof row.logo_url === 'string' ? row.logo_url : null,
            paisOrigenIso:
              typeof row.pais_origen_iso === 'string'
                ? row.pais_origen_iso
                : null,
            estado: 'ACTIVO',
            version: Number(row.taxonomy_version),
            createdAt,
            updatedAt,
          },
        } as const;
      }),
    );
  }
}
