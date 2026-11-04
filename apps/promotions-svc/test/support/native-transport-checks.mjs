import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeCouponResources } from '../../../../dist/apps/promotions-svc/coupons/coupon-providers.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../../../../dist/apps/promotions-svc/infrastructure/config/promotions-config.js';

// Called only with the disposable broker owned by coupons.isolated.smoke.mjs.
// Exercises the production transport factory without enabling CouponRuntime.
export async function verifyNativeTransport({
  brokerPort,
  brokerContainer,
  channel,
  resultsQueue,
  docker,
}) {
  const directory = mkdtempSync(join(tmpdir(), 'g6-transport-fixture-'));
  const certificate = join(directory, 'root.crt');
  writeFileSync(certificate, rootCertificates[0]);
  const resources = nativeCouponResources(
    new PromotionsConfigService(
      validatePromotionsConfiguration({
        NODE_ENV: 'test',
        PGHOST: '127.0.0.1',
        PGPORT: '1',
        PGDATABASE: 'unused_transport_fixture',
        PGUSER: 'unused_transport_fixture',
        PGPASSWORD: randomUUID(),
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: certificate,
        G6_DATABASE_SCHEMA: 'promotions',
        G6_CONNECTION_MODE: 'session',
        RABBITMQ_URL: `amqp://guest:guest@127.0.0.1:${brokerPort}/%2F`,
        PROMOTIONS_COUPON_RUNTIME_ENABLED: 'false',
        PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'false',
      }),
    ),
  );
  const result = () => ({
    message_id: randomUUID(),
    schema_version: 2,
    operation_id: randomUUID(),
    occurred_at: '2026-10-16T12:00:00Z',
    correlation_id: 'isolated-native-transport',
    causation_id: 'isolated-restoration',
    producer: 'promotions-svc',
    kind: 'result',
    name: 'promotions.coupon.restoration.completed',
    data: {
      order_id: 'ISOLATED-TRANSPORT',
      restored: false,
      outcome: 'NO_CONSUMPTION',
      completed_at: '2026-10-16T12:00:00Z',
    },
  });
  const queue = 'native-transport-' + randomUUID();
  const rejectQueue = queue + '-confirms';
  const connections = () =>
    docker([
      'exec',
      brokerContainer,
      'rabbitmqctl',
      '-q',
      'list_connections',
      'pid',
    ])
      .split(/\r?\n/)
      .map((line) => line.trim())
      // The JSON formatter wraps Erlang PIDs; close_connection requires this
      // textual representation rather than Pid(#PID<...>).
      .filter((line) => /^<[^>]+>$/.test(line));
  async function until(read) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const value = await read();
      if (value) return value;
      await delay(100);
    }
    assert.fail('native transport fixture timed out');
  }
  let consumer;
  let routingRemoved = false;
  let queueCreated = false;
  let rejectQueueCreated = false;
  let stage = 'publisher baseline';
  try {
    const before = connections();
    stage = 'native publisher confirm';
    const first = result();
    await resources.publisher.publishConfirmed(first);
    const delivered = await until(() =>
      channel.get(resultsQueue, { noAck: true }),
    );
    assert.equal(delivered.properties.messageId, first.message_id);
    assert.equal(delivered.properties.deliveryMode, 2);
    assert.deepEqual(JSON.parse(delivered.content), first);

    stage = 'mandatory return';
    await channel.unbindQueue(
      resultsQueue,
      'po.resultados.x',
      'promotions.coupon.#',
    );
    routingRemoved = true;
    await assert.rejects(
      resources.publisher.publishConfirmed(result()),
      /PUBLISH_NOT_CONFIRMED/,
    );
    stage = 'broker publisher nack';
    await channel.assertQueue(rejectQueue, {
      durable: false,
      arguments: { 'x-max-length': 1, 'x-overflow': 'reject-publish' },
    });
    rejectQueueCreated = true;
    await channel.bindQueue(
      rejectQueue,
      'po.resultados.x',
      'promotions.coupon.#',
    );
    await resources.publisher.publishConfirmed(result());
    await assert.rejects(
      resources.publisher.publishConfirmed(result()),
      /PUBLISH_NOT_CONFIRMED/,
    );
    assert.equal((await channel.checkQueue(rejectQueue)).messageCount, 1);
    await channel.deleteQueue(rejectQueue);
    rejectQueueCreated = false;
    await channel.bindQueue(
      resultsQueue,
      'po.resultados.x',
      'promotions.coupon.#',
    );
    routingRemoved = false;

    stage = 'publisher connection interruption';
    const publisherPids = connections().filter((pid) => !before.includes(pid));
    assert.equal(publisherPids.length, 1);
    docker([
      'exec',
      brokerContainer,
      'rabbitmqctl',
      'close_connection',
      publisherPids[0],
      'isolated publisher interruption',
    ]);
    // The factory clears a closed connection; the next requested publication
    // reconnects. No automatic consumer recovery/retry policy is introduced.
    await delay(100);
    stage = 'native publisher reconnect';
    const recovered = result();
    await resources.publisher.publishConfirmed(recovered);
    const recoveredDelivery = await until(() =>
      channel.get(resultsQueue, { noAck: true }),
    );
    assert.equal(recoveredDelivery.properties.messageId, recovered.message_id);
    const after = connections().filter((pid) => !before.includes(pid));
    assert.equal(after.length, 1);
    assert.notEqual(after[0], publisherPids[0]);

    stage = 'native consumer nack and ack';
    await channel.assertQueue(queue, { durable: false });
    queueCreated = true;
    consumer = await resources.openConsumerChannel();
    await consumer.prefetch(1);
    const deliveries = [];
    const subscription = await consumer.consume(
      queue,
      (message) => {
        if (message) deliveries.push(message);
      },
      { noAck: false },
    );
    channel.sendToQueue(queue, Buffer.from('isolated nack/requeue'));
    await channel.waitForConfirms();
    await until(() => deliveries.length === 1);
    consumer.nack(deliveries[0], false, true);
    await until(() => deliveries.length === 2);
    assert.equal(deliveries[1].fields.redelivered, true);
    consumer.ack(deliveries[1]);
    await consumer.cancel(subscription.consumerTag);
    const empty = await channel.checkQueue(queue);
    assert.equal(empty.messageCount, 0);
    assert.equal(empty.consumerCount, 0);
    await consumer.close();
    consumer = undefined;
    return [
      'native amqplib publisher confirms persistent results and rejects mandatory returns',
      'real broker publisher NACK from an overflowing fixture queue remains unconfirmed',
      'native publisher replaces a broker-closed connection on the next publish without enabling runtime',
      'native consumer channel NACK/requeue delivers again and ACK/cancel leaves no messages or consumers',
    ];
  } catch (error) {
    // Fixed fixture stage only: never forward URLs or raw driver diagnostics.
    console.error('NATIVE_TRANSPORT_CHECK_FAILED: ' + stage);
    throw error;
  } finally {
    if (routingRemoved)
      await channel.bindQueue(
        resultsQueue,
        'po.resultados.x',
        'promotions.coupon.#',
      );
    await consumer?.close().catch(() => undefined);
    if (queueCreated) await channel.deleteQueue(queue).catch(() => undefined);
    if (rejectQueueCreated)
      await channel.deleteQueue(rejectQueue).catch(() => undefined);
    await resources.onApplicationShutdown();
    unlinkSync(certificate);
    rmdirSync(directory);
  }
}
