import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ManagedIdentityCredential } from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusSender,
  type ServiceBusReceiver,
} from '@azure/service-bus';
import { IsolatedPostgres } from '../../../apps/pricing-svc/test/isolated-postgres.js';
import { IsolatedAuditPostgres } from '../../../apps/price-audit-svc/test/isolated-postgres.js';
import { PricingDatabase } from '../../../apps/pricing-svc/src/persistence/pricing.database.js';
import { PricingRepository } from '../../../apps/pricing-svc/src/persistence/pricing.repository.js';
import { PricingMutations } from '../../../apps/pricing-svc/src/application/pricing-mutations.js';
import {
  PricingDeliveryStore,
  AUDIT_PILOT_QUEUE,
} from '../../../apps/pricing-svc/src/messaging/service-bus-deliveries.js';
import { PricingServiceBusRelay } from '../../../apps/pricing-svc/src/messaging/service-bus-relay.js';
import { createPricingPriceChangedFacts } from '../../../apps/pricing-svc/src/messaging/pricing-fact.js';
import { AuditDatabase } from '../../../apps/price-audit-svc/src/persistence/audit.database.js';
import { AuditRepository } from '../../../apps/price-audit-svc/src/persistence/audit.repository.js';
import { AuditServiceBusHandler } from '../../../apps/price-audit-svc/src/messaging/service-bus-consumer.js';
import type { PricingConfig } from '../../../apps/pricing-svc/src/config/environment.js';

// Opt-in only. Requires a dedicated empty test queue and two managed identities;
// never provisions resources or falls back to a shared developer credential.
describe.skipIf(process.env.G6_SERVICE_BUS_AZURE_TESTS !== '1')(
  'H5 Azure real with separate managed identities',
  () => {
    const pricing = new IsolatedPostgres(),
      audit = new IsolatedAuditPostgres();
    let pricingDb: PricingDatabase, auditDb: AuditDatabase;
    let pricingClient: ServiceBusClient, auditClient: ServiceBusClient;
    let sender: ServiceBusSender, receiver: ServiceBusReceiver;
    let pricingConfig: PricingConfig;

    beforeAll(async () => {
      const namespace = process.env.G6_SERVICE_BUS_TEST_NAMESPACE ?? '';
      const pricingId = process.env.G6_PRICING_TEST_CLIENT_ID ?? '';
      const auditId = process.env.G6_AUDIT_TEST_CLIENT_ID ?? '';
      const guid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        !/^g6-sb-test-[a-z0-9-]+\.servicebus\.windows\.net$/.test(namespace) ||
        !guid.test(pricingId) ||
        !guid.test(auditId) ||
        pricingId.toLowerCase() === auditId.toLowerCase()
      )
        throw new Error(
          'DEDICATED_TEST_NAMESPACE_AND_SEPARATE_MANAGED_IDENTITIES_REQUIRED',
        );
      pricingClient = new ServiceBusClient(
        namespace,
        new ManagedIdentityCredential({ clientId: pricingId }),
        { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } },
      );
      auditClient = new ServiceBusClient(
        namespace,
        new ManagedIdentityCredential({ clientId: auditId }),
        { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } },
      );
      sender = pricingClient.createSender(AUDIT_PILOT_QUEUE);
      receiver = auditClient.createReceiver(AUDIT_PILOT_QUEUE, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
      });
      if ((await receiver.peekMessages(1)).length)
        throw new Error('TEST_QUEUE_MUST_BE_EMPTY');
      await pricing.start();
      await audit.start();
      const ddl = await readFile(
        new URL(
          '../../../apps/pricing-svc/migrations-candidate/h5/0001_outbox_delivery.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await pricing.admin!.query(
        `BEGIN; SET LOCAL ROLE po_pricing_owner; ${ddl} COMMIT;`,
      );
      const config: PricingConfig = {
        nodeEnv: 'test',
        port: 3002,
        securityMode: 'G7_AUTHENTICATED',
        publicOperations: [],
        databaseUrl: pricing.runtimeUrl,
        databaseSsl: false,
        serviceBus: { namespace },
      };
      pricingDb = new PricingDatabase(config);
      pricingConfig = config;
      auditDb = new AuditDatabase({
        nodeEnv: 'test',
        port: 3003,
        securityMode: 'G7_AUTHENTICATED',
        hotRetentionMonths: 24,
        archiveRetentionYears: 5,
        databaseUrl: audit.runtimeUrl,
        databaseSsl: false,
      });
    }, 120_000);
    afterAll(async () => {
      await Promise.allSettled([sender?.close(), receiver?.close()]);
      await Promise.allSettled([
        pricingClient?.close(),
        auditClient?.close(),
        pricingDb?.onApplicationShutdown(),
        auditDb?.onApplicationShutdown(),
      ]);
      await Promise.allSettled([pricing.stop(), audit.stop()]);
    });
    it('sends a real Pricing mutation through the SDK and persists one Audit effect', async () => {
      const repository = new PricingRepository(pricingDb);
      const mutations = new PricingMutations(repository, pricingConfig);
      const productId = randomUUID(),
        correlationId = randomUUID(),
        now = new Date();
      await mutations.update(
        { productId },
        null,
        {
          precioRegular: '123.45',
          currency: 'PEN',
          motivoCambio: 'ISOLATED_H5_TEST',
          usuarioId: null,
        },
        0n,
        now,
        (before, after) =>
          createPricingPriceChangedFacts(before, after, {
            actor: null,
            correlationId,
            at: now,
            operation: 'actualizarPrecioBaseProducto',
            productId,
          }),
      );
      const relay = new PricingServiceBusRelay(
        new PricingDeliveryStore(repository),
        sender,
      );
      expect(await relay.publishOne()).toBe('sent');
      const messages = await receiver.receiveMessages(1, {
        maxWaitTimeInMs: 10_000,
      });
      expect(messages).toHaveLength(1);
      const message = messages[0];
      if (message.correlationId !== correlationId) {
        await receiver.abandonMessage(message);
        throw new Error('UNEXPECTED_MESSAGE_IN_DEDICATED_TEST_QUEUE');
      }
      const handler = new AuditServiceBusHandler(
        new AuditRepository(auditDb),
        receiver,
      );
      expect(await handler.handle(message)).toBe('completed');
      expect(
        (
          await audit.admin!.query(
            'SELECT count(*)::int AS count FROM price_audit.price_audit_log a JOIN price_audit.inbox i ON i.id=a.inbox_id WHERE i.message_id=$1',
            [message.messageId],
          )
        ).rows[0].count,
      ).toBe(1);
    }, 30_000);
    it('denies sending with the receiver-only identity', async () => {
      const unauthorized = auditClient.createSender(AUDIT_PILOT_QUEUE);
      try {
        await expect(unauthorized.createMessageBatch()).rejects.toMatchObject({
          code: 'UnauthorizedAccess',
        });
      } finally {
        await unauthorized.close();
      }
    }, 15_000);
    it('denies receiving with the sender-only identity', async () => {
      const unauthorized = pricingClient.createReceiver(AUDIT_PILOT_QUEUE, {
        receiveMode: 'peekLock',
      });
      try {
        await expect(unauthorized.peekMessages(1)).rejects.toMatchObject({
          code: 'UnauthorizedAccess',
        });
      } finally {
        await unauthorized.close();
      }
    }, 15_000);
  },
);
