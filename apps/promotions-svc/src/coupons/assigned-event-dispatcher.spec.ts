import {
  PromotionsAssignedEventDispatcher,
  blockedBrokerIdentity,
  type AssignedEventAdapter,
  type AssignedEventAdapters,
} from './assigned-event-dispatcher.js';
import {
  assignedEventContracts,
  promotionsBrokerBinding,
} from './event-contract.generated.js';
import type { BrokerDelivery } from './coupon-consumer.js';
import type { SqlPool } from '../infrastructure/persistence/sql-transaction.js';

const event = () => ({
  message_id: 'assigned-message',
  schema_version: 1,
  occurred_at: '2026-10-23T12:00:00Z',
  correlation_id: 'trace',
  causation_id: 'cause',
  producer: 'catalog-svc',
  kind: 'event',
  name: 'catalog.product.deactivated',
  data: {},
});
function delivery(changes: Partial<BrokerDelivery> = {}): BrokerDelivery {
  const body = event();
  return {
    content: Buffer.from(JSON.stringify(body)),
    fields: { exchange: 'po.eventos.x', routingKey: body.name },
    properties: { contentType: 'application/json', messageId: body.message_id },
    ...changes,
  };
}
function fixture(fresh = true, complete = true) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    calls.push(sql);
    if (sql.includes('fn_begin_inbox')) return { rows: [{ fresh }] };
    if (sql.startsWith('SELECT completed_at'))
      return {
        rows: [
          {
            completed_at: complete ? new Date() : null,
            result: complete ? { handled: true } : null,
          },
        ],
      };
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const pool: SqlPool = { connect };
  const apply = vi.fn(async () => {
    calls.push('APPLY');
  });
  const adapter: AssignedEventAdapter = { validate: () => true, apply };
  const adapters: AssignedEventAdapters = Object.fromEntries(
    Object.keys(assignedEventContracts).map((name) => [name, adapter]),
  );
  return {
    dispatcher: new PromotionsAssignedEventDispatcher(pool, adapters),
    pool,
    adapter,
    query,
    apply,
    calls,
    connect,
    release,
  };
}
describe('Promotions assigned event dispatch #75', () => {
  it('pins all six bindings and the four incoming events to the normative rc.3 topology', () => {
    expect(promotionsBrokerBinding.queue).toBe('po.promociones.q');
    expect(promotionsBrokerBinding.prefetch).toBe(20);
    expect(promotionsBrokerBinding.bindings).toHaveLength(6);
    expect(Object.keys(assignedEventContracts).sort()).toEqual([
      'catalog.product.deactivated',
      'catalog.sku.deactivated',
      'inventory.stock.changed',
      'pricing.price.changed',
    ]);
    expect(
      Object.values(assignedEventContracts).every(
        (c) => c.exchange === 'po.eventos.x',
      ),
    ).toBe(true);
  });
  it('requires every adapter and explicit authenticated broker identity before activation', async () => {
    const f = fixture();
    expect(() => f.dispatcher.assertReady()).not.toThrow();
    expect(() =>
      new PromotionsAssignedEventDispatcher(f.pool, {}).assertReady(),
    ).toThrow('PROMOTIONS_EVENT_ADAPTERS_UNAVAILABLE');
    await expect(blockedBrokerIdentity.assertReady()).rejects.toThrow(
      'PROMOTIONS_BROKER_IDENTITY_UNAVAILABLE',
    );
    await expect(blockedBrokerIdentity.actor(delivery())).rejects.toThrow(
      'PROMOTIONS_BROKER_IDENTITY_UNAVAILABLE',
    );
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('commits adapter changes and Inbox completion before reporting success', async () => {
    const f = fixture();
    await expect(f.dispatcher.process(delivery(), 'catalog-svc')).resolves.toBe(
      'processed',
    );
    expect(f.calls.indexOf('APPLY')).toBeGreaterThan(
      f.calls.findIndex((c) => c.includes('fn_begin_inbox')),
    );
    expect(f.calls.at(-1)).toBe('COMMIT');
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('replays a completed Inbox without applying the adapter twice', async () => {
    const f = fixture(false);
    await expect(f.dispatcher.process(delivery(), 'catalog-svc')).resolves.toBe(
      'replayed',
    );
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.calls.at(-1)).toBe('COMMIT');
  });
  it('never turns an incomplete Inbox into an ACK-able success', async () => {
    const f = fixture(false, false);
    await expect(
      f.dispatcher.process(delivery(), 'catalog-svc'),
    ).rejects.toThrow('PROMOTIONS_ASSIGNED_EVENT_FAILED');
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.calls.at(-1)).toBe('ROLLBACK');
  });
  it('rolls back adapter failure without exposing driver diagnostics', async () => {
    const f = fixture();
    f.apply.mockRejectedValueOnce(new Error('private-value'));
    await expect(
      f.dispatcher.process(delivery(), 'catalog-svc'),
    ).rejects.toThrow('PROMOTIONS_ASSIGNED_EVENT_FAILED');
    expect(f.calls.at(-1)).toBe('ROLLBACK');
  });
  it('does not record or drop an event whose GenericData adapter is unavailable', async () => {
    const f = fixture();
    await expect(
      new PromotionsAssignedEventDispatcher(f.pool, {}).process(
        delivery(),
        'catalog-svc',
      ),
    ).rejects.toThrow('PROMOTIONS_EVENT_ADAPTER_UNAVAILABLE');
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('requires adapter-level data validation beyond the generic envelope schema', async () => {
    const f = fixture();
    const adapter = { ...f.adapter, validate: () => false };
    await expect(
      new PromotionsAssignedEventDispatcher(f.pool, {
        'catalog.product.deactivated': adapter,
      }).process(delivery(), 'catalog-svc'),
    ).rejects.toThrow('INVALID_ASSIGNED_EVENT_DATA');
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([
    { content: Buffer.from('{broken') },
    { content: Buffer.from([0xff]) },
    { content: Buffer.alloc(65537) },
    { properties: { contentType: 'text/plain' } },
    { properties: { contentType: 'application/json', messageId: 'mismatch' } },
    {
      fields: {
        exchange: 'po.commands.x',
        routingKey: 'catalog.product.deactivated',
      },
    },
    {
      fields: { exchange: 'po.eventos.x', routingKey: 'pricing.price.changed' },
    },
    {
      content: Buffer.from(
        JSON.stringify({ ...event(), producer: 'pricing-svc' }),
      ),
    },
    {
      content: Buffer.from(
        JSON.stringify({ ...event(), name: 'unknown.event' }),
      ),
    },
    { content: Buffer.from(JSON.stringify({ ...event(), data: [] })) },
  ])(
    'rejects malformed/misrouted events before DB access %#',
    async (changes) => {
      const f = fixture();
      await expect(
        f.dispatcher.process(delivery(changes), 'catalog-svc'),
      ).rejects.toThrow('INVALID_ASSIGNED_EVENT');
      expect(f.connect).not.toHaveBeenCalled();
    },
  );
  it('checks authenticated producer independently of body and userId claims', async () => {
    const f = fixture();
    await expect(
      f.dispatcher.process(delivery(), 'modulo-ventas'),
    ).rejects.toThrow('INVALID_ASSIGNED_EVENT');
    expect(f.connect).not.toHaveBeenCalled();
  });
});
