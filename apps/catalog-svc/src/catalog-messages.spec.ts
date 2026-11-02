import { randomUUID } from 'node:crypto';
import {
  activeAttempt,
  envelope,
  InvalidCatalogMessage,
  manualRetryAllowed,
  parseCatalogMessage,
  preparationTimeout,
} from './catalog-messages.js';

describe('Catalog preparation message contract and retry identity', () => {
  const result = () => ({
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
  });
  it('validates typed results and preserves SKU identity', () => {
    expect(parseCatalogMessage(result()).data.sku).toBe('0000123');
  });
  it('validates all typed master identities without assigning an entity ID format', () => {
    for (const entity_type of [
      'CATEGORY',
      'BRAND',
      'PRODUCT_TYPE',
      'CHARACTERISTIC_VALUE',
      'PRODUCT_TYPE_CHARACTERISTIC',
    ]) {
      const message = {
        ...result(),
        producer: 'taxonomy-svc',
        kind: 'command',
        name: 'taxonomy.master.deactivation.check.requested',
        data: {
          entity_type,
          entity_id: 'opaque / 000',
          version: 7,
          ...(entity_type === 'PRODUCT_TYPE_CHARACTERISTIC'
            ? {
                tipo_producto_id: 'type / 000',
                caracteristica_id: 'char / 000',
              }
            : {}),
        },
      };
      expect(parseCatalogMessage(message).data.entity_id).toBe('opaque / 000');
      for (const patch of [
        { version: null },
        { version: -1 },
        { version: 1.5 },
        { entity_id: '' },
        { entity_type: 'CHARACTERISTIC' },
      ])
        expect(() =>
          parseCatalogMessage({
            ...message,
            data: { ...message.data, ...patch },
          }),
        ).toThrow(InvalidCatalogMessage);
      expect(() =>
        parseCatalogMessage({ ...message, operation_id: null }),
      ).toThrow(InvalidCatalogMessage);
      expect(
        parseCatalogMessage({
          ...message,
          kind: 'result',
          name: 'taxonomy.master.deactivation.rejected',
          data: { ...message.data, reason: 'TIMEOUT' },
        }).kind,
      ).toBe('result');
      for (const result of ['CLEAR', 'IN_USE'])
        expect(
          envelope(
            'catalog.master.deactivation.checked',
            { ...message.data, result },
            message.correlation_id,
            message.operation_id,
          ).data,
        ).toEqual({ ...message.data, result });
    }
  });
  it.each([
    { schema_version: 2 },
    { producer: 'pricing-svc' },
    { operation_id: null },
    { causation_id: null },
    { kind: 'event' },
    {
      data: {
        product_id: 'p',
        sku: '000',
        status: 'READY',
        completed_at: 'bad-time',
      },
    },
  ])('rejects invalid result envelope or payload %j', (patch) => {
    expect(() => parseCatalogMessage({ ...result(), ...patch })).toThrow(
      InvalidCatalogMessage,
    );
  });
  it('requires association coordinates and distinguishes captured business version from the resulting version', () => {
    const message = {
      ...result(),
      producer: 'taxonomy-svc',
      kind: 'command',
      name: 'taxonomy.master.deactivation.check.requested',
      data: {
        entity_type: 'PRODUCT_TYPE_CHARACTERISTIC',
        entity_id: 'opaque-association',
        version: 7,
        tipo_producto_id: 'type',
        caracteristica_id: 'characteristic',
      },
    };
    for (const patch of [
      { tipo_producto_id: undefined },
      { caracteristica_id: undefined },
      { tipo_producto_id: '' },
      { caracteristica_id: 123 },
    ])
      expect(() =>
        parseCatalogMessage({
          ...message,
          data: { ...message.data, ...patch },
        }),
      ).toThrow(InvalidCatalogMessage);
    const final = {
      ...message,
      kind: 'event',
      name: 'taxonomy.master.deactivated',
    };
    for (const schema_version_resultante of [undefined, null, 6, 7, 1.5])
      expect(() =>
        parseCatalogMessage({
          ...final,
          data: { ...final.data, schema_version_resultante },
        }),
      ).toThrow(InvalidCatalogMessage);
    expect(
      parseCatalogMessage({
        ...final,
        data: { ...final.data, schema_version_resultante: 9 },
      }).data.version,
    ).toBe(7);
    expect(
      envelope(
        'catalog.master.deactivation.checked',
        { ...message.data, result: 'IN_USE' },
        message.correlation_id,
        message.operation_id,
      ).data.result,
    ).toBe('IN_USE');
    expect(() =>
      envelope(
        'catalog.master.deactivation.checked',
        { ...message.data, result: 'HAS_ACTIVE_PRODUCTS' },
        message.correlation_id,
        message.operation_id,
      ),
    ).toThrow(InvalidCatalogMessage);
  });
  it.each([
    'HAS_ACTIVE_PRODUCTS',
    'in_use',
    '',
    null,
    undefined,
    1,
    ['CLEAR'],
    ['IN_USE'],
    {},
  ])('rejects an uncontracted master check result %j', (result) => {
    expect(() =>
      envelope(
        'catalog.master.deactivation.checked',
        { entity_type: 'CATEGORY', entity_id: 'opaque', version: 7, result },
        randomUUID(),
        randomUUID(),
      ),
    ).toThrow(InvalidCatalogMessage);
  });
  it('accepts business rejection as a typed result, without interpreting it as a technical error', () => {
    const message = result();
    message.name = 'inventory.sku.initialization.rejected';
    message.data.status = 'REJECTED';
    expect(parseCatalogMessage(message).data.status).toBe('REJECTED');
  });
  it('reconstructs the unique active attempt from persisted causal links regardless of row order', () => {
    const first = {
      message_id: randomUUID(),
      causation_id: null,
      published_at: new Date(0),
      occurred_at: new Date(0),
    };
    const second = {
      ...first,
      message_id: randomUUID(),
      causation_id: first.message_id,
      published_at: null,
    };
    expect(activeAttempt([second, first])).toBe(second);
    expect(manualRetryAllowed('PENDING', second, 1, 100)).toBe(false);
    expect(manualRetryAllowed('PENDING', first, 50, 100)).toBe(true);
    expect(manualRetryAllowed('COMPLETED', first, 1, 100)).toBe(false);
    expect(manualRetryAllowed('REJECTED', first, 1, 100)).toBe(false);
  });
  it('fails closed on branched, missing or cyclic attempt history', () => {
    const first = {
      message_id: 'a',
      causation_id: null,
      published_at: null,
      occurred_at: new Date(),
    };
    const child = { ...first, message_id: 'b', causation_id: 'a' };
    expect(() =>
      activeAttempt([first, child, { ...child, message_id: 'c' }]),
    ).toThrow();
    expect(() =>
      activeAttempt([first, { ...child, causation_id: 'missing' }]),
    ).toThrow();
    expect(() =>
      activeAttempt([{ ...first, causation_id: 'b' }, child]),
    ).toThrow();
  });
  it('does not invent an operational timeout or a reactivation event', () => {
    expect(preparationTimeout({})).toBeUndefined();
    expect(() =>
      preparationTimeout({ CATALOG_PREPARATION_TIMEOUT_MS: '-1' }),
    ).toThrow();
    expect(() =>
      envelope('catalog.product.reactivated', {}, randomUUID()),
    ).toThrow();
  });
  it('uses the approved five minute threshold from confirmed publication only', () => {
    const timeout = preparationTimeout({
      CATALOG_PREPARATION_TIMEOUT_MS: '300000',
    });
    expect(timeout).toBe(300000);
    const attempt = {
      message_id: randomUUID(),
      causation_id: null,
      published_at: new Date(1000),
      occurred_at: new Date(0),
    };
    expect(manualRetryAllowed('PENDING', attempt, timeout, 300999)).toBe(false);
    expect(manualRetryAllowed('PENDING', attempt, timeout, 301000)).toBe(true);
    expect(
      manualRetryAllowed(
        'PENDING',
        { ...attempt, published_at: null },
        timeout,
        999999,
      ),
    ).toBe(false);
    expect(manualRetryAllowed('PENDING', attempt, undefined, 999999)).toBe(
      false,
    );
    for (const state of ['REJECTED', 'COMPLETED'])
      expect(manualRetryAllowed(state, attempt, timeout, 999999)).toBe(false);
  });
});
