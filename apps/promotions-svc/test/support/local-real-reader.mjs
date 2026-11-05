// Runs the pinned Promotions transport/token/identity code inside the private network.
// No fetch patch, business fixture server, repository substitute or Nest override.
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '/app/dist/apps/promotions-svc/infrastructure/config/promotions-config.js';
import {
  PromotionsIdentity,
  remotePromotionsKeys,
} from '/app/dist/apps/promotions-svc/http/promotions-identity.js';
import { promotionsServiceTokens } from '/app/dist/apps/promotions-svc/infrastructure/http/service-tokens.js';
import { InternalHttpReader } from '/app/dist/apps/promotions-svc/infrastructure/http/internal-http.js';
import { PromotionsReadinessService } from '/app/dist/apps/promotions-svc/health/promotions-readiness.service.js';
import { nativePromotionsDependencyProbes } from '/app/dist/apps/promotions-svc/health/promotions-dependency-probes.js';
const config = new PromotionsConfigService(
  validatePromotionsConfiguration(process.env),
);
const identity = new PromotionsIdentity(config, remotePromotionsKeys(config));
const reader = new InternalHttpReader({
  origin: config.settings.upstreams.catalog,
  origins: config.settings.upstreams,
  getServiceAccessToken: promotionsServiceTokens(config, identity),
});
const [operation, path, milliseconds = '5000'] = process.argv.slice(2);
const start = performance.now();
try {
  if (operation === 'marketplace-seed') {
    const { NestFactory } = await import('@nestjs/core');
    const { PromotionsSvcModule } =
      await import('/app/dist/apps/promotions-svc/promotions-svc.module.js');
    const { PromotionsPersistence } =
      await import('/app/dist/apps/promotions-svc/infrastructure/persistence/promotions-persistence.js');
    const app = await NestFactory.createApplicationContext(
      PromotionsSvcModule,
      { logger: false, abortOnError: false },
    );
    try {
      const seeded = await app
        .get(PromotionsPersistence)
        .transaction(async (r) => {
          const p = await r.promotions.create(
            {
              name: 'REAL-PARTIAL-CONSUMER',
              discountType: 'PORCENTAJE',
              discountValue: '10',
              modality: 'CUPON',
              state: 'ACTIVO',
              validFrom: '2026-01-01T00:00:00Z',
              validUntil: '2027-01-01T00:00:00Z',
              priority: 1,
              enabledChannels: ['MARKETPLACE'],
            },
            [{ sku: 'SYNTHETIC-REAL' }],
            { pricingOffer: true, automaticPromotion: true, coupon: true },
          );
          const code = 'REAL_PARTIAL_CONSUMER';
          await r.coupons.create({
            promotionId: p.id,
            code,
            state: 'ACTIVO',
            maxGlobalUses: 1,
            cancellationPolicy: 'RESTAURAR_EN_CANCELACION',
          });
          await r.recommendations.create(
            {
              name: 'REAL-PARTIAL-REC',
              recommendationType: 'CROSS_SELL',
              originType: 'PRODUCTO',
              originId: path,
              priority: 1,
              state: 'ACTIVO',
              validFrom: '2026-01-01T00:00:00Z',
              validUntil: '2027-01-01T00:00:00Z',
            },
            [{ productId: 'REAL-UNREACHABLE-CANDIDATE', itemOrder: 1 }],
          );
          return { promotionId: p.id, code };
        });
      console.log(
        JSON.stringify({
          outcome: 'RETURNED',
          body: { kind: 'fixture-own-promotions-only', ...seeded },
        }),
      );
    } finally {
      await app.close();
    }
    process.exit(0);
  }
  if (operation === 'admin-category') {
    const { NestFactory } = await import('@nestjs/core');
    const { PromotionsSvcModule } =
      await import('/app/dist/apps/promotions-svc/promotions-svc.module.js');
    const { ADMIN_REFERENCES } =
      await import('/app/dist/apps/promotions-svc/domain/admin-references.js');
    const app = await NestFactory.createApplicationContext(
      PromotionsSvcModule,
      { logger: false, abortOnError: false },
    );
    try {
      const refs = await app
        .get(ADMIN_REFERENCES)
        .verify(
          { products: [], skus: [], categories: [path] },
          AbortSignal.timeout(Number(milliseconds)),
        );
      console.log(
        JSON.stringify({
          outcome: 'RETURNED',
          body: {
            products: [...refs.products],
            skus: [...refs.skus],
            categories: [...refs.categories],
          },
          scope:
            'native PromotionsSvcModule ADMIN_REFERENCES; no provider overrides',
        }),
      );
    } finally {
      await app.close();
    }
    process.exit(0);
  }
  if (operation === 'issuer-evidence') {
    const response = await fetch('https://issuer:4443/evidence');
    console.log(
      JSON.stringify({ outcome: 'RETURNED', body: await response.json() }),
    );
    process.exit(0);
  }
  if (operation === 'catalog-transport-evidence') {
    const response = await fetch('https://catalog-tls:4443/__test/requests');
    if (response.status !== 200) throw new Error('TEST_TRACE_UNAVAILABLE');
    console.log(
      JSON.stringify({ outcome: 'RETURNED', body: await response.json() }),
    );
    process.exit(0);
  }
  if (operation === 'readiness') {
    const body = await new PromotionsReadinessService(
      nativePromotionsDependencyProbes(config),
    ).check(true);
    console.log(
      JSON.stringify({
        outcome: 'RETURNED',
        body,
        scope: {
          instance:
            'independent test PromotionsReadinessService; not the running Nest monitor',
          passiveBrokerProbe: true,
          runningServiceBrokerProbeEnabled: false,
          couponRuntimeEnabled: false,
          operationalAmqpConsumptionVerified: false,
        },
      }),
    );
    process.exit(0);
  }
  const signal = AbortSignal.timeout(Number(milliseconds));
  try {
    const body = await reader.read(operation, path, signal, true);
    console.log(
      JSON.stringify({
        outcome: 'RETURNED',
        body,
        elapsedMs: Math.round(performance.now() - start),
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        outcome: 'REJECTED',
        name: error.name,
        error: error.message,
        cancellation: {
          aborted: signal.aborted,
          reasonName: signal.reason?.name ?? null,
          matchesReason: error === signal.reason,
        },
        elapsedMs: Math.round(performance.now() - start),
      }),
    );
  }
} catch (error) {
  console.log(
    JSON.stringify({
      outcome: 'REJECTED',
      name: error.name,
      kind: error.constructor.name,
      error: error.message,
      elapsedMs: Math.round(performance.now() - start),
    }),
  );
}
