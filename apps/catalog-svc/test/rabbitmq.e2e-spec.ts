import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
  connect,
  type Channel,
  type ChannelModel,
  type GetMessage,
} from 'amqplib';
import {
  CatalogAmqpRuntime,
  ConfirmedCatalogPublisher,
} from '../src/catalog-amqp.js';
import type { CatalogMessageService } from '../src/catalog-message.service.js';
import { envelope } from '../src/catalog-messages.js';

const dockerAvailable =
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  }).status === 0;
if (process.env.CI?.toLowerCase() === 'true' && !dockerAvailable)
  throw new Error('Catalog RabbitMQ provider tests require Docker in CI');
describe.skipIf(!dockerAvailable)(
  'Catalog provider on one disposable RabbitMQ 4.2.9 broker',
  () => {
    const container = 'catalog-amqp-' + process.pid + '-' + Date.now();
    const vhost = 'g6-productos-ofertas',
      password = 'isolated-broker-fixture';
    let url: string,
      connection: ChannelModel,
      channel: Channel,
      publisher: ConfirmedCatalogPublisher;
    const extraConnections: ChannelModel[] = [];
    function docker(args: string[]): string {
      const result = spawnSync('docker', args, {
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
      });
      if (result.status !== 0)
        throw new Error('Disposable RabbitMQ setup failed');
      return result.stdout.trim();
    }
    async function next(queue: string, timeout = 5000): Promise<GetMessage> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const message = await channel.get(queue, { noAck: false });
        if (message) return message;
        await pause(100);
      }
      throw new Error('Disposable RabbitMQ delivery timed out');
    }
    beforeAll(async () => {
      docker([
        'run',
        '--rm',
        '--detach',
        '--name',
        container,
        '--publish',
        '127.0.0.1::5672',
        '--env',
        'RABBITMQ_DEFAULT_VHOST=' + vhost,
        '--env',
        'RABBITMQ_DEFAULT_USER=catalog-test',
        '--env',
        'RABBITMQ_DEFAULT_PASS=' + password,
        'rabbitmq:4.2.9-alpine',
      ]);
      const port = docker(['port', container, '5672/tcp']).split(':').at(-1)!;
      url =
        'amqp://catalog-test:' + password + '@127.0.0.1:' + port + '/' + vhost;
      const deadline = Date.now() + 60000;
      while (true) {
        try {
          connection = await connect(url, { timeout: 2000 });
          break;
        } catch {
          if (Date.now() > deadline)
            throw new Error('Disposable broker not ready');
          await pause(250);
        }
      }
      connection.on('error', () => undefined);
      channel = await connection.createChannel();
      channel.on('error', () => undefined);
      const confirms = await connection.createConfirmChannel();
      confirms.on('error', () => undefined);
      publisher = new ConfirmedCatalogPublisher(confirms, 'catalog-test');
      await channel.assertExchange('po.sin-ruta.x', 'fanout', {
        durable: true,
      });
      for (const name of ['po.comandos.x', 'po.eventos.x', 'po.resultados.x'])
        await channel.assertExchange(name, 'topic', {
          durable: true,
          alternateExchange: 'po.sin-ruta.x',
        });
      for (const name of ['po.retry.x', 'po.dlx.x'])
        await channel.assertExchange(name, 'direct', { durable: true });
      await channel.assertQueue('po.sin-ruta.q', { durable: true });
      await channel.bindQueue('po.sin-ruta.q', 'po.sin-ruta.x', '');
      for (const queue of ['po.catalogo.q', 'po.inventario.q'])
        await channel.assertQueue(queue, {
          durable: true,
          arguments: { 'x-queue-type': 'quorum' },
        });
      await channel.bindQueue(
        'po.inventario.q',
        'po.comandos.x',
        'inventory.sku.initialization.requested',
      );
      for (const key of [
        'inventory.sku.initialization.completed',
        'inventory.sku.initialization.rejected',
      ])
        await channel.bindQueue('po.catalogo.q', 'po.resultados.x', key);
      await channel.assertQueue('po.catalogo.q.retry', {
        durable: true,
        arguments: {
          'x-message-ttl': 30000,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': 'po.catalogo.q',
        },
      });
      await channel.bindQueue(
        'po.catalogo.q.retry',
        'po.retry.x',
        'po.catalogo.q',
      );
      await channel.assertQueue('po.catalogo.q.dlq', { durable: true });
      await channel.bindQueue('po.catalogo.q.dlq', 'po.dlx.x', 'po.catalogo.q');
      docker([
        'exec',
        container,
        'rabbitmqctl',
        'add_user',
        'inventory-test',
        password,
      ]);
      docker([
        'exec',
        container,
        'rabbitmqctl',
        'set_permissions',
        '-p',
        vhost,
        'inventory-test',
        '.*',
        '.*',
        '.*',
      ]);
    }, 180000);
    afterAll(async () => {
      await Promise.allSettled(extraConnections.map((c) => c.close()));
      await connection?.close().catch(() => undefined);
      spawnSync('docker', ['rm', '--force', container], {
        timeout: 15000,
        windowsHide: true,
        stdio: 'ignore',
      });
    }, 30000);
    it('publishes persistent, mandatory, confirmed messages while preserving opaque SKU and identities', async () => {
      const message = envelope(
        'inventory.sku.initialization.requested',
        { sku: '0000123', product_id: randomUUID(), variant_id: null },
        randomUUID(),
        randomUUID(),
      );
      await publisher.publish(message);
      const received = await next('po.inventario.q');
      expect(JSON.parse(received.content.toString())).toEqual(message);
      expect(received.properties.deliveryMode).toBe(2);
      expect(received.properties.userId).toBe('catalog-test');
      channel.ack(received);
    });
    it('distinguishes alternate-exchange capture from consumer delivery', async () => {
      const message = envelope(
        'catalog.product.deactivated',
        { product_id: randomUUID() },
        randomUUID(),
        randomUUID(),
      );
      await publisher.publish(message);
      const captured = await next('po.sin-ruta.q');
      expect(JSON.parse(captured.content.toString()).message_id).toBe(
        message.message_id,
      );
      channel.ack(captured);
      expect(await channel.get('po.catalogo.q', { noAck: false })).toBe(false);
    });
    it('rejects basic.return even when the broker also confirms the publish', async () => {
      await channel.unbindQueue('po.sin-ruta.q', 'po.sin-ruta.x', '');
      try {
        await expect(
          publisher.publish(
            envelope('catalog.sku.deactivated', { sku: '000' }, randomUUID()),
          ),
        ).rejects.toThrow('AMQP_PUBLISH_UNCONFIRMED');
      } finally {
        await channel.bindQueue('po.sin-ruta.q', 'po.sin-ruta.x', '');
      }
    });
    it('tests the unapproved retry design only on the disposable fixture, returning the same message after 30 seconds', async () => {
      const message = envelope(
        'inventory.sku.initialization.requested',
        { sku: '000', product_id: randomUUID() },
        randomUUID(),
        randomUUID(),
      );
      await publisher.raw(
        'po.retry.x',
        'po.catalogo.q',
        Buffer.from(JSON.stringify(message)),
        {
          messageId: message.message_id,
          correlationId: message.correlation_id,
          headers: { 'x-retry-count': 1 },
        },
      );
      expect(await channel.get('po.catalogo.q', { noAck: false })).toBe(false);
      const retried = await next('po.catalogo.q', 40000);
      expect(JSON.parse(retried.content.toString())).toEqual(message);
      channel.ack(retried);
    }, 45000);
    it('keeps a real queued message untouched when shared recovery is blocked', async () => {
      const consume = vi.fn(),
        relayOne = vi.fn();
      const runtime = new CatalogAmqpRuntime(
        { consume, relayOne } as unknown as CatalogMessageService,
        {
          connection: {
            url,
            user: 'catalog-test',
            producerUsers: {
              'inventory-svc': 'inventory-test',
              'pricing-svc': 'pricing-test',
              'taxonomy-svc': 'taxonomy-test',
              'bulk-svc': 'bulk-test',
            },
          },
        },
      );
      const content = Buffer.from('isolated-pending-message');
      await publisher.raw(
        'po.resultados.x',
        'inventory.sku.initialization.completed',
        content,
        { messageId: randomUUID() },
      );
      try {
        runtime.onModuleInit();
        await pause(100);
        expect((await channel.checkQueue('po.catalogo.q')).consumerCount).toBe(
          0,
        );
        expect(consume).not.toHaveBeenCalled();
        expect(relayOne).not.toHaveBeenCalled();
        const pending = await next('po.catalogo.q');
        expect(pending.content).toEqual(content);
        channel.ack(pending);
      } finally {
        await runtime.onModuleDestroy();
      }
    });
    it('retains the broker delivery until the committed-use-case promise resolves', async () => {
      let release!: () => void, received!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        started = new Promise<void>((resolve) => {
          received = resolve;
        });
      const runtime = new CatalogAmqpRuntime(
        {
          consume: async () => {
            received();
            await gate;
            return 'APPLIED';
          },
          relayOne: async () => 'EMPTY',
        } as unknown as CatalogMessageService,
        {
          isolatedTestRecovery: true,
          connection: {
            url,
            user: 'catalog-test',
            producerUsers: {
              'inventory-svc': 'inventory-test',
              'pricing-svc': 'pricing-test',
              'taxonomy-svc': 'taxonomy-test',
              'bulk-svc': 'bulk-test',
            },
          },
        },
      );
      const producer = await connect(
        url.replace('catalog-test:', 'inventory-test:'),
      );
      extraConnections.push(producer);
      producer.on('error', () => undefined);
      const producerChannel = await producer.createConfirmChannel();
      producerChannel.on('error', () => undefined);
      const result = {
        message_id: randomUUID(),
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: randomUUID(),
        operation_id: randomUUID(),
        causation_id: randomUUID(),
        producer: 'inventory-svc',
        kind: 'result',
        name: 'inventory.sku.initialization.completed',
        data: {
          product_id: randomUUID(),
          sku: '0000123',
          variant_id: null,
          status: 'INITIALIZED',
          completed_at: new Date().toISOString(),
        },
      };
      runtime.onModuleInit();
      await new ConfirmedCatalogPublisher(
        producerChannel,
        'inventory-test',
      ).raw(
        'po.resultados.x',
        result.name,
        Buffer.from(JSON.stringify(result)),
        {
          messageId: result.message_id,
          correlationId: result.correlation_id,
        },
      );
      await started;
      const stopped = runtime.onModuleDestroy();
      try {
        const redelivered = await next('po.catalogo.q');
        expect(redelivered.fields.redelivered).toBe(true);
        expect(JSON.parse(redelivered.content.toString()).message_id).toBe(
          result.message_id,
        );
        channel.ack(redelivered);
      } finally {
        release();
        await stopped;
      }
    }, 15000);
  },
);
