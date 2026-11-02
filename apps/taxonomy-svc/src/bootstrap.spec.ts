import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { LoggerService } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Database } from './database.js';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import { PostgresTaxonomyRepository } from './postgres-taxonomy.repository.js';
import {
  crearAplicacion,
  iniciarTaxonomySvc,
  readHttpConfig,
} from './bootstrap.js';
import { ConfiguracionInvalidaError } from './config/environment.js';

const CLAVE_FALSA = 'clave-de-prueba-no-real';

class SinkCapturador implements LoggerService {
  readonly registros: unknown[][] = [];

  log(...args: unknown[]): void {
    this.registros.push(args);
  }

  error(...args: unknown[]): void {
    this.registros.push(args);
  }

  warn(...args: unknown[]): void {
    this.registros.push(args);
  }

  debug(...args: unknown[]): void {
    this.registros.push(args);
  }

  verbose(...args: unknown[]): void {
    this.registros.push(args);
  }

  volcado(): string {
    return JSON.stringify(this.registros);
  }
}

function entornoValido(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    TAXONOMY_SVC_PORT: '3006',
    DATABASE_URL: `postgresql://usuario:${CLAVE_FALSA}@localhost:5432/taxonomy`,
  };
}

describe('Taxonomy bootstrap configuration reconciled with López', () => {
  it('defaults to loopback and supports Docker binding and PORT fallback', () => {
    expect(readHttpConfig({ NODE_ENV: 'test', PORT: '3006' })).toEqual({
      host: '127.0.0.1',
      port: 3006,
    });
    expect(
      readHttpConfig({
        NODE_ENV: 'production',
        TAXONOMY_SVC_HOST: '0.0.0.0',
        PORT: '3016',
      }),
    ).toEqual({ host: '0.0.0.0', port: 3016 });
  });

  it.each(['0', '65536', 'abc', '1.5', ' 3006', 'Infinity'])(
    'rejects invalid port %s',
    (value) => {
      expect(() =>
        readHttpConfig({ NODE_ENV: 'test', TAXONOMY_SVC_PORT: value }),
      ).toThrow();
    },
  );

  it('rejects invalid environment without returning its value', () => {
    expect(() =>
      readHttpConfig({ NODE_ENV: 'private-secret', PORT: '3006' }),
    ).toThrow('Configuración HTTP taxonomy inválida');
  });
});

describe('crearAplicacion — fail-closed (#34)', () => {
  it('rechaza el arranque cuando falta DATABASE_URL', async () => {
    const env = entornoValido();
    delete env.DATABASE_URL;

    await expect(crearAplicacion({ env })).rejects.toBeInstanceOf(
      ConfiguracionInvalidaError,
    );
  });

  it('rechaza el arranque cuando DATABASE_URL es inválida', async () => {
    await expect(
      crearAplicacion({
        env: { ...entornoValido(), DATABASE_URL: 'no-valido' },
      }),
    ).rejects.toBeInstanceOf(ConfiguracionInvalidaError);
  });

  it('crea la aplicación con un entorno válido y registra sin exponer secretos', async () => {
    const sink = new SinkCapturador();

    const { app, env } = await crearAplicacion({
      env: entornoValido(),
      logger: sink,
    });

    try {
      expect(app).toBeDefined();
      expect(env.port).toBe(3006);
      const logs = sink.volcado();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs).toContain('test');
      expect(logs).toContain('3006');
      expect(logs).not.toContain(CLAVE_FALSA);
      expect(logs).not.toContain('DATABASE_URL');
      expect(logs).not.toContain('postgresql://');
    } finally {
      await app.close();
    }
  });

  it('rechaza crearAplicacion en entorno production para impedir el uso de la fábrica alternativa sin TLS e identidad', async () => {
    await expect(
      crearAplicacion({
        env: { ...entornoValido(), NODE_ENV: 'production' },
      }),
    ).rejects.toThrow(ConfiguracionInvalidaError);
  });
});

