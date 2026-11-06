import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { TipoMaestro } from '../domain/deactivation-check.js';

type Executor = Pick<NodePgDatabase, 'execute'>;
export type FuenteBaja = {
  id: string;
  estado: string;
  version: number;
  tipoProductoId?: string;
  caracteristicaId?: string;
};

/** Lee y bloquea la fuente autoritativa durante la transacción del caso de uso. */
export async function bloquearFuenteBaja(
  tx: Executor,
  tipo: TipoMaestro,
  id: string,
): Promise<FuenteBaja | undefined> {
  const tabla = {
    CATEGORY: sql`taxonomy.categories`,
    BRAND: sql`taxonomy.brands`,
    PRODUCT_TYPE: sql`taxonomy.product_types`,
    CHARACTERISTIC_VALUE: sql`taxonomy.characteristic_values`,
    PRODUCT_TYPE_CHARACTERISTIC: sql`taxonomy.product_type_characteristics`,
  }[tipo];
  const consulta =
    tipo === 'PRODUCT_TYPE_CHARACTERISTIC'
      ? await tx.execute(sql`SELECT a.id, a.estado, t.schema_version AS version,
          a.tipo_producto_id, a.caracteristica_id
        FROM taxonomy.product_type_characteristics a
        JOIN taxonomy.product_types t ON t.id = a.tipo_producto_id
        WHERE a.id = ${id}::uuid FOR UPDATE OF a, t`)
      : await tx.execute(sql`SELECT id, estado, taxonomy_version AS version
        FROM ${tabla} WHERE id = ${id}::uuid FOR UPDATE`);
  const fila = consulta.rows[0];
  if (!fila) return undefined;
  const version = Number(fila.version);
  if (
    typeof fila.id !== 'string' ||
    typeof fila.estado !== 'string' ||
    fila.version == null ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    (tipo === 'PRODUCT_TYPE_CHARACTERISTIC' &&
      (typeof fila.tipo_producto_id !== 'string' ||
        typeof fila.caracteristica_id !== 'string'))
  )
    throw new Error('FUENTE_BAJA_INVALIDA');
  return {
    id: fila.id,
    estado: fila.estado,
    version,
    ...(tipo === 'PRODUCT_TYPE_CHARACTERISTIC'
      ? {
          tipoProductoId: fila.tipo_producto_id as string,
          caracteristicaId: fila.caracteristica_id as string,
        }
      : {}),
  };
}

/** Compara y cambia la entidad bajo lock; la transacción llamadora decide el evento terminal. */
export async function transicionarFuenteBaja(
  tx: Executor,
  tipo: TipoMaestro,
  id: string,
  version: number,
  desde: 'ACTIVO' | 'PENDING_DEACTIVATION',
  hacia: 'PENDING_DEACTIVATION' | 'ACTIVO' | 'INACTIVO',
): Promise<boolean> {
  const permitida =
    (desde === 'ACTIVO' && hacia === 'PENDING_DEACTIVATION') ||
    (desde === 'PENDING_DEACTIVATION' &&
      (hacia === 'ACTIVO' || hacia === 'INACTIVO'));
  if (!permitida || !Number.isSafeInteger(version) || version < 0) return false;
  const fuente = await bloquearFuenteBaja(tx, tipo, id);
  if (!fuente || fuente.estado !== desde || fuente.version !== version)
    return false;
  const tabla = {
    CATEGORY: sql`taxonomy.categories`,
    BRAND: sql`taxonomy.brands`,
    PRODUCT_TYPE: sql`taxonomy.product_types`,
    CHARACTERISTIC_VALUE: sql`taxonomy.characteristic_values`,
    PRODUCT_TYPE_CHARACTERISTIC: sql`taxonomy.product_type_characteristics`,
  }[tipo];
  const cambio =
    tipo !== 'PRODUCT_TYPE_CHARACTERISTIC' && hacia === 'INACTIVO'
      ? sql`estado = ${hacia}::taxonomy.estado_entidad, taxonomy_version = taxonomy_version + 1`
      : sql`estado = ${hacia}::taxonomy.estado_entidad`;
  const actualizada = await tx.execute(sql`UPDATE ${tabla} SET ${cambio}
    WHERE id = ${id}::uuid AND estado = ${desde}::taxonomy.estado_entidad RETURNING id`);
  if (actualizada.rows.length !== 1) return false;
  if (tipo === 'PRODUCT_TYPE_CHARACTERISTIC') {
    const despues = await bloquearFuenteBaja(tx, tipo, id);
    const esperado = hacia === 'INACTIVO' ? version + 1 : version;
    if (!despues || despues.version !== esperado)
      throw new Error('VERSION_ASOCIACION_INCONSISTENTE');
  }
  return true;
}
