// Disposable PG/Rabbit only. fixture_* fields and adapters below are explicitly
// synthetic; GenericData is not a production projection contract.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PromotionsAssignedEventDispatcher } from '../../../../dist/apps/promotions-svc/coupons/assigned-event-dispatcher.js';
import {
  assignedEventContracts,
  promotionsBrokerBinding,
} from '../../../../dist/apps/promotions-svc/coupons/event-contract.generated.js';
import { createAssignedProjectionAdapter } from '../../../../dist/apps/promotions-svc/coupons/assigned-projections.js';
import { CouponCommandConsumer } from '../../../../dist/apps/promotions-svc/coupons/coupon-consumer.js';

export async function verifyAssignedEvents({
  pool,
  admin,
  connection,
  channel,
  commandHandler,
}) {
  const checks = [];
  const handler = 'promotions-assigned-events-v1';
  const ref = 'EXPLICIT-SYNTHETIC-' + randomUUID();
  const event = (name = 'catalog.product.deactivated', version = 1) => ({
    message_id: randomUUID(),
    schema_version: 1,
    occurred_at: '2026-10-23T12:00:00Z',
    correlation_id: 'isolated-assigned',
    causation_id: 'isolated-cause',
    producer: assignedEventContracts[name].producer,
    kind: 'event',
    name,
    data: {
      fixture_id: ref + '-' + name,
      fixture_version: version,
      fixture_active: false,
    },
  });
  const delivery = (body) => ({
    content: Buffer.from(JSON.stringify(body)),
    fields: { exchange: 'po.eventos.x', routingKey: body.name },
    properties: { contentType: 'application/json', messageId: body.message_id },
  });
  let failAfterWrite = false;
  const validate = (data) =>
    typeof data.fixture_id === 'string' &&
    Number.isSafeInteger(data.fixture_version) &&
    data.fixture_version > 0 &&
    typeof data.fixture_active === 'boolean';
  const adapters = Object.fromEntries(
    Object.keys(assignedEventContracts).map((name) => {
      // Explicit synthetic decoder ONLY in this disposable test. Production has
      // no agreed GenericData mapping and its registry remains empty.
      const adapter = createAssignedProjectionAdapter(name, (data) => {
        if (!validate(data)) throw new Error('INVALID_SYNTHETIC_MAPPING');
        const sourceVersion = BigInt(data.fixture_version);
        if (name === 'catalog.product.deactivated')
          return { productId: data.fixture_id, sourceVersion };
        if (name === 'catalog.sku.deactivated')
          return {
            sku: data.fixture_id,
            productId: data.fixture_product ?? data.fixture_id + '-PRODUCT',
            sourceVersion,
          };
        if (name === 'pricing.price.changed')
          return {
            sku: data.fixture_id,
            channelId: data.fixture_channel ?? null,
            sourceVersion,
          };
        return {
          sku: data.fixture_id,
          availability: data.fixture_availability ?? 'AGOTADO',
          sourceVersion,
        };
      });
      return [
        name,
        {
          validate: adapter.validate,
          apply: async (client, body) => {
            await adapter.apply(client, body);
            if (failAfterWrite) await client.query('SELECT 1/0');
          },
        },
      ];
    }),
  );
  const dispatcher = new PromotionsAssignedEventDispatcher(pool, adapters);
  dispatcher.assertReady();
  for (const name of Object.keys(assignedEventContracts)) {
    const body = event(name);
    assert.equal(
      await dispatcher.process(delivery(body), body.producer),
      'processed',
    );
    assert.equal(
      await dispatcher.process(delivery(body), body.producer),
      'replayed',
    );
    const receipt = await admin.query(
      'SELECT completed_at,result FROM promotions.inbox WHERE message_id=$1 AND handler=$2',
      [body.message_id, handler],
    );
    assert.ok(receipt.rows[0].completed_at);
    assert.deepEqual(receipt.rows[0].result, { handled: true });
    if (name.startsWith('catalog.')) {
      const row = (
        await admin.query(
          'SELECT reference_type,reference_id,product_id,active,snapshot FROM promotions.catalog_projection WHERE reference_id=$1',
          [body.data.fixture_id],
        )
      ).rows[0];
      assert.equal(
        row.reference_type,
        name === 'catalog.product.deactivated' ? 'PRODUCTO' : 'SKU',
      );
      assert.equal(
        row.product_id,
        name === 'catalog.product.deactivated'
          ? body.data.fixture_id
          : body.data.fixture_id + '-PRODUCT',
      );
      assert.equal(row.active, false);
      assert.deepEqual(row.snapshot, body.data);
    } else if (name.startsWith('pricing.')) {
      const row = (
        await admin.query(
          'SELECT channel_id,snapshot FROM promotions.price_projection WHERE sku=$1',
          [body.data.fixture_id],
        )
      ).rows[0];
      assert.equal(row.channel_id, null);
      assert.deepEqual(row.snapshot, body.data);
    } else {
      const row = (
        await admin.query(
          'SELECT availability,snapshot FROM promotions.stock_projection WHERE sku=$1',
          [body.data.fixture_id],
        )
      ).rows[0];
      assert.equal(row.availability, 'AGOTADO');
      assert.deepEqual(row.snapshot, body.data);
    }
    await assert.rejects(
      dispatcher.process(
        delivery({ ...body, data: { ...body.data, fixture_version: 2 } }),
        body.producer,
      ),
      /PROMOTIONS_ASSIGNED_EVENT_FAILED/,
    );
  }
  checks.push(
    'four assigned event envelopes: real PG Inbox/projection transaction, exact replay and conflicting message_id rejection, using explicitly synthetic field adapters',
  );
  const skuEvent = event('catalog.sku.deactivated', 2);
  const changedParent = {
    ...event('catalog.sku.deactivated', 3),
    data: {
      ...skuEvent.data,
      fixture_version: 3,
      fixture_product: 'DIFFERENT-PRODUCT',
    },
  };
  await dispatcher.process(delivery(skuEvent), skuEvent.producer);
  await assert.rejects(
    dispatcher.process(delivery(changedParent), changedParent.producer),
    /PROMOTIONS_ASSIGNED_EVENT_FAILED/,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM promotions.inbox WHERE message_id=$1',
        [changedParent.message_id],
      )
    ).rows[0].n,
    0,
  );
  const channelPrice = event('pricing.price.changed', 1);
  channelPrice.data.fixture_channel = 'MARKETPLACE';
  await dispatcher.process(delivery(channelPrice), channelPrice.producer);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM promotions.price_projection WHERE sku=$1',
        [channelPrice.data.fixture_id],
      )
    ).rows[0].n,
    2,
  );
  const stock = event('inventory.stock.changed', 3);
  stock.data.fixture_availability = 'STOCK_BAJO';
  await dispatcher.process(delivery(stock), stock.producer);
  assert.equal(
    (
      await admin.query(
        'SELECT availability FROM promotions.stock_projection WHERE sku=$1',
        [stock.data.fixture_id],
      )
    ).rows[0].availability,
    'STOCK_BAJO',
  );
  checks.push(
    'real normalized projection writers distinguish product/SKU identities, reject parent reassignment atomically, preserve global/channel price rows and apply explicit stock availability; fixture decoders are not external contracts',
  );
  const body = event();
  body.data.fixture_id += '-rollback';
  failAfterWrite = true;
  await assert.rejects(
    dispatcher.process(delivery(body), body.producer),
    /PROMOTIONS_ASSIGNED_EVENT_FAILED/,
  );
  failAfterWrite = false;
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM promotions.inbox WHERE message_id=$1 AND handler=$2',
        [body.message_id, handler],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM promotions.catalog_projection WHERE reference_id=$1',
        [body.data.fixture_id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    await dispatcher.process(delivery(body), body.producer),
    'processed',
  );
  const newest = { ...event(), data: { ...body.data, fixture_version: 3 } };
  await dispatcher.process(delivery(newest), newest.producer);
  const stale = { ...event(), data: { ...body.data, fixture_version: 2 } };
  await dispatcher.process(delivery(stale), stale.producer);
  assert.equal(
    String(
      (
        await admin.query(
          'SELECT source_version FROM promotions.catalog_projection WHERE reference_id=$1',
          [body.data.fixture_id],
        )
      ).rows[0].source_version,
    ),
    '3',
  );
  const unavailable = event();
  await assert.rejects(
    new PromotionsAssignedEventDispatcher(pool, {}).process(
      delivery(unavailable),
      unavailable.producer,
    ),
    /PROMOTIONS_EVENT_ADAPTER_UNAVAILABLE/,
  );
  await assert.rejects(
    dispatcher.process(delivery(event()), 'modulo-ventas'),
    /INVALID_ASSIGNED_EVENT/,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM promotions.inbox WHERE message_id=$1',
        [unavailable.message_id],
      )
    ).rows[0].n,
    0,
  );
  checks.push(
    'adapter SQL failure rolls back projection and Inbox, retry succeeds, older versions cannot overwrite newer data and missing mapping/authenticated producer never completes Inbox',
  );

  async function waitFor(work) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await work()) return;
      await delay(100);
    }
    throw new Error('ASSIGNED_BROKER_WAIT_TIMEOUT');
  }
  async function publish(value) {
    channel.publish(
      'po.eventos.x',
      value.name,
      Buffer.from(JSON.stringify(value)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: value.message_id,
        userId: 'guest',
      },
    );
    await channel.waitForConfirms();
  }
  const throughBroker = event('pricing.price.changed', 2);
  const receiving = await connection.createChannel();
  receiving.on('error', () => undefined);
  let acked = 0;
  let receiptAtAck;
  const ack = receiving.ack.bind(receiving);
  receiving.ack = (message) => {
    receiptAtAck = admin.query(
      'SELECT completed_at FROM promotions.inbox WHERE message_id=$1 AND handler=$2',
      [throughBroker.message_id, handler],
    );
    acked++;
    ack(message);
  };
  const worker = new CouponCommandConsumer(receiving, commandHandler, {
    // Only this disposable broker maps guest to fixture producers. Production
    // requires its own verified identity/ACL adapter and remains disabled.
    authenticatedActor: async () => {
      throw new Error('No coupon expected');
    },
    handleOtherAssignedEvent: async (message) => {
      assert.equal(message.properties.userId, 'guest');
      await dispatcher.process(
        message,
        assignedEventContracts[message.fields.routingKey].producer,
      );
    },
    failed: () => undefined,
  });
  try {
    await worker.start();
    await publish(throughBroker);
    await waitFor(async () => acked === 1);
    assert.ok((await receiptAtAck).rows[0].completed_at);
    await publish(throughBroker);
    await waitFor(async () => acked === 2);
  } finally {
    await worker.stop();
  }
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM promotions.inbox WHERE message_id=$1 AND handler=$2',
        [throughBroker.message_id, handler],
      )
    ).rows[0].n,
    1,
  );
  const lost = event('inventory.stock.changed', 2);
  const interrupted = await connection.createChannel();
  await publish(lost);
  let first;
  await waitFor(async () => {
    first = await interrupted.get(promotionsBrokerBinding.queue, {
      noAck: false,
    });
    return !!first;
  });
  await dispatcher.process(first, lost.producer);
  await interrupted.close(); // No ACK: the real broker requeues this committed event.
  let redelivery;
  await waitFor(async () => {
    redelivery = await channel.get(promotionsBrokerBinding.queue, {
      noAck: false,
    });
    return !!redelivery;
  });
  assert.equal(redelivery.fields.redelivered, true);
  assert.equal(await dispatcher.process(redelivery, lost.producer), 'replayed');
  channel.ack(redelivery);
  checks.push(
    'shared rc.3 quorum queue routes real assigned events, ACK observes committed Inbox, duplicate publish and broker redelivery after lost ACK do not repeat projections',
  );
  return checks;
}
