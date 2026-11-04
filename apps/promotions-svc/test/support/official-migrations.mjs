// Fetch immutable normative SQL for disposable test databases only. Never DDL in app bootstrap.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const docsRevision = '51a5ce6e76bb0c61d93ef47416e46797bf5b9846';
const migrations = [
  [
    '0001_promotions_persistence',
    'ccb75886b2ff993717b46cb923e7983ab4af9038cb1db0af394f997962dac796',
  ],
  [
    '0002_promotions_global_price_projection',
    'ee6c36562c81b6a65682845b01d71c2e10763374c904ea5cb88c9b069f2a5f42',
  ],
  [
    '0003_promotions_timestamps_and_delete_rules',
    '2e3eaf61ffc96b02d6e6bd25c76dcaded3b9a0c6698e306914811c6c912b0eaa',
  ],
  [
    '0004_coupon_idempotency_receipts',
    '84a628ee569abbe62524e8874505f3440ce299487d4cba8d1b88647b8743e061',
  ],
];
export async function officialMigrations() {
  const directory = resolve('node_modules/.cache/promotions-work');
  await mkdir(directory, { recursive: true });
  const files = [];
  for (const [name, checksum] of migrations) {
    const path = resolve(directory, `datos_promotions_migrations_${name}.sql`);
    let content;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      const response = await fetch(
        `https://raw.githubusercontent.com/Taller-SW-Web/G6-Productos-Ofertas-docs/${docsRevision}/datos/promotions/migrations/${name}.sql`,
        { signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok) throw new Error('BLOCKED_CONTRACT');
      content = await response.text();
    }
    content = content.replace(/\r\n/g, '\n');
    if (createHash('sha256').update(content).digest('hex') !== checksum)
      throw new Error('BLOCKED_CONTRACT_CHECKSUM_MISMATCH');
    await writeFile(path, content);
    files.push(content);
  }
  return files;
}