describe('iniciarTaxonomySvc — fail-closed del arranque real (#34)', () => {
  let caDir: string;
  let caPath: string;

  beforeAll(() => {
    caDir = mkdtempSync(join(tmpdir(), 'taxonomy-ca-'));
    caPath = join(caDir, 'ca.pem');
    writeFileSync(
      caPath,
      '-----BEGIN CERTIFICATE-----\nprueba\n-----END CERTIFICATE-----\n',
    );
  });

  afterAll(() => {
    rmSync(caDir, { recursive: true, force: true });
  });

  function entornoRuntime(
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return {
      NODE_ENV: 'test',
      TAXONOMY_SVC_PORT: '3006',
      PGHOST: 'db.invalid',
      PGPORT: '5432',
      PGDATABASE: 'taxonomy',
      PGUSER: 'taxonomy_dev_login',
      PGPASSWORD: CLAVE_FALSA,
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: caPath,
      G6_DATABASE_SCHEMA: 'taxonomy',
      G6_EXPECTED_ROLE: 'taxonomy_dev_login',
      G6_CONNECTION_MODE: 'direct',
      ...overrides,
    };
  }

  it('rechaza un NODE_ENV inválido antes de abrir el puerto', async () => {
    await expect(
      iniciarTaxonomySvc({ env: entornoRuntime({ NODE_ENV: 'staging' }) }),
    ).rejects.toThrow('Configuración HTTP taxonomy inválida');
  });

  it('rechaza NODE_ENV ausente', async () => {
    await expect(
      iniciarTaxonomySvc({ env: entornoRuntime({ NODE_ENV: undefined }) }),
    ).rejects.toThrow('Configuración HTTP taxonomy inválida');
  });

  it('selecciona el repositorio PostgreSQL con configuración solo en env explícito', async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) =>
      server.once('error', reject).listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Puerto no disponible');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    vi.stubEnv('PGHOST', undefined);
    vi.stubEnv('DATABASE_URL', undefined);
    const identity = vi
      .spyOn(Database.prototype, 'verifyIdentity')
      .mockResolvedValue();
    const read = vi.spyOn(Database.prototype, 'read').mockResolvedValue([]);
    try {
      const { app } = await iniciarTaxonomySvc({
        env: entornoRuntime({ TAXONOMY_SVC_PORT: String(address.port) }),
      });
      try {
        expect(app.get(TAXONOMY_REPOSITORY)).toBeInstanceOf(
          PostgresTaxonomyRepository,
        );
        await request(app.getHttpServer())
          .get('/api/v1/categorias')
          .expect(200);
        await request(app.getHttpServer()).get('/api/v1/marcas').expect(200);
      } finally {
        await app.close();
      }
    } finally {
      identity.mockRestore();
      read.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('rechaza ambos puertos ausentes', async () => {
    await expect(
      iniciarTaxonomySvc({
        env: entornoRuntime({ TAXONOMY_SVC_PORT: undefined, PORT: undefined }),
      }),
    ).rejects.toThrow('Configuración HTTP taxonomy inválida');
  });

  it('rechaza la ausencia de URL y parámetros PG requeridos', async () => {
    await expect(
      iniciarTaxonomySvc({
        env: entornoRuntime({ DATABASE_URL: undefined, PGHOST: undefined }),
      }),
    ).rejects.toThrow('Configuración PostgreSQL taxonomy inválida');
  });

  it('rechaza DATABASE_URL malformada aunque existan parámetros PG', async () => {
    await expect(
      iniciarTaxonomySvc({
        env: entornoRuntime({ DATABASE_URL: 'no-es-url' }),
      }),
    ).rejects.toThrow('Configuración PostgreSQL taxonomy inválida');
  });

  it('rechaza un puerto inválido antes de abrir el puerto', async () => {
    await expect(
      iniciarTaxonomySvc({ env: entornoRuntime({ TAXONOMY_SVC_PORT: '0' }) }),
    ).rejects.toThrow('Configuración HTTP taxonomy inválida');
  });

  it('rechaza PGSSLMODE distinto de verify-full', async () => {
    await expect(
      iniciarTaxonomySvc({ env: entornoRuntime({ PGSSLMODE: 'require' }) }),
    ).rejects.toThrow('Configuración PostgreSQL taxonomy inválida');
  });

  it('no expone la contraseña cuando la configuración PostgreSQL es inválida', async () => {
    const env = entornoRuntime({
      DATABASE_URL: `postgresql://usuario:${CLAVE_FALSA}@db.invalid:5432/taxonomy`,
    });
    delete env.G6_EXPECTED_ROLE;

    const error = await iniciarTaxonomySvc({ env }).catch(
      (capturado) => capturado,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Configuración PostgreSQL taxonomy inválida',
    );
    expect((error as Error).message).not.toContain(CLAVE_FALSA);
  });
});
