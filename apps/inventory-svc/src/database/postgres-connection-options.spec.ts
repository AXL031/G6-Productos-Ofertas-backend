import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InventoryConfig } from '../config/inventory.config.js';
import { createPostgresPoolOptions } from './postgres-connection-options.js';

const baseConfig: InventoryConfig = {
  pgPort: 5432,
  port: 3005,
  reservationTtlSeconds: 900,
  defaultLowStockThreshold: 5,
  workerIntervalMs: 5000,
  workerBatchSize: 50,
  commercialDemo: { enabled: false, gatewayIps: [] },
  catalogSkuDeactivationEnabled: false,
};

describe('PostgreSQL connection security', () => {
  const originalNodeTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  afterEach(() => {
    if (originalNodeTls === undefined)
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalNodeTls;
  });

  it('permite sslmode=disable solo para PostgreSQL local desechable', () => {
    const options = createPostgresPoolOptions(
      {
        ...baseConfig,
        databaseUrl:
          'postgresql://test:test@127.0.0.1:5432/inventory?sslmode=disable',
      },
      { NODE_ENV: 'test' },
    );
    expect(options?.ssl).toBe(false);
  });

  it('exige TLS verificado para PostgreSQL remoto en producción', () => {
    const options = createPostgresPoolOptions(
      {
        ...baseConfig,
        databaseUrl: 'postgresql://test:test@db.example/inventory',
      },
      { NODE_ENV: 'production' },
    );
    expect(options?.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('usa una CA explícita confiable y no la filtra en errores', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inventory-ca-'));
    try {
      const ca =
        '-----BEGIN CERTIFICATE-----\nsynthetic-ca\n-----END CERTIFICATE-----';
      const caPath = join(directory, 'ca.pem');
      writeFileSync(caPath, ca);
      const options = createPostgresPoolOptions(
        {
          ...baseConfig,
          databaseUrl: 'postgresql://test:test@db.example/inventory',
          pgSslRootCert: caPath,
        },
        { NODE_ENV: 'production' },
      );
      expect(options?.ssl).toEqual({ ca, rejectUnauthorized: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    'postgresql://test:test@db.example/inventory?sslmode=disable',
    'postgresql://test:test@db.example/inventory?sslmode=disable&sslmode=verify-full',
  ])('rechaza sslmode remoto inseguro: %s', (databaseUrl) => {
    expect(() =>
      createPostgresPoolOptions(
        { ...baseConfig, databaseUrl },
        { NODE_ENV: 'production' },
      ),
    ).toThrow();
  });

  it('rechaza modos SSL conflictivos o parámetros SSL embebidos en la URL', () => {
    expect(() =>
      createPostgresPoolOptions(
        {
          ...baseConfig,
          databaseUrl:
            'postgresql://test:test@db.example/inventory?sslmode=require',
          pgSslMode: 'disable',
        },
        { NODE_ENV: 'test' },
      ),
    ).toThrow(/conflictivos/);
    expect(() =>
      createPostgresPoolOptions(
        {
          ...baseConfig,
          databaseUrl:
            'postgresql://test:test@db.example/inventory?sslrootcert=%2Ftmp%2Fca.pem',
        },
        { NODE_ENV: 'production' },
      ),
    ).toThrow(/PG SSL explícita/);
  });

  it('rechaza CA ausente o inválida sin imprimir su contenido', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inventory-ca-invalid-'));
    const caPath = join(directory, 'ca.pem');
    writeFileSync(caPath, 'private material that is not a CA');
    try {
      expect(() =>
        createPostgresPoolOptions(
          {
            ...baseConfig,
            databaseUrl: 'postgresql://test:test@db.example/inventory',
            pgSslRootCert: join(directory, 'missing.pem'),
          },
          { NODE_ENV: 'production' },
        ),
      ).toThrow(/no está disponible/);
      expect(() =>
        createPostgresPoolOptions(
          {
            ...baseConfig,
            databaseUrl: 'postgresql://test:test@db.example/inventory',
            pgSslRootCert: caPath,
          },
          { NODE_ENV: 'production' },
        ),
      ).toThrow(/no es legible o válida/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('falla en producción cuando faltan credenciales o se desactiva TLS global', () => {
    expect(() =>
      createPostgresPoolOptions(baseConfig, { NODE_ENV: 'production' }),
    ).toThrow(/obligatoria/);
    expect(() =>
      createPostgresPoolOptions(
        { ...baseConfig, databaseUrl: 'postgresql://db.example/inventory' },
        { NODE_ENV: 'production' },
      ),
    ).toThrow(/credenciales PostgreSQL/);
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    expect(() =>
      createPostgresPoolOptions(
        {
          ...baseConfig,
          databaseUrl: 'postgresql://test:test@db.example/inventory',
        },
        { NODE_ENV: 'production', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      ),
    ).toThrow(/validación TLS/);
  });

  it('rechaza configuración por campos incompleta y modos no verificados', () => {
    expect(() =>
      createPostgresPoolOptions(
        { ...baseConfig, pgHost: 'db.example', pgUser: 'test' },
        { NODE_ENV: 'production' },
      ),
    ).toThrow(/incompleta/);
    expect(() =>
      createPostgresPoolOptions(
        {
          ...baseConfig,
          databaseUrl: 'postgresql://test:test@db.example/inventory',
          pgSslMode: 'verify-ca',
        },
        { NODE_ENV: 'production' },
      ),
    ).toThrow(/PGSSLMODE/);
  });
});
