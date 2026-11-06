import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { connect } from 'amqplib';
import { PriceAuditSvcModule } from '../src/price-audit-svc.module.js';
import { AuditConsumer } from '../src/messaging/audit-consumer.js';
import { IsolatedAuditPostgres } from './isolated-postgres.js';
import { IsolatedRabbitmq } from './isolated-rabbitmq.js';
import { SignedUser } from './signed-user.js';

describe.skipIf(process.env.PRICE_AUDIT_TEST_AMQP !== '1')(
  'AMQP tipado - Inbox/log - HTTP con decoder productivo',
  () => {
    const postgres = new IsolatedAuditPostgres();
    const broker = new IsolatedRabbitmq();
    const identity = new SignedUser();
    let app: INestApplication;
    let consumer: AuditConsumer;
    const rows = async (sku: string) =>
      (
        await postgres.admin!.query(
          'SELECT count(*)::int AS total FROM price_audit.price_audit_log WHERE sku=$1',
          [sku],
        )
      ).rows[0].total;
    const envelope = (sku: string) => ({
      message_id: randomUUID(),
      correlation_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      producer: 'pricing-svc',
      kind: 'event',
      name: 'pricing.price.changed',
      data: {
        target_type: 'SKU',
        product_id: 'fixture-product',
        sku,
        channel_id: 'MARKETPLACE',
        currency: 'PEN',
        price_type: 'REGULAR',
        previous_price: null,
        new_price: '12.30',
        operation: 'CREACION',
        reason: 'ALTA_PRODUCTO',
        price_version: 1,
        valid_from: new Date().toISOString(),
        batch_id: null,
        actor: { user_id: null, email: null, ip: null },
      },
    });
    async function publish(body: unknown) {
      const connection = await connect(broker.url, { timeout: 2000 });
      connection.on('error', () => undefined);
      try {
        const channel = await connection.createConfirmChannel();
        channel.on('error', () => undefined);
        channel.publish(
          'po.eventos.x',
          'pricing.price.changed',
          Buffer.from(JSON.stringify(body)),
          { persistent: true, contentType: 'application/json' },
        );
        await channel.waitForConfirms();
        await channel.close();
      } finally {
        await connection.close().catch(() => undefined);
      }
    }
    beforeAll(async () => {
      await postgres.start();
      await broker.start();
      await identity.start();
      const module = await Test.createTestingModule({
        imports: [
          PriceAuditSvcModule.forRoot({
            NODE_ENV: 'test',
            PRICE_AUDIT_SVC_PORT: '3003',
            DATABASE_URL: postgres.runtimeUrl,
            AUTH_ISSUER: identity.issuer,
            AUTH_JWKS_URL: identity.issuer + '/jwks',
            PRICE_AUDIT_AMQP_URL: broker.url.split('?')[0],
          }),
        ],
      }).compile();
      app = module.createNestApplication({ logger: false });
      await app.init();
      consumer = app.get(AuditConsumer);
      await vi.waitFor(() => expect(consumer.available).toBe(true), {
        timeout: 15000,
      });
    }, 120000);
    afterAll(async () => {
      await app?.close();
      await identity.stop();
      await broker.stop();
      await postgres.stop();
    });
    it('consume, confirma commit, consulta por JWT y deduplica un redelivery con el mismo message_id', async () => {
      const event = envelope('amqp-once');
      await publish(event);
      await expect.poll(() => rows('amqp-once'), { timeout: 10000 }).toBe(1);
      await publish(event);
      await setTimeout(300);
      expect(await rows('amqp-once')).toBe(1);
      const response = await request(app.getHttpServer())
        .get('/api/v1/auditoria-precios?sku=amqp-once')
        .set('Authorization', 'Bearer ' + identity.token())
        .expect(200);
      expect(response.body.items[0]).toMatchObject({
        precio_anterior: null,
        precio_nuevo: 12.3,
        tipo_operacion: 'CREACION',
      });
      expect(
        (
          await postgres.admin!.query(
            'SELECT count(*)::int AS total FROM price_audit.inbox WHERE message_id=$1',
            [event.message_id],
          )
        ).rows[0].total,
      ).toBe(1);
    });
    it('persiste PRODUCTO global y precision decimal sin SKU ficticio', async () => {
      const event = envelope('unused');
      const productEvent = {
        ...event,
        data: {
          ...event.data,
          target_type: 'PRODUCTO',
          sku: null,
          channel_id: null,
          operation: 'MODIFICACION',
          previous_price: '6.0001',
          new_price: '7.0001',
        },
      };
      await publish(productEvent);
      const saved = async () =>
        (
          await postgres.admin!.query(
            'SELECT l.* FROM price_audit.price_audit_log l JOIN price_audit.inbox i ON i.id=l.inbox_id WHERE i.message_id=$1',
            [event.message_id],
          )
        ).rows;
      await expect
        .poll(async () => (await saved()).length, { timeout: 10000 })
        .toBe(1);
      expect((await saved())[0]).toMatchObject({
        target_type: 'PRODUCTO',
        sku: null,
        canal_origen: null,
        precio_anterior: '6.0001',
        precio_nuevo: '7.0001',
        variacion_porcentual: '16.67',
      });
      const row = (await saved())[0];
      const response = await request(app.getHttpServer())
        .get('/api/v1/auditoria-precios/' + row.id_auditoria)
        .set('Authorization', 'Bearer ' + identity.token())
        .expect(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    });
    it('NACK/rollback conserva entrega y recupera después de un fallo de persistencia', async () => {
      const event = envelope('db-recovery');
      await postgres.admin!.query(
        'REVOKE INSERT ON price_audit.price_audit_log FROM price_audit_app',
      );
      try {
        await publish(event);
        await setTimeout(500);
        expect(await rows('db-recovery')).toBe(0);
        expect(
          (
            await postgres.admin!.query(
              'SELECT count(*)::int AS total FROM price_audit.inbox WHERE message_id=$1',
              [event.message_id],
            )
          ).rows[0].total,
        ).toBe(0);
      } finally {
        await postgres.admin!.query(
          'GRANT INSERT ON price_audit.price_audit_log TO price_audit_app',
        );
      }
      await expect.poll(() => rows('db-recovery'), { timeout: 15000 }).toBe(1);
      expect(consumer.paused).toBe(false);
    });
    it.each([
      { producer: 'otro-servicio' },
      { occurred_at: '2026-02-30T00:00:00Z' },
      {
        data: {
          ...envelope('invalid').data,
          valid_from: '2026-02-30T00:00:00Z',
        },
      },
      { data: { fixture_sku: 'legacy-generic-data' } },
    ])(
      'retiene envelope incompatible o GenericData antiguo sin ACK: %j',
      async (incompatible) => {
        const incoming = { ...envelope('invalid'), ...incompatible };
        await publish(incoming);
        await expect.poll(() => consumer.paused, { timeout: 10000 }).toBe(true);
        await expect
          .poll(
            async () =>
              (await broker.channel!.checkQueue('po.auditoria-precios.q'))
                .messageCount,
            { timeout: 10000 },
          )
          .toBe(1);
        expect(await rows('invalid')).toBe(0);
        expect(
          (
            await postgres.admin!.query(
              'SELECT count(*)::int AS total FROM price_audit.inbox WHERE message_id=$1',
              [incoming.message_id],
            )
          ).rows[0].total,
        ).toBe(0);
        await request(app.getHttpServer()).get('/health/ready').expect(503);
        await request(app.getHttpServer()).get('/health/live').expect(200);
        const invalid = await broker.channel!.get('po.auditoria-precios.q');
        if (!invalid) throw new Error('El mensaje no quedó retenido.');
        broker.channel!.ack(invalid); // Disposición manual exclusiva de la fixture, no política de producción.
        consumer.start();
        await expect
          .poll(() => consumer.available, { timeout: 10000 })
          .toBe(true);
      },
    );
    it('reconecta tras interrupción de broker sin sustituir disponibilidad por liveness', async () => {
      await broker.pause();
      try {
        await expect
          .poll(() => consumer.available, { timeout: 20000 })
          .toBe(false);
      } finally {
        await broker.resume();
      }
      await broker.reconnect();
      await expect
        .poll(() => consumer.available, { timeout: 20000 })
        .toBe(true);
      const event = envelope('broker-recovery');
      await publish(event);
      await expect
        .poll(() => rows('broker-recovery'), { timeout: 10000 })
        .toBe(1);
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    }, 45000);
  },
);
