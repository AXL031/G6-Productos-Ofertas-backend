import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuthoritativeCouponEvidence } from '../../../../dist/apps/promotions-svc/coupons/authoritative-coupon-evidence.js';
import { CouponCommandProcessor } from '../../../../dist/apps/promotions-svc/coupons/coupon-transactions.js';
import {
  CouponCommandDeliveryHandler,
  CouponAmqpPublisher,
} from '../../../../dist/apps/promotions-svc/coupons/coupon-amqp.js';
import { CouponOutbox } from '../../../../dist/apps/promotions-svc/coupons/coupon-outbox.js';
import { setTimeout as delay } from 'node:timers/promises';

// These are internal, explicitly synthetic verified facts. No G5/Inventory
// response or authenticated external integration is simulated as production.
export async function verifyCouponEligibility({
  pool,
  admin,
  command,
  restore,
  connection,
  channel,
}) {
  const promotion = randomUUID();
  const automatic = randomUUID();
  const coupon = randomUUID();
  await admin.query('BEGIN');
  try {
    await admin.query('SET LOCAL ROLE po_promotions_owner');
    await admin.query(
      `INSERT INTO promotions.promotions(id,name,discount_type,discount_value,modality,state,valid_from,valid_until,priority,enabled_channels)
       VALUES ($1,'Eligibility fixture','PORCENTAJE',10,'CUPON','ACTIVO','2026-10-01','2026-12-01',2,ARRAY['MARKETPLACE'])`,
      [promotion],
    );
    await admin.query(
      "INSERT INTO promotions.promotion_scopes(promotion_id,sku) VALUES ($1,'ELIGIBILITY-SKU')",
      [promotion],
    );
    await admin.query(
      'INSERT INTO promotions.combination_policy VALUES ($1,false,true,false)',
      [promotion],
    );
    await admin.query(
      `INSERT INTO promotions.coupons(id,promotion_id,code,state,minimum_amount,max_global_uses,cancellation_policy)
       VALUES ($1,$2,'ELIGIBILITY_FIXTURE','ACTIVO',100,1,'RESTAURAR_EN_CANCELACION')`,
      [coupon, promotion],
    );
    await admin.query(
      `INSERT INTO promotions.promotions(id,name,discount_type,discount_value,modality,state,valid_from,valid_until,priority,enabled_channels)
       VALUES ($1,'Combined automatic fixture','PORCENTAJE',5,'AUTOMATICA','ACTIVO','2026-10-01','2026-12-01',1,ARRAY['MARKETPLACE'])`,
      [automatic],
    );
    await admin.query(
      "INSERT INTO promotions.promotion_scopes(promotion_id,sku) VALUES ($1,'ELIGIBILITY-SKU')",
      [automatic],
    );
    await admin.query(
      'INSERT INTO promotions.combination_policy VALUES ($1,false,false,true)',
      [automatic],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  let mutate = (facts) => facts;
  let reads = 0;
  const source = {
    read: async ({ data }) => {
      reads++;
      return mutate({
        orderId: data.order_id,
        reservationId: data.reservation_id,
        commercialSnapshotRef: data.commercial_snapshot_ref,
        reservationConfirmed: true,
        snapshotDurable: true,
        couponCode: data.coupon_code,
        channelId: data.channel_id,
        customerRef: data.customer_ref ?? null,
        effectiveAt: data.effective_at,
        basket: {
          lines: [
            {
              sku: 'ELIGIBILITY-SKU',
              productId: 'ELIGIBILITY-PRODUCT',
              quantity: 1,
              regular: '100.00',
              offer: null,
              currency: 'PEN',
              active: true,
              channelEligible: true,
            },
          ],
        },
      });
    },
  };
  const processor = new CouponCommandProcessor(
    pool,
    new AuthoritativeCouponEvidence(source),
  );
  const input = () => command('ELIGIBILITY_FIXTURE');
  for (const change of [
    (f) => ({ ...f, reservationConfirmed: false }),
    (f) => ({ ...f, snapshotDurable: false }),
    (f) => ({ ...f, orderId: 'different-order' }),
    (f) => ({ ...f, reservationId: randomUUID() }),
    (f) => ({ ...f, commercialSnapshotRef: 'different-snapshot' }),
    (f) => ({ ...f, channelId: 'CHATBOT' }),
    (f) => ({ ...f, customerRef: randomUUID() }),
    (f) => ({ ...f, couponCode: 'OTHER' }),
    (f) => ({ ...f, effectiveAt: '2026-10-16T12:01:00Z' }),
    (f) => ({
      ...f,
      basket: {
        lines: f.basket.lines.map((l) => ({ ...l, regular: '99.99' })),
      },
    }),
    (f) => ({
      ...f,
      basket: {
        lines: f.basket.lines.map((l) => ({ ...l, sku: 'OUTSIDE-SCOPE' })),
      },
    }),
  ]) {
    mutate = change;
    const result = await processor.process(input(), 'modulo-ventas');
    assert.equal(result.data.result_code, 'COUPON_NOT_ELIGIBLE');
  }
  const malformed = input();
  mutate = (f) => ({
    ...f,
    basket: { lines: [{ ...f.basket.lines[0], quantity: 0 }] },
  });
  await assert.rejects(
    processor.process(malformed, 'modulo-ventas'),
    /COUPON_EVIDENCE_UNAVAILABLE/,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*) FROM promotions.coupon_command_receipts WHERE operation_id=$1',
        [malformed.operation_id],
      )
    ).rows[0].count,
    '0',
  );
  mutate = (f) => f;
  // The coupon may be selected alongside an earlier automatic campaign. The
  // principal campaign is not the identity of the coupon to consume.
  await admin.query('BEGIN');
  await admin.query('SET LOCAL ROLE po_promotions_owner');
  await admin.query(
    'UPDATE promotions.promotions SET discount_value=50 WHERE id=$1',
    [automatic],
  );
  await admin.query(
    'UPDATE promotions.combination_policy SET coupon=false WHERE promotion_id=$1',
    [automatic],
  );
  await admin.query('COMMIT');
  assert.equal(
    (await processor.process(input(), 'modulo-ventas')).data.result_code,
    'COUPON_NOT_ELIGIBLE',
  );
  await admin.query('BEGIN');
  await admin.query('SET LOCAL ROLE po_promotions_owner');
  await admin.query(
    'UPDATE promotions.promotions SET discount_value=5 WHERE id=$1',
    [automatic],
  );
  await admin.query(
    'UPDATE promotions.combination_policy SET coupon=true WHERE promotion_id=$1',
    [automatic],
  );
  await admin.query('COMMIT');
  // The existing SQL limit remains authoritative, even for independent orders
  // whose evidence/scope/minimum all pass concurrently.
  const attempts = await Promise.all(
    [input(), input()].map((c) => processor.process(c, 'modulo-ventas')),
  );
  assert.equal(attempts.filter((r) => r.name.endsWith('.completed')).length, 1);
  assert.equal(
    attempts.find((r) => r.name.endsWith('.rejected')).data.result_code,
    'COUPON_GLOBAL_LIMIT',
  );
  const completed = attempts.find((r) => r.name.endsWith('.completed'));
  const receipt = await admin.query(
    'SELECT request_payload FROM promotions.coupon_command_receipts WHERE operation_id=$1',
    [completed.operation_id],
  );
  const replay = command('ELIGIBILITY_FIXTURE', {
    operation_id: completed.operation_id,
    data: receipt.rows[0].request_payload,
  });
  const beforeReplay = reads;
  assert.deepEqual(await processor.process(replay, 'modulo-ventas'), completed);
  assert.equal(reads, beforeReplay);
  assert.equal(
    (
      await admin.query(
        'SELECT count(*) FROM promotions.coupon_uses WHERE coupon_id=$1',
        [coupon],
      )
    ).rows[0].count,
    '1',
  );
  const expectedResults = new Map();
  const handler = new CouponCommandDeliveryHandler(processor);
  const output = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(
    output.queue,
    'po.resultados.x',
    'promotions.coupon.#',
  );
  async function receive(receiver) {
    for (let i = 0; i < 100; i++) {
      const message = await receiver.get('po.promociones.q', { noAck: false });
      if (message) return message;
      await delay(25);
    }
    throw new Error('ELIGIBILITY_DELIVERY_TIMEOUT');
  }
  async function deliver(input, loseAck = false) {
    channel.publish(
      'po.comandos.x',
      input.name,
      Buffer.from(JSON.stringify(input)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: input.message_id,
        userId: 'guest',
      },
    );
    await channel.waitForConfirms();
    let receiver = await connection.createChannel();
    receiver.on('error', () => undefined);
    try {
      let message = await receive(receiver);
      assert.equal(message.properties.userId, 'guest'); // Explicit mapping for this disposable broker only.
      assert.equal(message.properties.messageId, input.message_id);
      if (loseAck) {
        await assert.rejects(
          handler.handle(message, 'modulo-ventas', () => {
            throw new Error('ELIGIBILITY_LOST_ACK');
          }),
          /ELIGIBILITY_LOST_ACK/,
        );
        const readsAfterCommit = reads;
        await receiver.close();
        receiver = await connection.createChannel();
        receiver.on('error', () => undefined);
        message = await receive(receiver);
        assert.equal(message.fields.redelivered, true);
        const result = await handler.handle(message, 'modulo-ventas', () =>
          receiver.ack(message),
        );
        assert.equal(
          reads,
          readsAfterCommit,
          'redelivery must not reload evidence',
        );
        expectedResults.set(result.message_id, result);
        return result;
      }
      let committedAtAck;
      const result = await handler.handle(message, 'modulo-ventas', () => {
        // A separate connection observes the durable receipt/Inbox/Outbox.
        committedAtAck = admin.query(
          `SELECT result_payload,
          (SELECT count(*)::int FROM promotions.inbox WHERE message_id=$2 AND completed_at IS NOT NULL) AS inbox,
          (SELECT count(*)::int FROM promotions.outbox WHERE operation_id=$1) AS outbox
          FROM promotions.coupon_command_receipts WHERE operation_id=$1`,
          [input.operation_id, input.message_id],
        );
        receiver.ack(message);
      });
      const row = (await committedAtAck).rows[0];
      assert.deepEqual(row.result_payload, result);
      assert.equal(row.inbox, 1);
      assert.equal(row.outbox, 1);
      expectedResults.set(result.message_id, result);
      return result;
    } finally {
      await receiver.close().catch(() => undefined);
    }
  }
  assert.equal((await deliver(restore(replay))).data.outcome, 'RESTORED');
  const brokerCommand = input();
  const brokerResult = await deliver(brokerCommand, true);
  assert.match(brokerResult.name, /consumption.completed$/);
  const verifiedReads = reads;
  assert.deepEqual(
    await deliver({ ...brokerCommand, message_id: randomUUID() }),
    brokerResult,
  );
  assert.equal(reads, verifiedReads);
  assert.equal(
    (await deliver(input())).data.result_code,
    'COUPON_GLOBAL_LIMIT',
  );
  const restored = await deliver(restore(brokerCommand));
  assert.equal(restored.data.outcome, 'RESTORED');
  const history = async () =>
    (
      await admin.query('SELECT * FROM promotions.coupon_uses WHERE id=$1', [
        brokerResult.data.consumption_id,
      ])
    ).rows[0];
  const savedHistory = await history();
  assert.equal(
    (await deliver(restore(brokerCommand))).data.outcome,
    'RESTORED',
  );
  assert.deepEqual(await history(), savedHistory);
  assert.match((await deliver(input())).name, /consumption.completed$/);
  assert.equal(
    (await deliver(input())).data.result_code,
    'COUPON_GLOBAL_LIMIT',
  );
  mutate = (f) => ({
    ...f,
    basket: { lines: f.basket.lines.map((l) => ({ ...l, regular: '99.99' })) },
  });
  assert.equal(
    (await deliver(input())).data.result_code,
    'COUPON_NOT_ELIGIBLE',
  );
  assert.deepEqual(
    (
      await admin.query(
        `SELECT count(*)::int AS total,
    count(*) FILTER (WHERE restored_at IS NULL)::int AS active FROM promotions.coupon_uses WHERE coupon_id=$1`,
        [coupon],
      )
    ).rows[0],
    { total: 3, active: 1 },
  );
  const outbox = new CouponOutbox(pool, new CouponAmqpPublisher(channel));
  for (let i = 0; i < 1000; i++) {
    const outcome = await outbox.publishOne();
    assert.notEqual(outcome, 'pending', 'real broker confirms required');
    if (outcome === 'empty') break;
    if (i === 999) throw new Error('ELIGIBILITY_OUTBOX_DRAIN_LIMIT');
  }
  const pending = new Map(expectedResults);
  for (let i = 0; i < 200 && pending.size; i++) {
    const message = await channel.get(output.queue, { noAck: true });
    if (!message) {
      await delay(25);
      continue;
    }
    const result = JSON.parse(message.content);
    if (pending.has(result.message_id)) {
      assert.deepEqual(result, pending.get(result.message_id));
      assert.equal(message.properties.deliveryMode, 2);
      pending.delete(result.message_id);
    }
  }
  assert.equal(
    pending.size,
    0,
    'all durable results arrive unchanged through real RabbitMQ',
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int AS count FROM promotions.outbox WHERE published_at IS NULL',
      )
    ).rows[0].count,
    0,
  );
  return [
    'combined authoritative coupon eligibility: automatic principal and actual coupon remain distinct; a winning compatible coupon consumes once while a losing exclusive coupon is rejected',
    'authoritative eligibility: durable identities, scope, exact minimum, malformed facts rollback, concurrent last use and replay without evidence reload',
    'authoritative evidence through real AMQP/PG: consume and restore; lost ACK/redelivery and fresh-message replay preserve one use and result without loading evidence again',
    'real AMQP results match durable Outbox payloads with broker confirms; ACK observes committed receipt/Inbox/Outbox; distinct restorations preserve history and free the last slot only once',
  ];
}
