// Allowlist-only packaging for an isolated ACI test. Never walks the worktree or reads .env.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';

// URL decoding is necessary for Windows workspace paths with spaces.
const { fileURLToPath } = await import('node:url');
const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const output = process.argv[2];
if (!output) throw new Error('OUTPUT_DIRECTORY_REQUIRED');
const files = new Map();
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function add(path, imports = false) {
  if (files.has(path)) return;
  if (path.includes('..') || path.includes('\\') || path.startsWith('/'))
    throw new Error('INVALID_BUNDLE_PATH');
  const content = await readFile(resolve(workspace, path), 'utf8');
  files.set(path, content);
  if (imports) {
    const source = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const specifiers = [];
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifiers.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        throw new Error('DYNAMIC_IMPORT_REQUIRES_EXPLICIT_REVIEW');
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of specifiers.filter((item) => item.startsWith('.'))) {
      const dependency = relative(
        workspace,
        resolve(workspace, dirname(path), specifier),
      )
        .split(sep)
        .join('/');
      if (
        !dependency.startsWith('dist/apps/pricing-svc/') &&
        !dependency.startsWith('dist/apps/price-audit-svc/')
      )
        throw new Error('UNEXPECTED_COMPILED_DEPENDENCY');
      if (!dependency.endsWith('.js'))
        throw new Error('ONLY_COMPILED_JAVASCRIPT_ALLOWED');
      await add(dependency, true);
    }
  }
}
await add('package.json');
await add('package-lock.json');
await add('ops/azure/service-bus/cloud-runner.mjs', true);
for (const path of [
  'apps/pricing-svc/test/fixtures/pricing.sql',
  'apps/price-audit-svc/test/fixtures/price-audit.sql',
  'apps/pricing-svc/migrations/0002_schedule_effective_events.sql',
  'apps/pricing-svc/migrations/0003_initialization_operation_index.sql',
  'apps/pricing-svc/migrations-candidate/h5/0001_outbox_delivery.sql',
  'apps/price-audit-svc/migrations/0002_typed_price_change.sql',
])
  await add(path);
const manifest = [...files].map(([path, content]) => ({
  path,
  sha256: hash(content),
}));
const compressed = gzipSync(JSON.stringify([...files]), { level: 9 });
const base64 = compressed.toString('base64');
if (base64.length > 750000) throw new Error('BUNDLE_TOO_LARGE');
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, 'bundle.json'),
  JSON.stringify({
    sha256: hash(compressed),
    chunks: base64.match(/.{1,30000}/g),
  }),
);
await writeFile(
  resolve(output, 'bundle-manifest.json'),
  `${JSON.stringify({ compressedSha256: hash(compressed), compressedBytes: compressed.length, files: manifest }, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ files: files.size, compressedBytes: compressed.length, chunks: Math.ceil(base64.length / 30000), sha256: hash(compressed) })}\n`,
);
