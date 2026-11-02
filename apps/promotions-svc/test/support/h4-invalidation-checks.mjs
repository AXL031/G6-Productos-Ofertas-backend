import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PromotionsAssignedEventDispatcher } from '../../../../dist/apps/promotions-svc/coupons/assigned-event-dispatcher.js';
import { h4EventAdapters } from '../../../../dist/apps/promotions-svc/coupons/h4-event-adapters.js';
import { assignedH4Contracts } from '../../../../dist/apps/promotions-svc/coupons/assigned-h4-contract.generated.js';
import { PromotionsPersistence } from '../../../../dist/apps/promotions-svc/infrastructure/persistence/promotions-persistence.js';

export async function verifyH4Invalidations(pool) {
  const persistence = new PromotionsPersistence(pool);
  const dispatcher = new PromotionsAssignedEventDispatcher(
    pool,
    h4EventAdapters,
    assignedH4Contracts,
    true,
  );
  dispatcher.assertReady();
  const sku = 'H4-0001';
  const sibling = 'H4-OTHER';
  const rejectedSku = 'H4-REJECTED';
  await pool.query(
    "INSERT INTO promotions.price_projection(sku,channel_id,snapshot,source_version,source_occurred_at,source_message_id) VALUES ($1,'MARKETPLACE','{}',99,'2026-10-01','h4-price-fixture')",
    [sku],
  );
  await pool.query(
    "INSERT INTO promotions.stock_projection(sku,availability,snapshot,source_version,source_occurred_at,source_message_id) VALUES ($1,'DISPONIBLE','{}',99,'2026-10-01','h4-stock-fixture')",
    [sku],
  );
  for (const [id, channel] of [
    [sku, null],
    [sku, 'RETAIL'],
    [sibling, 'MARKETPLACE'],
    [sibling, 'RETAIL'],
  ]) {
    await pool.query(
      "INSERT INTO promotions.price_projection(sku,channel_id,snapshot,source_version,source_occurred_at,source_message_id) VALUES ($1,$2,'{}',99,'2026-10-01',$3)",
      [id, channel, randomUUID()],
    );
  }
  await pool.query(
    "INSERT INTO promotions.stock_projection(sku,availability,snapshot,source_version,source_occurred_at,source_message_id) VALUES ($1,'DISPONIBLE','{}',99,'2026-10-01','h4-rejected-stock-fixture')",
    [rejectedSku],
  );
  assert.ok(await persistence.read((r) => r.price(sku, 'MARKETPLACE')));
  assert.ok(await persistence.read((r) => r.stock(sku)));
  const handler = 'promotions-assigned-events-v1';
  async function process(name, data, version, expected = 'processed') {
    const contract = assignedH4Contracts[name];
    const event = {
      message_id: randomUUID(),
      schema_version: version,
      occurred_at: '2026-11-01T00:00:00Z',
      correlation_id: 'h4-fixture',
      producer: contract.producer,
      kind: 'event',
      name,
      data,
    };
    const delivery = {
      content: Buffer.from(JSON.stringify(event)),
      fields: { exchange: contract.exchange, routingKey: contract.routingKey },
      properties: {
        contentType: 'application/json',
        messageId: event.message_id,
      },
    };
    assert.equal(
      await dispatcher.process(delivery, contract.producer),
      expected,
    );
    assert.equal(
      await dispatcher.process(delivery, contract.producer),
      'replayed',
    );
    const receipt = await persistence.read((r) =>
      r.inbox(event.message_id, handler),
    );
    assert.ok(receipt.completedAt);
    assert.equal(receipt.result.handled, expected !== 'rejected');
    return { ...receipt.result, messageId: event.message_id };
  }
  const price = {
    target_type: 'SKU',
    product_id: 'H4-P',
    sku,
    channel_id: 'MARKETPLACE',
    currency: 'PEN',
    price_type: 'REGULAR',
    previous_price: null,
    new_price: '19.90',
    operation: 'CREACION',
    reason: 'INITIAL',
    price_version: 1,
    valid_from: '2026-11-01T00:00:00Z',
    batch_id: null,
    actor: { user_id: null, email: null, ip: null },
  };
  const result = await process('pricing.price.changed', price, 1);
  assert.equal(result.invalidation.sourceVersion, '1');
  assert.equal(
    await persistence.read((r) => r.price(sku, 'MARKETPLACE')),
    undefined,
  );
  assert.ok(await persistence.read((r) => r.price(sku, null)));
  assert.ok(await persistence.read((r) => r.price(sku, 'RETAIL')));
  assert.ok(await persistence.read((r) => r.price(sibling, 'MARKETPLACE')));

  // Receipt lookup never consumes or clears the durable invalidation.
  const beforeInbox = await persistence.read((r) =>
    r.inbox(result.messageId, handler),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(
      await persistence.read((r) => r.inbox(result.messageId, handler)),
      beforeInbox,
    );
  }
  assert.equal(
    await persistence.read((r) => r.price(sku, 'MARKETPLACE')),
    undefined,
  );

  // Without a complete product→SKU map a PRODUCTO marker covers its whole
  // channel, including unrelated cached SKUs. A null channel covers all channels.
  await process(
    'pricing.price.changed',
    { ...price, target_type: 'PRODUCTO', sku: null },
    1,
  );
  assert.equal(
    await persistence.read((r) => r.price(sibling, 'MARKETPLACE')),
    undefined,
  );
  assert.ok(await persistence.read((r) => r.price(sibling, 'RETAIL')));
  await process('pricing.price.changed', { ...price, channel_id: null }, 1);
  assert.equal(await persistence.read((r) => r.price(sku, null)), undefined);
  assert.equal(
    await persistence.read((r) => r.price(sku, 'RETAIL')),
    undefined,
  );
  assert.ok(await persistence.read((r) => r.price(sibling, 'RETAIL')));
  await process(
    'pricing.price.changed',
    { ...price, target_type: 'PRODUCTO', sku: null, channel_id: null },
    1,
  );
  assert.equal(await persistence.read((r) => r.price(sibling, 'RETAIL')), undefined);
  const stock = {
    sku,
    location_id: randomUUID(),
    on_hand: 12,
    reserved: 2,
    blocked: 1,
    available: 9,
    estado: 'DISPONIBLE',
    stock_version: 3,
    updated_at: '2026-11-01T00:00:00Z',
  };
  const invalidation = await process('inventory.stock.changed', stock, 2);
  assert.equal(invalidation.invalidation.locationId, stock.location_id);
  assert.equal(invalidation.invalidation.sourceVersion, '3');
  assert.equal(await persistence.read((r) => r.stock(sku)), undefined);
  const rows = await pool.query(
    'SELECT availability,source_version::text FROM promotions.stock_projection WHERE sku=$1',
    [sku],
  );
  assert.deepEqual(rows.rows[0], {
    availability: 'DISPONIBLE',
    source_version: '99',
  });
  const otherLocation = await process(
    'inventory.stock.changed',
    { ...stock, location_id: randomUUID(), stock_version: 1 },
    2,
  );
  assert.notEqual(otherLocation.invalidation.locationId, stock.location_id);
  assert.equal(otherLocation.invalidation.sourceVersion, '1');
  assert.equal(await persistence.read((r) => r.stock(sku)), undefined);

  // A later cached projection is still unusable. There is no refresh watermark
  // or recovery writer approved here; a new repository instance sees Inbox too.
  for (const table of ['price_projection', 'stock_projection']) {
    await pool.query(
      `UPDATE promotions.${table} SET source_version=100,source_occurred_at='2026-11-02',source_message_id=$2 WHERE sku=$1`,
      [sku, randomUUID()],
    );
  }
  const reopened = new PromotionsPersistence(pool);
  assert.equal(
    await reopened.read((r) => r.price(sku, 'MARKETPLACE')),
    undefined,
  );
  assert.equal(await reopened.read((r) => r.stock(sku)), undefined);
  const beforeStockInbox = await reopened.read((r) =>
    r.inbox(invalidation.messageId, handler),
  );
  assert.deepEqual(
    await reopened.read((r) => r.inbox(invalidation.messageId, handler)),
    beforeStockInbox,
  );
  assert.equal(await reopened.read((r) => r.stock(sku)), undefined);
  const rejected = await process(
    'inventory.stock.changed',
    { ...stock, sku: rejectedSku, stock_version: 0 },
    2,
    'rejected',
  );
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.reason, 'INVALID_ASSIGNED_EVENT_DATA');
  assert.equal('invalidation' in rejected, false);
  assert.ok(await reopened.read((r) => r.stock(rejectedSku)));
  await process(
    'catalog.product.deactivated',
    {
      product_id: 'H4-P',
      product_version: 5,
      changed_at: '2026-11-01T00:00:00Z',
    },
    1,
  );
  await process(
    'catalog.sku.deactivated',
    {
      product_id: 'H4-P',
      sku,
      sku_version: 2,
      changed_at: '2026-11-01T00:00:00Z',
    },
    1,
  );
  const projected = await persistence.read((r) => r.catalog('SKU', sku));
  assert.equal(projected.active, false);
  assert.equal(projected.sourceVersion, 2n);
  return [
    'H4 rc.4 real restricted PostgreSQL: four typed events, durable channel/location invalidation, local versions without commercial snapshot reconstruction, duplicate replay and invalid-data rejection recorded atomically before ACK eligibility',
    'PR143 invalidation scope: SKU/channel, global channel, conservative PRODUCTO/channel and per-location stock versions; rejected data does not invalidate another cached SKU',
    'PR143 recovery boundary: receipt SELECTs and a new persistence instance preserve markers; later cached projection versions do not clear them or restore stale availability/prices',
  ];
}
