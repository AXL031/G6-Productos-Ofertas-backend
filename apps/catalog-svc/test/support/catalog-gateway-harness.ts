import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { catalogCorrelation } from '../../src/bootstrap.js';
import { AppModule } from '../../src/app.module.js';
import { CATALOG_SECURITY_CONFIG } from '../../src/catalog-auth.js';
import { CATALOG_AMQP_SETTINGS } from '../../src/catalog-amqp.js';
import { CATALOG_TAXONOMY_CONFIG } from '../../src/taxonomy-config.js';
import { Database, type PostgresSettings } from '../../src/database.js';
import { CatalogPersistenceError } from '../../src/database-errors.js';
import {
  CATALOG_READ_DEMO,
  CATALOG_MARKETPLACE_PREVIEW,
} from '../../src/catalog-read-demo.js';
import { CATALOG_PREPARATION_CONFIG } from '../../src/catalog-messages.js';

/** Real Gateway in a separate process and real Catalog guards/use cases.
 * G7/JWKS and Taxonomy are explicit HTTP fixtures. Database is either the
 * supplied disposable PostgreSQL or an explicit unavailable port fixture.
 * No shared env files, credentials, broker or database are contacted. */
export class CatalogGatewayHarness {
  private directory = '';
  private gateway?: ChildProcess;
  private catalog?: INestApplication;
  private upstream?: Server;
  private origin = '';
  private base = '';
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly correlation = randomUUID();
  taxonomyAvailable = true;

