import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PromotionsSvcModule } from './../src/promotions-svc.module.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../src/infrastructure/config/promotions-config.js';
import {
  PROMOTIONS_DEPENDENCY_PROBES,
  PromotionsReadinessService,
} from '../src/health/promotions-readiness.service.js';
import { COUPON_EVIDENCE_PROVIDER } from '../src/coupons/coupon-providers.js';
import { CouponRuntime } from '../src/coupons/coupon-runtime.js';
import { CouponCommandDeliveryHandler } from '../src/coupons/coupon-amqp.js';
import type { CouponEvidenceProvider } from '../src/coupons/coupon-transactions.js';
import { createEnvironmentFixture } from './support/environment.js';
import {
  ADMIN_REFERENCES,
  type AdminReferences,
} from '../src/domain/admin-references.js';
import {
  COMMERCIAL_CONTEXT,
  type CommercialContext,
} from '../src/domain/commercial-context.js';
import {
  COUPON_RUNTIME_BOUNDARY,
  type CouponRuntimeBoundary,
} from '../src/coupons/coupon-runtime.js';
import {
  PromotionsAssignedEventDispatcher,
  PROMOTIONS_BROKER_IDENTITY,
  type PromotionsBrokerIdentity,
} from '../src/coupons/assigned-event-dispatcher.js';

describe('PromotionsSvcController (e2e)', () => {
  let app: INestApplication<App>;
  const fixture = createEnvironmentFixture();
  afterAll(() => fixture.cleanup());

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    })
      .overrideProvider(PromotionsConfigService)
      .useFactory({
        factory: () =>
          new PromotionsConfigService(
            validatePromotionsConfiguration(fixture.environment),
          ),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('keeps readiness internal and does not publish new HTTP routes', async () => {
    expect(await app.get(PromotionsReadinessService).check()).toMatchObject({
      status: 'not_ready',
      dependencies: { database: 'disabled', broker: 'disabled' },
    });
    await request(app.getHttpServer()).get('/health/live').expect(404);
    await request(app.getHttpServer()).get('/health/ready').expect(404);
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok',
      service: 'promotions-svc',
    });
  });

  it('registers coupon adapters without starting an unverified shared consumer', async () => {
    expect(app.get(CouponCommandDeliveryHandler)).toBeInstanceOf(
      CouponCommandDeliveryHandler,
    );
    const evidence = app.get<CouponEvidenceProvider>(COUPON_EVIDENCE_PROVIDER);
    await expect(
      evidence.verify(
        {
          message_id: 'isolated-restoration',
          schema_version: 2,
          operation_id: '6d86380f-5f55-4b9f-9bc4-5e3cf2bfc999',
          occurred_at: '2026-10-16T12:00:00Z',
          correlation_id: 'trace',
          causation_id: 'cancellation',
          producer: 'modulo-ventas',
          kind: 'command',
          name: 'promotions.coupon.restoration.requested',
          data: {
            order_id: 'PED-TEST',
            cancellation_reason: 'test',
            cancelled_at: '2026-10-16T12:00:00Z',
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('COUPON_EVIDENCE_UNAVAILABLE');
  });

  afterEach(async () => {
    await app.close();
  });
});

describe('Promotions module startup configuration', () => {
  const fixture = createEnvironmentFixture();
  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(fixture.directory);
    for (const [name, value] of Object.entries(fixture.environment)) {
      vi.stubEnv(name, value);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(() => fixture.cleanup());

  it('validates the real configuration provider while building the module', async () => {
    const module = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    }).compile();
    try {
      expect(module.get(PromotionsConfigService).settings.port).toBe(3004);
      expect(
        await module.get(PromotionsReadinessService).check(),
      ).toMatchObject({
        status: 'not_ready',
      });
    } finally {
      await module.close();
    }
  });

  it('refuses startup with a missing mandatory variable', async () => {
    vi.stubEnv('PGPASSWORD', undefined);
    await expect(
      Test.createTestingModule({ imports: [PromotionsSvcModule] }).compile(),
    ).rejects.toThrow('PGPASSWORD');
  });

  it('refuses opt-in consumer activation before DB, broker or Outbox effects', async () => {
    vi.stubEnv('PROMOTIONS_COUPON_RUNTIME_ENABLED', 'true');
    const module = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    }).compile();
    try {
      await expect(
        module.get(CouponRuntime).onApplicationBootstrap(),
      ).rejects.toThrow(
        'COUPON_RUNTIME_BLOCKED_EVIDENCE_ELIGIBILITY_DISPATCHER_IDENTITY',
      );
    } finally {
      await module.close();
    }
  });

  it('cannot bypass the production runtime gate just by satisfying dispatcher and broker preflight', async () => {
    const module = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    }).compile();
    try {
      const dispatcher = vi
        .spyOn(module.get(PromotionsAssignedEventDispatcher), 'assertReady')
        .mockReturnValue(undefined);
      const identity = vi
        .spyOn(
          module.get<PromotionsBrokerIdentity>(PROMOTIONS_BROKER_IDENTITY),
          'assertReady',
        )
        .mockResolvedValue(undefined);
      await expect(
        module
          .get<CouponRuntimeBoundary>(COUPON_RUNTIME_BOUNDARY)
          .assertReady(),
      ).rejects.toThrow(
        'COUPON_RUNTIME_BLOCKED_EVIDENCE_ELIGIBILITY_DISPATCHER_IDENTITY',
      );
      expect(dispatcher).toHaveBeenCalledOnce();
      expect(identity).toHaveBeenCalledOnce();
    } finally {
      await module.close();
    }
  });

  it('does not equate healthy dependency probes or HTTP liveness with commercial readiness', async () => {
    const module = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    })
      .overrideProvider(PROMOTIONS_DEPENDENCY_PROBES)
      .useValue({
        database: { check: async () => undefined },
        broker: { check: async () => undefined },
      })
      .compile();
    const app = module.createNestApplication({ logger: false });
    try {
      await app.init();
      expect(await app.get(PromotionsReadinessService).check()).toMatchObject({
        status: 'ready',
        dependencies: { database: 'up', broker: 'up' },
      });
      const signal = new AbortController().signal;
      await expect(
        app
          .get<AdminReferences>(ADMIN_REFERENCES)
          .verify(
            { products: ['P'], skus: ['SKU'], categories: ['C'] },
            signal,
          ),
      ).rejects.toThrow('COMMERCIAL_CONTEXT_UNAVAILABLE');
      await expect(
        app
          .get<CommercialContext>(COMMERCIAL_CONTEXT)
          .basket(
            { channel_id: 'MARKETPLACE', lines: [{ sku: 'SKU', quantity: 1 }] },
            '2026-10-22T12:00:00Z',
            signal,
          ),
      ).rejects.toThrow('COMMERCIAL_CONTEXT_UNAVAILABLE');
      await request(app.getHttpServer()).get('/health').expect(200);
      await request(app.getHttpServer()).get('/health/live').expect(404);
      await request(app.getHttpServer()).get('/health/ready').expect(404);
    } finally {
      await app.close();
    }
  });
});
