import { Logger } from '@nestjs/common';
import { parseBulkEnvironment } from '../config/bulk-environment.js';
import {
  BulkReadinessService,
  type BulkReadinessPool,
} from './bulk-readiness.service.js';

const configured = parseBulkEnvironment({
  NODE_ENV: 'test',
  BULK_SVC_PORT: '3008',
  DATABASE_URL: 'postgresql://bulk:fixture@127.0.0.1:5432/bulk?sslmode=disable',
});

function serviceWith(
  query: () => Promise<unknown>,
  options: {
    amqpUrl?: string | null;
    relayState?: string;
    consumerState?: string;
  } = {},
) {
  const pool: BulkReadinessPool = {
    query: vi.fn(query),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockReturnThis(),
  };
  const relay = {
    getOperationalState: vi.fn(() => options.relayState ?? 'READY'),
  };
  const consumer = {
    getOperationalState: vi.fn(() => options.consumerState ?? 'READY'),
  };
  return {
    service: new BulkReadinessService(
      configured,
      pool,
      options.amqpUrl === undefined ? 'amqp://fixture' : options.amqpUrl,
      relay as never,
      consumer as never,
    ),
    pool,
  };
}

describe('BulkReadinessService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('executes the read-only schema/table probe and returns true on success', async () => {
    const { service, pool } = serviceWith(async () => undefined);
    vi.stubEnv('BULK_AMQP_ENABLED', 'true');
    await expect(service.check()).resolves.toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT 1 FROM bulk.batch_jobs LIMIT 0',
    );
  });

  it.each([
    'connection refused',
    'query rejected',
    'timeout',
    'missing schema',
  ])('returns false for %s without propagating the error', async (reason) => {
    const { service } = serviceWith(async () => {
      throw new Error(`secret db detail: ${reason}`);
    });
    await expect(service.probe()).resolves.toMatchObject({
      ready: false,
      reason: 'DATABASE_UNAVAILABLE',
    });
  });

  it('logs a generic dependency failure without exposing connection details', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { service } = serviceWith(async () => {
      throw new Error(
        'postgresql://private-user:private-password@private-host/private-db',
      );
    });

    await expect(service.check()).resolves.toBe(false);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'La comprobación de PostgreSQL no está disponible.',
    );
    const exposedDetails =
      /private-user|private-password|private-host|private-db|postgresql:\/\//.test(
        JSON.stringify(warn.mock.calls),
      );
    expect(
      exposedDetails,
      'Logger exposed PostgreSQL connection details.',
    ).toBe(false);
  });

  it('returns false when DATABASE_URL is absent', async () => {
    const config = parseBulkEnvironment({ NODE_ENV: 'test', PORT: '3008' });
    const pool: BulkReadinessPool = {
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn().mockReturnThis(),
    };
    const service = new BulkReadinessService(config, pool);
    await expect(service.probe()).resolves.toEqual({
      ready: false,
      reason: 'DATABASE_NOT_CONFIGURED',
    });
    expect(pool.query).not.toHaveBeenCalled();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('distinguishes absent and explicitly disabled AMQP from an authorized demo peer', async () => {
    const { service } = serviceWith(async () => undefined, { amqpUrl: null });
    await expect(service.probe('127.0.0.1')).resolves.toEqual({
      ready: false,
      reason: 'AMQP_NOT_CONFIGURED',
    });
    vi.stubEnv('BULK_AMQP_ENABLED', 'false');
    await expect(service.probe('127.0.0.1')).resolves.toEqual({
      ready: false,
      reason: 'AMQP_DISABLED',
    });
    vi.stubEnv('GATEWAY_DEMO_NO_AUTH_ENABLED', 'true');
    vi.stubEnv('BULK_DEMO_GATEWAY_IPS', '127.0.0.1');
    await expect(service.probe('127.0.0.1')).resolves.toEqual({
      ready: true,
      reason: 'AUTHORIZED_DEMO',
    });
    await expect(service.probe('127.0.0.2')).resolves.toMatchObject({
      ready: false,
      reason: 'AMQP_DISABLED',
    });
  });

  it('reports transient worker failure and topology blockage separately', async () => {
    vi.stubEnv('BULK_AMQP_ENABLED', 'true');
    const recovering = serviceWith(async () => undefined, {
      relayState: 'RECOVERING',
    });
    await expect(recovering.service.probe()).resolves.toEqual({
      ready: false,
      reason: 'AMQP_TEMPORARY_UNAVAILABLE',
    });
    const blocked = serviceWith(async () => undefined, {
      consumerState: 'TOPOLOGY_BLOCKED',
    });
    await expect(blocked.service.probe()).resolves.toEqual({
      ready: false,
      reason: 'AMQP_TOPOLOGY_BLOCKED',
    });
  });

  it('closes the pool when the Nest module is destroyed', async () => {
    const { service, pool } = serviceWith(async () => undefined);
    await service.onModuleDestroy();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
