import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const path = process.argv[2];
const doc = JSON.parse(readFileSync(path, 'utf8'));
const yaml = Buffer.from(
  readFileSync(path.replace(/\.json$/, '.yaml'), 'utf8')
    .replaceAll('\r\n', '\n')
    .replace(/\n+$/, '\n'),
);
if (
  doc.info.version !== '0.6.0-rc.4' ||
  createHash('sha1')
    .update(`blob ${yaml.length}\0`)
    .update(yaml)
    .digest('hex') !== '52443be2510c6ca344b4cd18689c21d8245d5766'
)
  throw new Error('UNEXPECTED_H4_CONTRACT');
function resolve(value) {
  if (Array.isArray(value)) return value.map(resolve);
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    if (!value.$ref.startsWith('#/components/schemas/'))
      throw new Error('UNEXPECTED_REFERENCE');
    return resolve(doc.components.schemas[value.$ref.split('/').at(-1)]);
  }
  const keywords = new Set([
    'type',
    'properties',
    'required',
    'allOf',
    'oneOf',
    'if',
    'then',
    'enum',
    'const',
    'minLength',
    'maxLength',
    'minimum',
    'pattern',
    'format',
    'additionalProperties',
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => keywords.has(key))
      .map(([key, v]) => [
        key,
        key === 'properties'
          ? Object.fromEntries(
              Object.entries(v).map(([field, schema]) => [
                field,
                resolve(schema),
              ]),
            )
          : resolve(v),
      ]),
  );
}
const messages = Object.fromEntries(
  Object.values(doc.components.messages)
    .filter(
      (m) =>
        m['x-consumers']?.includes('promotions-svc') &&
        m['x-producer'] !== 'modulo-ventas',
    )
    .map((m) => [
      m.name,
      {
        producer: m['x-producer'],
        exchange: m['x-exchange'],
        routingKey: m['x-routing-key'],
        schema: resolve(m.payload),
      },
    ]),
);
if (Object.keys(messages).length !== 4)
  throw new Error('UNEXPECTED_ASSIGNED_EVENTS');
writeFileSync(
  new URL('../src/coupons/assigned-h4-contract.generated.ts', import.meta.url),
  '// Generated from Docs 5124eeae4ec65b22ea9146cd7b1ce3888c617c10, AsyncAPI rc.4.\n// SHA-256: ' +
    createHash('sha256').update(yaml).digest('hex') +
    '\n// JSON Schema uses a non-callable then keyword.\n/* oxlint-disable unicorn/no-thenable */\n' +
    "import type { MessageContract } from './schema-validator.js';\nexport const assignedH4Contracts: Readonly<Record<string,MessageContract & {producer:string}>> = " +
    JSON.stringify(messages, null, 2) +
    ';\n',
);
