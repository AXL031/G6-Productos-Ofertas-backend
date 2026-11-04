import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { CATALOG_SECURITY_CONFIG } from '../src/catalog-auth.js';
import { CATALOG_AMQP_SETTINGS } from '../src/catalog-amqp.js';
import { sanitize } from '../src/sanitized-logger.js';

/** Actual Gateway + Catalog HTTP boundary. No replaced guard, proxy or business
 * service. Deliberately does not claim React, PostgreSQL or successful CRUD. */
describe('Gateway demo to protected Catalog integration', () => {
  let catalog: INestApplication,
    gateway: ChildProcess,
    directory = '',
    base = '';
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'catalog-gateway-'));
    const output = join(directory, 'compiled');
    const compile = spawnSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '-p',
        resolve('apps/api-gateway/tsconfig.app.json'),
        '--outDir',
        output,
        '--composite',
        'false',
        '--declaration',
        'false',
        '--incremental',
        'false',
      ],
      { timeout: 60000, encoding: 'utf8', windowsHide: true },
    );
    if (compile.status !== 0)
      throw new Error('Gateway provider compilation failed: ' + compile.stdout);
    if (!existsSync(join(output, 'api-gateway.module.js')))
      throw new Error('Gateway provider compiler emitted no module');
    // Generated modules resolve dependencies from the repository, never a private env file.
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ type: 'module', imports: {} }),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CATALOG_SECURITY_CONFIG)
      .useValue(undefined)
      .overrideProvider(CATALOG_AMQP_SETTINGS)
      .useValue({})
      .compile();
    catalog = module.createNestApplication({ logger: false });
    await catalog.listen(0, '127.0.0.1');
    const core = pathToFileURL(
      resolve('node_modules/@nestjs/core/index.js'),
    ).href;
    const moduleUrl = pathToFileURL(join(output, 'api-gateway.module.js')).href;
    const code = `import {NestFactory} from ${JSON.stringify(core)}; import {ApiGatewayModule} from ${JSON.stringify(moduleUrl)}; const app=await NestFactory.create(ApiGatewayModule,{bodyParser:false,logger:false});app.enableShutdownHooks();await app.listen(0,'127.0.0.1');console.log(await app.getUrl());`;
    // Standard Node resolution for generated Gateway files under OS temp.
    const { symlinkSync } = await import('node:fs');
    symlinkSync(
      resolve('node_modules'),
      join(directory, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    gateway = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: directory,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        NODE_ENV: 'test',
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        GATEWAY_CATALOG_SVC_URL: await catalog.getUrl(),
      },
    });
    let stdout = '';
    gateway.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    let stderr = '';
    gateway.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const deadline = Date.now() + 15000;
    while (!stdout.includes('http://')) {
      if (Date.now() > deadline || gateway.exitCode !== null)
        throw new Error(
          'Isolated Gateway did not start: ' +
            stderr
              .split(/\r?\n/)
              .map((line) => String(sanitize(line)))
              .join('\n'),
        );
      await pause(50);
    }
    base = stdout
      .trim()
      .split(/\r?\n/)
      .find((line) => line.startsWith('http://'))!;
  }, 90000);
  afterAll(async () => {
    if (gateway && gateway.exitCode === null) {
      gateway.kill('SIGTERM');
      const deadline = Date.now() + 5000;
      while (
        gateway.exitCode === null &&
        gateway.signalCode === null &&
        Date.now() < deadline
      )
        await pause(50);
      if (gateway.exitCode === null && gateway.signalCode === null)
        gateway.kill('SIGKILL');
    }
    await catalog?.close();
    if (directory) {
      const child = relative(tmpdir(), directory);
      if (!child || child.startsWith('..') || isAbsolute(child))
        throw new Error('Unsafe test cleanup');
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([undefined, 'Bearer incoming-token-is-ignored'])(
    'preserves the protected upstream 401 when demo strips Authorization (%s)',
    async (authorization) => {
      const correlation = randomUUID();
      const response = await fetch(
        base + '/api/v1/productos?canal=MARKETPLACE&pagina=0',
        {
          headers: {
            'x-correlation-id': correlation,
            ...(authorization ? { authorization } : {}),
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('x-correlation-id')).toBe(correlation);
      expect(await response.json()).toMatchObject({
        code: 'TOKEN_INVALIDO',
        correlationId: correlation,
      });
    },
  );
  it('preserves unknown-route 404 without inventing a Catalog demo bypass', async () => {
    expect(
      (
        await fetch(base + '/api/v1/no-contract', {
          signal: AbortSignal.timeout(5000),
        })
      ).status,
    ).toBe(404);
  });
});
