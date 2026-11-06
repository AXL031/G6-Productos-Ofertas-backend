import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { parseBulkEnvironment } from '../../../dist/apps/bulk-svc/config/bulk-environment.js';
import { bulkSchema } from '../../../dist/apps/bulk-svc/persistence/bulk.schema.js';
import { BulkPersistenceRepository } from '../../../dist/apps/bulk-svc/persistence/bulk.repository.js';

function required(value, name) {
  const result = value?.trim();
  if (!result) throw new Error(`Falta el parámetro obligatorio ${name}.`);
  return result;
}

async function main() {
  const [
    messageId,
    operatorIdentity,
    approvalReference,
    reason,
    bindingEvidence,
    consumerEvidence,
  ] = process.argv.slice(2);
  const environment = parseBulkEnvironment(process.env);
  if (!environment.databaseUrl)
    throw new Error(
      'DATABASE_URL debe apuntar al PostgreSQL autorizado de Bulk.',
    );
  const pool = new Pool({
    connectionString: environment.databaseUrl,
    ssl: environment.databaseSsl,
    max: 1,
    connectionTimeoutMillis: environment.databaseConnectionTimeoutMs,
    query_timeout: environment.databaseQueryTimeoutMs,
    statement_timeout: environment.databaseQueryTimeoutMs,
    idleTimeoutMillis: environment.databaseIdleTimeoutMs,
  });
  try {
    const repository = new BulkPersistenceRepository(
      drizzle(pool, { schema: bulkSchema, logger: false }),
    );
    const result = await repository.reactivateParkedCatalogOutbox({
      messageId: required(messageId, 'message_id'),
      operatorIdentity: required(operatorIdentity, 'identidad_operador'),
      approvalReference: required(approvalReference, 'referencia_aprobacion'),
      reason: required(reason, 'motivo'),
      bindingEvidence: required(bindingEvidence, 'evidencia_binding'),
      consumerEvidence: required(consumerEvidence, 'evidencia_consumidor'),
    });
    process.stdout.write(`${result}\n`);
    if (result !== 'REACTIVATED') process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Falló la recuperación.'}\n`,
  );
  process.exitCode = 1;
});
