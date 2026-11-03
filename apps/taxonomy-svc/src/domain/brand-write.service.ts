import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../database.js';
import { esUuid } from '../errors/taxonomy.errors.js';
import type { MarcaReactivada } from './brand-reactivation.service.js';

export interface EntradaMarca {
  nombre?: string;
  descripcion?: string | null;
  paisOrigenIso?: string | null;
  logoUrl?: string | null;
  version?: number | null;
}
type MarcaEscrita = Omit<MarcaReactivada, 'estado'> & {
  estado: 'ACTIVO' | 'INACTIVO';
};
type ResultadoMarca =
  | {
      estado:
        'DUPLICADA' | 'NO_ENCONTRADA' | 'VERSION_CONFLICT' | 'NO_DISPONIBLE';
    }
  | { estado: 'OK'; marca: MarcaEscrita };
function mapear(row: Record<string, unknown>): MarcaEscrita {
  const created = new Date(String(row.created_at));
  const updated = new Date(String(row.updated_at));
  const version = Number(row.taxonomy_version);
  if (
    typeof row.id !== 'string' ||
    typeof row.nombre !== 'string' ||
    (row.estado !== 'ACTIVO' && row.estado !== 'INACTIVO') ||
    !Number.isSafeInteger(version) ||
    !Number.isFinite(created.getTime()) ||
    !Number.isFinite(updated.getTime())
  )
    throw new Error('Marca inválida');
  return {
    marcaId: row.id,
    nombre: row.nombre,
    descripcion: typeof row.descripcion === 'string' ? row.descripcion : null,
    logoUrl: typeof row.logo_url === 'string' ? row.logo_url : null,
    paisOrigenIso:
      typeof row.pais_origen_iso === 'string' ? row.pais_origen_iso : null,
    estado: row.estado,
    version,
    createdAt: created.toISOString(),
    updatedAt: updated.toISOString(),
  };
}
function duplicada(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  const constraint = Reflect.get(error, 'constraint');
  if (code === '23505' && constraint === 'uq_brands_nombre_normalizado')
    return true;
  const cause: unknown = Reflect.get(error, 'cause');
  return (
    cause !== error &&
    !!cause &&
    typeof cause === 'object' &&
    Reflect.get(cause, 'code') === '23505' &&
    Reflect.get(cause, 'constraint') === 'uq_brands_nombre_normalizado'
  );
}
@Injectable()
export class BrandWriteService {
  constructor(private readonly database: Database) {}
  async crear(data: EntradaMarca): Promise<ResultadoMarca> {
    return this.database.read(async (db) => {
      try {
        return await db.transaction(async (tx) => {
          const result = await tx.execute(
            sql`INSERT INTO taxonomy.brands (nombre, descripcion, pais_origen_iso, logo_url) VALUES (${data.nombre!}, ${data.descripcion ?? null}, ${data.paisOrigenIso ?? null}, ${data.logoUrl ?? null}) ON CONFLICT (nombre_normalizado) DO NOTHING RETURNING id, nombre, descripcion, pais_origen_iso, logo_url, estado, taxonomy_version, created_at, updated_at`,
          );
          if (!result.rows[0]) return { estado: 'DUPLICADA' } as const;
          return { estado: 'OK', marca: mapear(result.rows[0]) } as const;
        });
      } catch (error) {
        if (duplicada(error)) return { estado: 'DUPLICADA' };
        throw error;
      }
    });
  }
  async actualizar(id: string, data: EntradaMarca): Promise<ResultadoMarca> {
    if (!esUuid(id)) return { estado: 'NO_ENCONTRADA' };
    return this.database.read(async (db) => {
      try {
        return await db.transaction(async (tx) => {
          const existing = await tx.execute(
            sql`SELECT id, estado, taxonomy_version FROM taxonomy.brands WHERE id = ${id}::uuid FOR UPDATE`,
          );
          const row = existing.rows[0];
          if (!row) return { estado: 'NO_ENCONTRADA' } as const;
          if (row.estado === 'PENDING_DEACTIVATION')
            return { estado: 'NO_DISPONIBLE' } as const;
          if (
            data.version != null &&
            String(data.version) !== String(row.taxonomy_version)
          )
            return { estado: 'VERSION_CONFLICT' } as const;
          const result = await tx.execute(
            sql`UPDATE taxonomy.brands SET nombre = CASE WHEN ${data.nombre !== undefined} THEN ${data.nombre ?? null} ELSE nombre END, descripcion = CASE WHEN ${data.descripcion !== undefined} THEN ${data.descripcion ?? null} ELSE descripcion END, pais_origen_iso = CASE WHEN ${data.paisOrigenIso !== undefined} THEN ${data.paisOrigenIso ?? null} ELSE pais_origen_iso END, logo_url = CASE WHEN ${data.logoUrl !== undefined} THEN ${data.logoUrl ?? null} ELSE logo_url END, taxonomy_version = taxonomy_version + 1, updated_at = statement_timestamp() WHERE id = ${id}::uuid RETURNING id, nombre, descripcion, pais_origen_iso, logo_url, estado, taxonomy_version, created_at, updated_at`,
          );
          if (!result.rows[0]) throw new Error('Marca inválida');
          return { estado: 'OK', marca: mapear(result.rows[0]) } as const;
        });
      } catch (error) {
        if (duplicada(error)) return { estado: 'DUPLICADA' };
        throw error;
      }
    });
  }
}
