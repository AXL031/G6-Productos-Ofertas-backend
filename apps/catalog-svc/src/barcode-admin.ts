import { pathToFileURL } from 'node:url';
import { Database } from './database.js';
import {
  CatalogTokenVerifier,
  readCatalogSecurityConfig,
} from './catalog-auth.js';
import {
  BarcodeRepository,
  BarcodeAdministrationError,
} from './barcode.repository.js';
import { BarcodeService, type BarcodeCommand } from './barcode.service.js';

/** Internal command, JSON via stdin. Bearer is never placed in argv or logs. */
async function main() {
  const database = new Database();
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error();
    const data = input as Record<string, unknown>;
    if (
      Object.keys(data).some(
        (key) =>
          !['operation', 'sku', 'codigo_barras', 'authorization'].includes(key),
      ) ||
      typeof data.authorization !== 'string'
    )
      throw new Error();
    // Validate JWT before opening the DB connection; role/schema verified before mutation.
    const verifier = new CatalogTokenVerifier(
      readCatalogSecurityConfig(process.env),
    );
    const service = new BarcodeService(
      new BarcodeRepository(database),
      verifier,
    );
    const token = /^Bearer ([^\s]+)$/i.exec(data.authorization);
    if (!token) throw new Error();
    const actor = await verifier.verify(token[1]);
    if (actor.kind !== 'user' || !actor.roles.includes('GESTOR_COMERCIAL'))
      throw new Error();
    await database.verifyIdentity();
    const result = await service.administer(
      data as unknown as BarcodeCommand,
      data.authorization,
    );
    process.stdout.write(JSON.stringify({ status: 'ok', result }) + '\n');
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        status: 'failed',
        code:
          error instanceof BarcodeAdministrationError
            ? error.code
            : 'BARCODE_ADMIN_FAILED',
      }) + '\n',
    );
    process.exitCode = 1;
  } finally {
    await database.onModuleDestroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();
