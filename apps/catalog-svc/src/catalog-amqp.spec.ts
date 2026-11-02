import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ConfirmChannel } from 'amqplib';
import {
  ConfirmedCatalogPublisher,
  readCatalogAmqpConfig,
} from './catalog-amqp.js';
import { envelope, InvalidCatalogMessage } from './catalog-messages.js';

describe('Confirmed catalog publisher (transport fixture, not live broker evidence)', () => {
  function fixture(writable = true) {
    const channel = new EventEmitter() as EventEmitter & {
      publish: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    channel.publish = vi.fn(() => writable);
    channel.close = vi.fn(async () => undefined);
    return {
      channel,
      publisher: new ConfirmedCatalogPublisher(
        channel as unknown as ConfirmChannel,
        'catalog-test',
        100,
      ),
    };
  }
  it('waits for publisher confirmation and uses persistent mandatory messages', async () => {
    const { channel, publisher } = fixture();
    const message = envelope(
      'catalog.product.deactivated',
      { product_id: 'p' },
      randomUUID(),
    );
    let done = false;
    const work = publisher.publish(message).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    const args = channel.publish.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe('po.eventos.x');
    expect(args[1]).toBe(message.name);
    expect(args[3]).toMatchObject({
      persistent: true,
      mandatory: true,
      messageId: message.message_id,
      userId: 'catalog-test',
    });
    (args[4] as (error?: unknown) => void)();
    await work;
    expect(done).toBe(true);
  });
  it('does not mistake basic.return plus a broker ACK for a successful route', async () => {
    const { channel, publisher } = fixture();
    const work = publisher.publish(
      envelope('catalog.product.deactivated', {}, randomUUID()),
    );
    await Promise.resolve();
    channel.emit('return');
    const confirm = (
      channel.publish.mock.calls[0] as unknown as unknown[]
    )[4] as () => void;
    confirm();
    await expect(work).rejects.toThrow('AMQP_PUBLISH_UNCONFIRMED');
  });
  it.each([
    [
      'pricing.product.initialization.requested',
      'po.comandos.x',
      {
        product_id: 'p',
        sku_base: '0001',
        precio_regular: 10,
        moneda: 'PEN',
        channel_id: null,
        motivo_cambio: 'ALTA_PRODUCTO',
      },
    ],
    [
      'inventory.sku.initialization.requested',
      'po.comandos.x',
      { product_id: 'p', sku: '0001', variant_id: null },
    ],
    ['catalog.product.deactivated', 'po.eventos.x', { product_id: 'p' }],
    ['catalog.sku.deactivated', 'po.eventos.x', { sku: '0001' }],
    [
      'catalog.master.deactivation.checked',
      'po.resultados.x',
      {
        entity_type: 'CATEGORY',
        entity_id: 'category',
        version: 1,
        result: 'CLEAR',
      },
    ],
    [
      'catalog.master.deactivation.checked',
      'po.resultados.x',
      {
        entity_type: 'CATEGORY',
        entity_id: 'category',
        version: 1,
        result: 'IN_USE',
      },
    ],
    ['catalog.bulk.upsert.completed', 'po.resultados.x', {}],
    ['catalog.bulk.upsert.rejected', 'po.resultados.x', {}],
  ] as const)(
    'uses the reconciled physical exchange for %s without rewriting the envelope',
    async (name, exchange, data) => {
      const { channel, publisher } = fixture();
      const message = envelope(name, data, randomUUID(), randomUUID());
      const work = publisher.publish(message);
      await Promise.resolve();
      const args = channel.publish.mock.calls[0];
      expect(args[0]).toBe(exchange);
      expect(args[1]).toBe(name);
      expect(JSON.parse(args[2].toString())).toEqual(message);
      args[4]();
      await work;
    },
  );
  it('blocks a legacy persisted result before publishing without rewriting its identity or payload', async () => {
    const { channel, publisher } = fixture();
    const message = envelope(
      'catalog.master.deactivation.checked',
      {
        entity_type: 'CATEGORY',
        entity_id: 'opaque',
        version: 7,
        result: 'IN_USE',
      },
      randomUUID(),
      randomUUID(),
    );
    message.data.result = 'HAS_ACTIVE_PRODUCTS';
    const original = structuredClone(message);
    await expect(publisher.publish(message)).rejects.toBeInstanceOf(
      InvalidCatalogMessage,
    );
    expect(channel.publish).not.toHaveBeenCalled();
    expect(message).toEqual(original);
  });
  it('honors backpressure and fails unconfirmed publications on channel closure', async () => {
    const { channel, publisher } = fixture(false);
    let done = false;
    const work = publisher
      .publish(envelope('catalog.sku.deactivated', {}, randomUUID()))
      .then(() => {
        done = true;
      });
    await Promise.resolve();
    (
      (channel.publish.mock.calls[0] as unknown as unknown[])[4] as () => void
    )();
    expect(done).toBe(false);
    channel.emit('drain');
    await work;
    expect(done).toBe(true);
    const failed = publisher.publish(
      envelope('catalog.sku.deactivated', {}, randomUUID()),
    );
    await Promise.resolve();
    await Promise.resolve();
    channel.emit('close');
    await expect(failed).rejects.toThrow();
  });
  it('requires explicit authenticated producer mapping and the contractual vhost', () => {
    expect(readCatalogAmqpConfig({})).toBeUndefined();
    expect(() =>
      readCatalogAmqpConfig({ RABBITMQ_URL: 'amqp://user:pass@localhost/' }),
    ).toThrow();
    expect(
      readCatalogAmqpConfig({
        RABBITMQ_URL: 'amqp://catalog:fixture@localhost/g6-productos-ofertas',
        CATALOG_AMQP_PRODUCER_USERS: JSON.stringify({
          'pricing-svc': 'pricing',
          'inventory-svc': 'inventory',
          'taxonomy-svc': 'taxonomy',
          'bulk-svc': 'bulk',
        }),
      }),
    ).toMatchObject({ user: 'catalog' });
  });
});
