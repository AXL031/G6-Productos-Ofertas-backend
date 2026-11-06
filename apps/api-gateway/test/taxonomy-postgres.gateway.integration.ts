import { once } from 'node:events';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:https';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { iniciarTaxonomySvc } from '../../taxonomy-svc/src/bootstrap.js';
import type { AplicacionCreada } from '../../taxonomy-svc/src/bootstrap.js';
import { AcreditacionInstanciaEfimera } from '../../taxonomy-svc/test/postgres-isolation.js';
import {
  construirSentenciasDdl,
  PASSWORD_APP,
  ROL_APP,
} from '../../taxonomy-svc/test/ddl-taxonomy-prueba.js';

const SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DATABASE_URL = process.env.TAXONOMY_TEST_DATABASE_URL;
const CA_FILE = process.env.TAXONOMY_TEST_PG_CA;
const SERVER_CERT_FILE = process.env.TAXONOMY_TEST_PG_CERT;
const SERVER_KEY_FILE = process.env.TAXONOMY_TEST_PG_KEY;
const EXPECTED = [
  'TAXONOMY_TEST_DB_ACK',
  'TAXONOMY_TEST_HARNESS_ID',
  'TAXONOMY_TEST_DATABASE_URL',
  'TAXONOMY_TEST_PG_CA',
  'TAXONOMY_TEST_PG_CERT',
  'TAXONOMY_TEST_PG_KEY',
];

function exigirEntorno(): void {
  if (EXPECTED.some((key) => !process.env[key])) {
    throw new Error('Ejecutar mediante run-taxonomy-postgres-gateway.mjs.');
  }
}