  token(claims: Record<string, unknown> = {}, wrongSignature = false): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'issue-50-fixture' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: this.origin,
        sub: '00000000-0000-4000-8000-000000000050',
        tipo: 'acceso',
        roles: ['GESTOR_COMERCIAL'],
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        ...claims,
      }),
    ).toString('base64url');
    const key = wrongSignature
      ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      : this.keys.privateKey;
    return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url')}`;
  }

  async start(
    database?: PostgresSettings,
    preparation: { timeoutMs?: number } = {},
    restrictedDemo = false,
  ): Promise<void> {
    try {
      this.upstream = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'max-age=60');
        let body: unknown;
        if (req.url === '/discovery')
          body = { issuer: this.origin, jwks_uri: this.origin + '/jwks' };
        else if (req.url === '/jwks')
          body = {
            keys: [
              {
                ...this.keys.publicKey.export({ format: 'jwk' }),
                kid: 'issue-50-fixture',
                alg: 'RS256',
                use: 'sig',
              },
            ],
          };
        else if (!this.taxonomyAvailable) {
          res.statusCode = 503;
          body = {};
        } else if (
          (restrictedDemo
            ? req.headers.authorization !== undefined
            : !req.headers.authorization?.startsWith('Bearer ')) ||
          req.headers['x-correlation-id'] !== this.correlation
        ) {
          res.statusCode = 401;
          body = {};
        } else if (req.url === '/api/v1/categorias/category-fixture')
          body = {
            categoriaId: 'category-fixture',
            nombre: 'Category fixture',
            estado: 'ACTIVO',
            version: 1,
          };
        else if (req.url === '/api/v1/marcas/brand-fixture')
          body = {
            marcaId: 'brand-fixture',
            nombre: 'Brand fixture',
            estado: 'ACTIVO',
            version: 1,
          };
        else if (req.url === '/api/v1/tipos-producto/type-fixture')
          body = {
            tipoProductoId: 'type-fixture',
            nombre: 'Type fixture',
            estado: 'ACTIVO',
            schemaVersion: 1,
          };
        else if (
          req.url === '/api/v1/tipos-producto/type-fixture/caracteristicas'
        )
          body = {
            tipoProducto: { tipoProductoId: 'type-fixture', estado: 'ACTIVO' },
            schemaVersion: 1,
            caracteristicas: [
              {
                caracteristicaId: 'size',
                obligatoria: false,
                estado: 'ACTIVO',
                schemaVersion: 1,
                caracteristica: {
                  caracteristicaId: 'size',
                  nombre: 'Size',
                  estado: 'ACTIVO',
                  version: 1,
                  tipo: 'TEXTO',
                },
              },
            ],
          };
        else {
          res.statusCode = 404;
          body = {};
        }
        res.end(JSON.stringify(body));
      });
      this.upstream.listen(0, '127.0.0.1');
      await once(this.upstream, 'listening');
      const address = this.upstream.address();
      if (!address || typeof address === 'string')
        throw new Error('Fixture did not bind loopback');
      this.origin = 'http://127.0.0.1:' + address.port;
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CATALOG_SECURITY_CONFIG)
        .useValue({
          issuer: this.origin,
          discoveryUrl: this.origin + '/discovery',
          jwksUrl: this.origin + '/jwks',
        })
        .overrideProvider(CATALOG_TAXONOMY_CONFIG)
        .useValue({ origin: this.origin })
        .overrideProvider(Database)
        .useValue(
          database
            ? new Database(database)
            : {
                read: async () => {
                  throw new CatalogPersistenceError('connection');
                },
                transaction: async () => {
                  throw new CatalogPersistenceError('connection');
                },
              },
        )
        .overrideProvider(CATALOG_AMQP_SETTINGS)
        .useValue({})
        .overrideProvider(CATALOG_READ_DEMO)
        .useValue({
          enabled: false,
          restricted: restrictedDemo,
          gatewayIps: ['127.0.0.1'],
        })
        .overrideProvider(CATALOG_MARKETPLACE_PREVIEW)
        .useValue(false)
        .overrideProvider(CATALOG_PREPARATION_CONFIG)
        .useValue(preparation)
        .compile();
      this.catalog = module.createNestApplication({ logger: false });
      this.catalog.use(catalogCorrelation);
      await this.catalog.listen(0, '127.0.0.1');
      if (restrictedDemo) return; // Direct private HTTP: does not claim Gateway demo integration.
      this.directory = mkdtempSync(join(tmpdir(), 'catalog-auth-gateway-'));
      const output = join(this.directory, 'compiled');
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
        { encoding: 'utf8', timeout: 60000, windowsHide: true },
      );
      if (compile.status !== 0)
        throw new Error('Gateway compilation failed: ' + compile.stdout);
      symlinkSync(
        resolve('node_modules'),
        join(this.directory, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const url = (path: string) => JSON.stringify(pathToFileURL(path).href);
      // Test configuration injection permits ephemeral loopback JWKS. Production
      // settings validation is unchanged; identity verifier/proxy are not replaced.
      const settings = {
        upstreams: { 'catalog-svc': await this.catalog.getUrl() },
        issuer: this.origin,
        jwksUrl: this.origin + '/jwks',
        timeoutMs: 5000,
        maxBytes: 1024 * 1024,
        publicOperations: [],
        demoNoAuthEnabled: false,
      };
      const code = `import {Test} from ${url(resolve('node_modules/@nestjs/testing/index.js'))};
        import {ApiGatewayModule} from ${url(join(output, 'api-gateway.module.js'))};
        import {GATEWAY_SETTINGS} from ${url(join(output, 'routing/gateway-settings.js'))};
        const module=await Test.createTestingModule({imports:[ApiGatewayModule]}).overrideProvider(GATEWAY_SETTINGS).useValue(${JSON.stringify(settings)}).compile();
        const app=module.createNestApplication({bodyParser:false,logger:false});
        app.enableShutdownHooks();await app.listen(0,'127.0.0.1');console.log(await app.getUrl());`;
      this.gateway = spawn(
        process.execPath,
        ['--input-type=module', '-e', code],
        {
          cwd: this.directory,
          windowsHide: true,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            NODE_ENV: 'test',
          },
        },
      );
      let stdout = '';
      this.gateway.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      // Discard process diagnostics rather than printing any request/token.
      this.gateway.stderr?.resume();
      const deadline = Date.now() + 15000;
      while (!stdout.includes('http://')) {
        if (this.gateway.exitCode !== null || Date.now() > deadline)
          throw new Error('Isolated authenticated Gateway failed to start');
        await pause(50);
      }
      this.base = stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith('http://'))!;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    token: string | null = this.token(),
    direct = false,
  ) {
    const response = await fetch(
      (direct ? await this.catalog!.getUrl() : this.base) + '/api/v1' + path,
      {
        method,
        headers: {
          'X-Correlation-Id': this.correlation,
          ...(token === null ? {} : { authorization: 'Bearer ' + token }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    );
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      correlation: response.headers.get('x-correlation-id'),
      body: await response.json(),
    };
  }

  async close(): Promise<void> {
    if (
      this.gateway &&
      this.gateway.exitCode === null &&
      this.gateway.signalCode === null
    ) {
      this.gateway.kill('SIGTERM');
      const deadline = Date.now() + 5000;
      while (
        this.gateway.exitCode === null &&
        this.gateway.signalCode === null &&
        Date.now() < deadline
      )
        await pause(25);
      if (this.gateway.exitCode === null && this.gateway.signalCode === null) {
        const exited = once(this.gateway, 'exit');
        this.gateway.kill('SIGKILL');
        await Promise.race([exited, pause(1000)]);
      }
    }
    await this.catalog?.close();
    if (this.upstream) {
      this.upstream.closeAllConnections();
      await new Promise<void>((done) => this.upstream!.close(() => done()));
    }
    if (this.directory) {
      const within = relative(tmpdir(), this.directory);
      if (!within || within.startsWith('..') || isAbsolute(within))
        throw new Error('Invalid isolated Gateway cleanup path');
      rmSync(this.directory, { recursive: true, force: true });
      this.directory = '';
    }
  }
}
