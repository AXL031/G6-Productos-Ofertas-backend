// Artefacto aislado para pruebas HTTP: no cambia checkout, ramas ni código del Gateway.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const sha = '32153bffb35daa8761272c7b55fe23dc1df70007'; // PR #130, head conservado en #107.
const prefix = 'apps/api-gateway/src/';
const git = (...args) =>
  execFileSync(
    'git',
    ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    },
  );
const files = git('ls-tree', '-r', '--name-only', sha, prefix)
  .trim()
  .split('\n')
  .filter(
    (path) =>
      path.startsWith(prefix) &&
      path.endsWith('.ts') &&
      !path.endsWith('.spec.ts'),
  );
if (!files.length)
  throw new Error(
    'Falta el commit de Gateway. Descargar el SHA indicado mediante git fetch antes de preparar.',
  );
mkdirSync(join(root, 'dist'), { recursive: true });
const artifact = mkdtempSync(join(root, 'dist', 'inventory-gateway-demo-'));
writeFileSync(
  join(artifact, 'package.json'),
  JSON.stringify({ type: 'module', private: true }),
);
writeFileSync(
  join(artifact, 'source.json'),
  JSON.stringify({ sha, purpose: 'inventory-commercial-demo-http' }),
);
for (const path of files) {
  const source = git('show', `${sha}:${path}`);
  const output = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
    },
  }).outputText;
  const target = join(
    artifact,
    path.slice(prefix.length).replace(/\.ts$/, '.js'),
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output);
}
// Bootstrap de prueba: mismo módulo/proxy/identity, puerto efímero ligado solo a loopback.
writeFileSync(
  join(artifact, 'gateway.entry.mjs'),
  `
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiGatewayModule } from './api-gateway.module.js';
const app = await NestFactory.create(ApiGatewayModule, { bodyParser: false, logger: false, abortOnError: false });
await app.listen(0, '127.0.0.1');
process.on('message', async (message) => {
  if (message === 'stop') { await app.close(); process.disconnect(); }
});
process.send({ port: app.getHttpServer().address().port });
`,
);
process.stdout.write(artifact + '\n');