async function puertoDisponible(): Promise<number> {
  const server = createHttpsServer(
    {
      cert: readFileSync(SERVER_CERT_FILE!),
      key: readFileSync(SERVER_KEY_FILE!),
    },
    (_request, response) => response.end(),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((done) => server.close(() => done()));
    throw new Error('No se pudo reservar un puerto loopback.');
  }
  const port = address.port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function createToken(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  claims: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(
    JSON.stringify({ alg: 'RS256', kid: 'g6-h4-local-e2e', typ: 'JWT' }),
  );
  const payload = base64url(
    JSON.stringify({
      iss: issuerUrl,
      sub: SUB,
      tipo: 'acceso',
      roles: ['GESTOR_COMERCIAL'],
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      ...claims,
    }),
  );
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

let issuerUrl = '';
let jwksUrl = '';
let taxonomyOrigin = '';

function status(response: Response, expected: number): void {
  expect(response.status).toBe(expected);
}

function diagnosticHeader(headers: string, name: string): string | undefined {
  const values = headers.split(',');
  for (let index = 0; index + 1 < values.length; index += 2) {
    if (values[index]?.trim().toLowerCase() === name.toLowerCase()) {
      return values[index + 1]?.trim();
    }
  }
  return undefined;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function getPort(app: INestApplication): number {
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') {
    throw new Error('La aplicación no tiene un puerto TCP.');
  }
  return address.port;
}

function quietLogger(): LoggerService {
  return {
    log: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
    fatal: () => undefined,
  };
}

describe('GET /api/v1/tipos-producto por Gateway, Taxonomy y PostgreSQL real', () => {
  let admin: Pool | undefined;
  let taxonomy: AplicacionCreada | undefined;
  let gateway: INestApplication | undefined;
  let issuer: Server | undefined;
  let gatewayUrl = '';
  let taxonomyUrl = '';
  let issuerPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  let localJwk: Record<string, unknown>;
  let outgoing: Array<{ origin: string; headers: string }> = [];
  const originalEnv = new Map<string, string | undefined>();
  const undiciCreate = channel('undici:request:create');
  const observeRequest = (message: unknown) => {
    if (!message || typeof message !== 'object' || !('request' in message))
      return;
    const request = message.request;
    if (!request || typeof request !== 'object') return;
    const origin = 'origin' in request ? String(request.origin) : '';
    const headers = 'headers' in request ? String(request.headers) : '';
    if (origin === taxonomyOrigin) outgoing.push({ origin, headers });
  };

  beforeAll(async () => {
    exigirEntorno();
    const acreditacion = await AcreditacionInstanciaEfimera.acreditar(
      DATABASE_URL,
      { env: process.env },
    );
    admin = new Pool({
      connectionString: acreditacion.connectionString,
      max: 2,
    });
    for (const statement of construirSentenciasDdl(acreditacion)) {
      await admin.query(statement);
    }
    const migration = resolve(
      process.cwd(),
      'apps/taxonomy-svc/migrations/0005_configurable_list_values.sql',
    );
    await admin.query(readFileSync(migration, 'utf8'));

    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    issuerPrivateKey = keyPair.privateKey;
    const jwk = keyPair.publicKey.export({ format: 'jwk' });
    localJwk = {
      ...jwk,
      kid: 'g6-h4-local-e2e',
      alg: 'RS256',
      use: 'sig',
    };
    issuer = createHttpsServer(
      {
        cert: readFileSync(SERVER_CERT_FILE!),
        key: readFileSync(SERVER_KEY_FILE!),
      },
      (request, response) => {
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'public, max-age=60');
        if (request.url === '/.well-known/openid-configuration') {
          response.end(
            JSON.stringify({ issuer: issuerUrl, jwks_uri: jwksUrl }),
          );
          return;
        }
        if (request.url === '/jwks') {
          response.end(JSON.stringify({ keys: [localJwk] }));
          return;
        }
        response.writeHead(404).end();
      },
    );
    issuer.listen(0, '127.0.0.1');
    await once(issuer, 'listening');
    const issuerAddress = issuer.address();
    if (!issuerAddress || typeof issuerAddress === 'string') {
      throw new Error('El issuer de pruebas no abrió el puerto.');
    }
    issuerUrl = `https://127.0.0.1:${issuerAddress.port}/issuer`;
    jwksUrl = `https://127.0.0.1:${issuerAddress.port}/jwks`;

    const taxonomyPort = await puertoDisponible();
    const taxonomyEnvironment: Record<string, string> = {
      NODE_ENV: 'test',
      TAXONOMY_SVC_HOST: '127.0.0.1',
      TAXONOMY_SVC_PORT: String(taxonomyPort),
      DATABASE_URL: new URL(acreditacion.connectionString).toString(),
      PGHOST: 'localhost',
      G6_CONNECT_HOST: '127.0.0.1',
      PGPORT: process.env.TAXONOMY_TEST_PG_PORT!,
      PGDATABASE: 'taxonomy_test',
      PGUSER: ROL_APP,
      PGPASSWORD: PASSWORD_APP,
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: CA_FILE!,
      G6_DATABASE_SCHEMA: 'taxonomy',
      G6_EXPECTED_ROLE: ROL_APP,
      G6_CONNECTION_MODE: 'session',
      ALLOW_DEMO_UNAUTHENTICATED: 'false',
      SECURITY_ISSUER: issuerUrl,
      SECURITY_DISCOVERY_URL: `https://127.0.0.1:${issuerAddress.port}/.well-known/openid-configuration`,
      SECURITY_JWKS_URL: jwksUrl,
    };
    const appPasswordUrl = new URL(acreditacion.connectionString);
    appPasswordUrl.hostname = 'localhost';
    appPasswordUrl.username = ROL_APP;
    appPasswordUrl.password = PASSWORD_APP;
    appPasswordUrl.searchParams.set('currentSchema', 'taxonomy');
    appPasswordUrl.searchParams.set('sslmode', 'verify-full');
    appPasswordUrl.searchParams.set('sslrootcert', CA_FILE!);
    taxonomyEnvironment.DATABASE_URL = appPasswordUrl.toString();
    taxonomy = await iniciarTaxonomySvc({
      env: taxonomyEnvironment,
      logger: quietLogger(),
    });
    taxonomyUrl = `http://127.0.0.1:${getPort(taxonomy.app)}`;
    taxonomyOrigin = taxonomyUrl;

    const gatewayPort = await puertoDisponible();
    const envKeys = [
      'NODE_ENV',
      'API_GATEWAY_PORT',
      'GATEWAY_TAXONOMY_SVC_URL',
      'GATEWAY_DEMO_NO_AUTH_ENABLED',
      'G6_READ_ONLY_DEMO_ENABLED',
      'GATEWAY_PUBLIC_OPERATION_IDS',
      'GATEWAY_TIMEOUT_MS',
      'AUTH_ISSUER',
      'AUTH_JWKS_URL',
    ];
    for (const key of envKeys) originalEnv.set(key, process.env[key]);
    for (const key of Object.keys(process.env)) {
      if (/^GATEWAY_[A-Z0-9_]+_(?:URL|READINESS_PATH)$/.test(key)) {
        originalEnv.set(key, process.env[key]);
        delete process.env[key];
      }
    }
    process.env.NODE_ENV = 'test';
    process.env.API_GATEWAY_PORT = String(gatewayPort);
    process.env.GATEWAY_TAXONOMY_SVC_URL = taxonomyUrl;
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'false';
    process.env.G6_READ_ONLY_DEMO_ENABLED = 'false';
    process.env.GATEWAY_PUBLIC_OPERATION_IDS = '';
    process.env.GATEWAY_TIMEOUT_MS = '5000';
    process.env.AUTH_ISSUER = issuerUrl;
    process.env.AUTH_JWKS_URL = jwksUrl;

    gateway = await NestFactory.create(ApiGatewayModule, {
      bodyParser: false,
      logger: false,
      abortOnError: false,
    });
    await gateway.listen(gatewayPort, '127.0.0.1');
    gatewayUrl = `http://127.0.0.1:${getPort(gateway)}`;
    undiciCreate.subscribe(observeRequest);
  }, 120_000);

  beforeEach(async () => {
    outgoing = [];
    await admin!.query('DELETE FROM taxonomy.product_types');
    await admin!.query('DELETE FROM taxonomy.category_seo');
    await admin!.query('DELETE FROM taxonomy.categories');
    await admin!.query(
      `INSERT INTO taxonomy.categories
        (id, nombre, descripcion, orden, imagen_url, estado, taxonomy_version)
       VALUES ('44444444-4444-4444-8444-444444444444', 'Bebidas', 'Descripción', 7, 'https://img.test/bebidas.png', 'ACTIVO', 3)`,
    );
    await admin!.query(
      `INSERT INTO taxonomy.category_seo (categoria_id, slug)
       VALUES ('44444444-4444-4444-8444-444444444444', 'bebidas')`,
    );
    await admin!.query(
      `INSERT INTO taxonomy.product_types (id, nombre, estado) VALUES
        ('11111111-1111-4111-8111-111111111111', 'A Activo', 'ACTIVO'),
        ('22222222-2222-4222-8222-222222222222', 'B Inactivo', 'INACTIVO'),
        ('33333333-3333-4333-8333-333333333333', 'C Pendiente', 'PENDING_DEACTIVATION')`,
    );
    const persisted = await admin!.query(
      'SELECT id::text FROM taxonomy.product_types ORDER BY nombre',
    );
    expect(persisted.rows).toHaveLength(3);
  });

  afterAll(async () => {
    undiciCreate.unsubscribe(observeRequest);
    await gateway?.close().catch(() => undefined);
    await taxonomy?.app.close().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    if (issuer) {
      issuer.closeAllConnections();
      await new Promise<void>((done) => issuer!.close(() => done()));
    }
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('devuelve filas PostgreSQL con JWT humano sin aud por Gateway y Taxonomy', async () => {
    const token = createToken(issuerPrivateKey);
    const correlationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    outgoing = [];
    const response = await fetch(
      `${gatewayUrl}/api/v1/tipos-producto?pagina=1&tamanio=2`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          'x-correlation-id': correlationId,
        },
      },
    );
    status(response, 200);
    const body = await json(response);
    expect(body.items).toEqual([
      expect.objectContaining({ nombre: 'A Activo', estado: 'ACTIVO' }),
      expect.objectContaining({ nombre: 'B Inactivo', estado: 'INACTIVO' }),
    ]);
    expect(body.meta).toEqual({
      pagina: 1,
      tamanio: 2,
      total: 2,
      totalPaginas: 1,
    });
    expect(response.headers.get('x-correlation-id')).toBe(correlationId);
    expect(outgoing).toHaveLength(1);
    expect(diagnosticHeader(outgoing[0]!.headers, 'authorization')).toBe(
      `Bearer ${token}`,
    );
    expect(diagnosticHeader(outgoing[0]!.headers, 'x-correlation-id')).toBe(
      correlationId,
    );
    const dbCheck = await admin!.query(
      "SELECT count(*)::int AS total FROM taxonomy.product_types WHERE estado IN ('ACTIVO', 'INACTIVO')",
    );
    expect(dbCheck.rows[0].total).toBe(2);
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('conserva audiencia, scope y cliente obligatorios para JWT de servicio Taxonomy', async () => {
    const serviceToken = createToken(issuerPrivateKey, {
      tipo: 'servicio',
      sub: 'modulo-marketplace',
      client_id: 'modulo-marketplace',
      aud: ['api-productos'],
      scope: 'catalogo:leer',
      roles: [],
    });
    const valid = await fetch(`${taxonomyUrl}/api/v1/categorias`, {
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    status(valid, 200);
    expect((await json(valid)).categories).toHaveLength(1);

    for (const claims of [
      { tipo: 'servicio', aud: undefined },
      { tipo: 'servicio', aud: ['audiencia-invalida'] },
    ]) {
      const invalidToken = createToken(issuerPrivateKey, {
        sub: 'modulo-marketplace',
        client_id: 'modulo-marketplace',
        scope: 'catalogo:leer',
        roles: [],
        ...claims,
      });
      const rejected = await fetch(`${taxonomyUrl}/api/v1/categorias`, {
        headers: { authorization: `Bearer ${invalidToken}` },
      });
      status(rejected, 401);
    }

    for (const claims of [
      { scope: 'catalogo:escribir' },
      { sub: 'cliente-no-autorizado', client_id: 'cliente-no-autorizado' },
    ]) {
      const unauthorizedToken = createToken(issuerPrivateKey, {
        tipo: 'servicio',
        aud: ['api-productos'],
        scope: 'catalogo:leer',
        roles: [],
        sub: 'modulo-marketplace',
        client_id: 'modulo-marketplace',
        ...claims,
      });
      const rejected = await fetch(`${taxonomyUrl}/api/v1/categorias`, {
        headers: { authorization: `Bearer ${unauthorizedToken}` },
      });
      status(rejected, 403);
    }
  });

  it('rechaza una petición anónima en Gateway antes de llamar a Taxonomy', async () => {
    outgoing = [];
    const response = await fetch(`${gatewayUrl}/api/v1/tipos-producto`);
    status(response, 401);
    expect(outgoing).toHaveLength(0);
  });

  it('sirve obtenerCategoriaAdmin con JWT humano y M2M, DTO persistido y 404 contractual', async () => {
    const correlationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const humanToken = createToken(issuerPrivateKey);
    const human = await fetch(
      `${gatewayUrl}/api/v1/categorias/44444444-4444-4444-8444-444444444444`,
      {
        headers: {
          authorization: `Bearer ${humanToken}`,
          'x-correlation-id': correlationId,
        },
      },
    );
    status(human, 200);
    expect(await json(human)).toEqual({
      categoriaId: '44444444-4444-4444-8444-444444444444',
      nombre: 'Bebidas',
      descripcion: 'Descripción',
      categoriaPadreId: null,
      orden: 7,
      imagenUrl: 'https://img.test/bebidas.png',
      estado: 'ACTIVO',
      version: 3,
      slug: 'bebidas',
    });
    expect(human.headers.get('x-correlation-id')).toBe(correlationId);

    const serviceToken = createToken(issuerPrivateKey, {
      tipo: 'servicio',
      sub: 'modulo-productos',
      client_id: 'modulo-productos',
      aud: ['api-productos'],
      scope: 'catalogo:leer',
      roles: [],
    });
    outgoing = [];
    const service = await fetch(
      `${gatewayUrl}/api/v1/categorias/44444444-4444-4444-8444-444444444444`,
      { headers: { authorization: `Bearer ${serviceToken}` } },
    );
    status(service, 200);
    expect((await json(service)).slug).toBe('bebidas');
    expect(outgoing).toHaveLength(1);
    expect(diagnosticHeader(outgoing[0]!.headers, 'authorization')).toBe(
      `Bearer ${serviceToken}`,
    );

    const missing = await fetch(
      `${gatewayUrl}/api/v1/categorias/55555555-5555-4555-8555-555555555555`,
      { headers: { authorization: `Bearer ${serviceToken}` } },
    );
    status(missing, 404);
    expect((await json(missing)).code).toBe('CATEGORIA_NO_ENCONTRADA');
  });

  it('rechaza cliente, scope y audience M2M incorrectos', async () => {
    for (const claims of [
      {
        tipo: 'servicio',
        sub: 'otro-modulo',
        client_id: 'otro-modulo',
        scope: 'catalogo:leer',
      },
      {
        tipo: 'servicio',
        sub: 'modulo-productos',
        client_id: 'modulo-productos',
        scope: 'catalogo:escribir',
      },
      {
        tipo: 'servicio',
        sub: 'modulo-productos',
        client_id: 'modulo-productos',
        aud: ['audiencia-invalida'],
        scope: 'catalogo:leer',
      },
    ]) {
      const token = createToken(issuerPrivateKey, { roles: [], ...claims });
      const response = await fetch(
        `${gatewayUrl}/api/v1/categorias/44444444-4444-4444-8444-444444444444`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect([401, 403]).toContain(response.status);
    }

    const authorized = createToken(issuerPrivateKey, {
      tipo: 'servicio',
      sub: 'modulo-productos',
      client_id: 'modulo-productos',
      aud: ['api-productos'],
      scope: 'catalogo:leer',
      roles: [],
    });
    outgoing = [];
    const otherRead = await fetch(`${gatewayUrl}/api/v1/categorias`, {
      headers: { authorization: `Bearer ${authorized}` },
    });
    status(otherRead, 403);
    const write = await fetch(`${gatewayUrl}/api/v1/categorias`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authorized}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ nombre: 'No autorizada' }),
    });
    status(write, 403);
    expect(outgoing).toHaveLength(0);
  });

  it('rechaza una firma inválida en Gateway y en el guard real de Taxonomy', async () => {
    const token = createToken(issuerPrivateKey);
    const parts = token.split('.');
    const signature = parts[2]!;
    const invalid = `${parts[0]}.${parts[1]}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    outgoing = [];
    const throughGateway = await fetch(`${gatewayUrl}/api/v1/tipos-producto`, {
      headers: { authorization: `Bearer ${invalid}` },
    });
    status(throughGateway, 401);
    expect(outgoing).toHaveLength(0);

    const direct = await fetch(`${taxonomyUrl}/api/v1/tipos-producto`, {
      headers: { authorization: `Bearer ${invalid}` },
    });
    status(direct, 401);
  });

  it('rechaza issuer inválido y no requiere aud para JWT humano', async () => {
    const wrongIssuer = createToken(issuerPrivateKey, {
      iss: 'https://issuer-invalido.test/',
    });
    outgoing = [];
    const issuerResponse = await fetch(`${gatewayUrl}/api/v1/tipos-producto`, {
      headers: { authorization: `Bearer ${wrongIssuer}` },
    });
    status(issuerResponse, 401);
    expect(outgoing).toHaveLength(0);

    const wrongAudience = createToken(issuerPrivateKey, {
      aud: ['audiencia-invalida'],
    });
    const audienceResponse = await fetch(
      `${gatewayUrl}/api/v1/tipos-producto`,
      { headers: { authorization: `Bearer ${wrongAudience}` } },
    );
    status(audienceResponse, 200);
    expect(outgoing).toHaveLength(1);
    expect((await json(audienceResponse)).items).toHaveLength(2);
  });

  it('autoriza directamente las lecturas maestras por rol humano y conserva la frontera de servicio', async () => {
    const characteristicId = randomUUID();
    const routes = [
      '/api/v1/tipos-producto',
      '/api/v1/tipos-producto/11111111-1111-4111-8111-111111111111',
      `/api/v1/caracteristicas/${characteristicId}/valores`,
      '/api/v1/tipos-producto/11111111-1111-4111-8111-111111111111/caracteristicas',
    ];
    await admin!.query(
      "INSERT INTO taxonomy.characteristics (id, nombre, tipo) VALUES ($1, $2, 'LISTA')",
      [characteristicId, `Color ${characteristicId}`],
    );
    await admin!.query(
      'INSERT INTO taxonomy.characteristic_values (caracteristica_id, nombre) VALUES ($1, $2)',
      [characteristicId, 'Rojo'],
    );

    try {
      const manager = createToken(issuerPrivateKey);
      for (const path of routes) {
        const response = await fetch(`${taxonomyUrl}${path}`, {
          headers: { authorization: `Bearer ${manager}` },
        });
        status(response, 200);
      }

      const client = createToken(issuerPrivateKey, { roles: ['CLIENTE'] });
      for (const path of routes) {
        const response = await fetch(`${taxonomyUrl}${path}`, {
          headers: { authorization: `Bearer ${client}` },
        });
        status(response, 403);
      }

      const authorizedService = createToken(issuerPrivateKey, {
        tipo: 'servicio',
        sub: 'modulo-productos',
        client_id: 'modulo-productos',
        aud: ['api-productos'],
        scope: 'catalogo:leer',
        roles: [],
      });
      for (const path of routes) {
        const response = await fetch(`${taxonomyUrl}${path}`, {
          headers: { authorization: `Bearer ${authorizedService}` },
        });
        status(response, 200);
      }
      for (const path of routes) {
        const response = await fetch(`${gatewayUrl}${path}`, {
          headers: { authorization: `Bearer ${authorizedService}` },
        });
        status(response, 403);
      }

      const invalidServices: Array<{
        claims: Record<string, unknown>;
        expected: number;
      }> = [
        { claims: { aud: undefined }, expected: 401 },
        { claims: { aud: ['audiencia-invalida'] }, expected: 401 },
        { claims: { scope: 'catalogo:escribir' }, expected: 403 },
        {
          claims: {
            sub: 'cliente-no-autorizado',
            client_id: 'cliente-no-autorizado',
          },
          expected: 403,
        },
      ];
      for (const { claims, expected } of invalidServices) {
        const invalidService = createToken(issuerPrivateKey, {
          tipo: 'servicio',
          sub: 'modulo-productos',
          client_id: 'modulo-productos',
          aud: ['api-productos'],
          scope: 'catalogo:leer',
          roles: [],
          ...claims,
        });
        for (const path of routes) {
          const response = await fetch(`${taxonomyUrl}${path}`, {
            headers: { authorization: `Bearer ${invalidService}` },
          });
          status(response, expected);
        }
      }

      const invalidHumanTokens = [
        createToken(issuerPrivateKey, {
          exp: Math.floor(Date.now() / 1000) - 1,
        }),
        createToken(issuerPrivateKey, {
          iss: 'https://issuer-invalido.test/',
        }),
      ];
      const validHuman = createToken(issuerPrivateKey);
      const tokenParts = validHuman.split('.');
      invalidHumanTokens.push(
        `${tokenParts[0]}.${tokenParts[1]}.${tokenParts[2]![0] === 'A' ? 'B' : 'A'}${tokenParts[2]!.slice(1)}`,
      );
      for (const invalidToken of invalidHumanTokens) {
        for (const path of routes) {
          const response = await fetch(`${taxonomyUrl}${path}`, {
            headers: { authorization: `Bearer ${invalidToken}` },
          });
          status(response, 401);
        }
      }
    } finally {
      await admin!.query(
        'DELETE FROM taxonomy.characteristic_values WHERE caracteristica_id = $1',
        [characteristicId],
      );
      await admin!.query('DELETE FROM taxonomy.characteristics WHERE id = $1', [
        characteristicId,
      ]);
    }
  });

  it('rechaza 403 al usuario sin GESTOR_COMERCIAL antes del upstream', async () => {
    outgoing = [];
    const token = createToken(issuerPrivateKey, { roles: ['LECTOR'] });
    const response = await fetch(`${gatewayUrl}/api/v1/tipos-producto`, {
      headers: { authorization: `Bearer ${token}` },
    });
    status(response, 403);
    expect(outgoing).toHaveLength(0);
  });

  it('devuelve 400 para valores de paginación fuera de contrato', async () => {
    const token = createToken(issuerPrivateKey);
    for (const query of ['pagina=0&tamanio=2', 'pagina=1&tamanio=201']) {
      const response = await fetch(
        `${gatewayUrl}/api/v1/tipos-producto?${query}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      status(response, 400);
      expect(JSON.stringify(await json(response))).not.toContain('SQL');
    }
  });

  it('devuelve listado vacío coherente y comprueba ausencia de fixtures HTTP', async () => {
    await admin!.query('DELETE FROM taxonomy.product_types');
    const token = createToken(issuerPrivateKey);
    const response = await fetch(`${gatewayUrl}/api/v1/tipos-producto`, {
      headers: { authorization: `Bearer ${token}` },
    });
    status(response, 200);
    expect(await json(response)).toEqual({
      items: [],
      meta: { pagina: 1, tamanio: 20, total: 0, totalPaginas: 0 },
    });
    const persisted = await admin!.query(
      'SELECT count(*)::int AS total FROM taxonomy.product_types',
    );
    expect(persisted.rows[0].total).toBe(0);
  });

  it('pagina PostgreSQL y verifica el máximo contractual de 200', async () => {
    const token = createToken(issuerPrivateKey);
    const page = await fetch(
      `${gatewayUrl}/api/v1/tipos-producto?pagina=2&tamanio=2`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    status(page, 200);
    expect(await json(page)).toEqual({
      items: [],
      meta: { pagina: 2, tamanio: 2, total: 2, totalPaginas: 1 },
    });
    const overContractLimit = await fetch(
      `${gatewayUrl}/api/v1/tipos-producto?pagina=1&tamanio=101`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    status(overContractLimit, 200);
    expect((await json(overContractLimit)).meta).toEqual({
      pagina: 1,
      tamanio: 101,
      total: 2,
      totalPaginas: 1,
    });
  });

  it('no filtra error SQL, parámetros ni credenciales del upstream', async () => {
    const token = createToken(issuerPrivateKey);
    await admin!.query(
      'ALTER TABLE taxonomy.product_types RENAME TO product_types_temporal_e2e',
    );
    try {
      const response = await fetch(`${gatewayUrl}/api/v1/tipos-producto`, {
        headers: { authorization: `Bearer ${token}` },
      });
      status(response, 503);
      const body = await response.text();
      expect(body).not.toContain('SELECT');
      expect(body).not.toContain('product_types');
      expect(body).not.toContain(PASSWORD_APP);
      expect(body).not.toContain(token);
      expect(body).not.toContain(DATABASE_URL!);
    } finally {
      await admin!.query(
        'ALTER TABLE taxonomy.product_types_temporal_e2e RENAME TO product_types',
      );
    }
  });

  it('traduce la caída real de Taxonomy a 503 sin filtrar errores', async () => {
    await taxonomy!.app.close();
    taxonomy = undefined;
    const token = createToken(issuerPrivateKey);
    const response = await fetch(`${gatewayUrl}/api/v1/tipos-producto`, {
      headers: { authorization: `Bearer ${token}` },
    });
    status(response, 503);
    const body = await response.text();
    expect(body).not.toContain(token);
    expect(body).not.toContain(PASSWORD_APP);
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain(DATABASE_URL!);
  });
});
