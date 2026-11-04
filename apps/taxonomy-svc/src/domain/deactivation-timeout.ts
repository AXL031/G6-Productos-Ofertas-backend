import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Configuración del owner: ausencia o valor inválido detienen la operación. */
export async function leerTimeoutBaja(
  db: Pick<NodePgDatabase, 'execute'>,
): Promise<number> {
  const result =
    await db.execute(sql`SELECT valor_integer FROM taxonomy.runtime_settings
    WHERE clave = 'MASTER_DEACTIVATION_TIMEOUT_SECONDS'`);
  const value = result.rows[0]?.valor_integer;
  if (
    result.rows.length !== 1 ||
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error('Configuración de timeout de baja no disponible');
  }
  return value;
}
