// Development-only: parsed immutable Docs OpenAPI rc.2 and paired source YAML.
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
  doc.info.version !== '0.6.0-rc.2' ||
  createHash('sha1')
    .update(`blob ${yaml.length}\0`)
    .update(yaml)
    .digest('hex') !== '54164d48c7919854ac4636a27162ab880cb202aa'
)
  throw new Error('UNEXPECTED_UPSTREAM_CONTRACT');
function resolve(value) {
  if (Array.isArray(value)) return value.map(resolve);
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    if (!value.$ref.startsWith('#/components/schemas/'))
      throw new Error('UNEXPECTED_REFERENCE');
    return resolve(doc.components.schemas[value.$ref.split('/').at(-1)]);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['description', 'example', 'examples'].includes(key))
      .map(([key, value]) => [key, resolve(value)]),
  );
}
const schemas = Object.fromEntries(
  ['ProductoDetalleComercial', 'PricingCatalogContext', 'CategoriaAdmin'].map(
    (name) => [name, resolve(doc.components.schemas[name])],
  ),
);
writeFileSync(
  new URL(
    '../src/infrastructure/http/upstream-contract.generated.ts',
    import.meta.url,
  ),
  '// Generated from Docs 5124eeae4ec65b22ea9146cd7b1ce3888c617c10, OpenAPI rc.2.\n' +
    '// Source SHA-256: ' +
    createHash('sha256').update(yaml).digest('hex') +
    '\n' +
    "import type { HttpSchema } from '../../http/http-validation.js';\nexport const upstreamSchemas: Readonly<Record<string,HttpSchema>> = " +
    JSON.stringify(schemas, null, 2) +
    ';\n',
);
