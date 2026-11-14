import { randomUUID } from 'node:crypto';
import {
  InvalidCatalogMessage,
  parseCatalogMessage,
} from './catalog-messages.js';
import { taxonomyUpdate } from './catalog-taxonomy-update.js';

const facts = [
  {
    name: 'taxonomy.category.updated',
    data: { categoria_id: 'category-1', version: 0 },
  },
  ...[
    'CHARACTERISTIC_ASSOCIATED',
    'REQUIRED_CHANGED',
    'CHARACTERISTIC_DISASSOCIATED',
  ].map((change_type) => ({
    name: 'taxonomy.product-type-schema.changed',
    data: {
      tipo_producto_id: 'type-1',
      schema_version: 3,
      change_type,
      caracteristica_id: 'characteristic-1',
      updated_at: '2026-11-13T10:00:00.123456Z',
    },
  })),
  {
    name: 'taxonomy.characteristic-value.updated',
    data: {
      caracteristica_id: 'characteristic-1',
      valor_id: 'value-1',
      nombre: 'Azul marino',
      change_type: 'RENAMED',
      updated_at: '2026-11-13T10:00:00.123456+00:00',
    },
  },
];
function envelope(fact = facts[0]!) {
  return {
    message_id: randomUUID(),
    correlation_id: randomUUID(),
    schema_version: 1,
    occurred_at: '2026-11-13T10:00:01Z',
    producer: 'taxonomy-svc',
    kind: 'event',
    ...fact,
  };
}
describe('Taxonomy producer contract consumed by Catalog (#48)', () => {
  it.each(facts)('accepts the actual producer shape $name', (fact) => {
    const value = envelope(fact);
    expect(parseCatalogMessage(value)).toBe(value);
  });
  it.each(facts)(
    'rejects missing data for $name before persistence',
    (fact) => {
      expect(() =>
        parseCatalogMessage({ ...envelope(fact), data: {} }),
      ).toThrow(InvalidCatalogMessage);
    },
  );
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', null])(
    'rejects an invalid category revision %s',
    (version) => {
      expect(() =>
        parseCatalogMessage({
          ...envelope(),
          data: { categoria_id: 'c', version },
        }),
      ).toThrow(InvalidCatalogMessage);
    },
  );
  it('does not confuse envelope and domain schema versions', () => {
    const message = envelope(facts[1]!);
    expect(parseCatalogMessage(message).data.schema_version).toBe(3);
    expect(() =>
      parseCatalogMessage({ ...message, schema_version: 3 }),
    ).toThrow(InvalidCatalogMessage);
  });
  it('keeps PostgreSQL microsecond ordering, including timezone equivalence', () => {
    const fact = facts[4]!;
    const first = taxonomyUpdate(fact.name, fact.data)!;
    expect(
      taxonomyUpdate(fact.name, {
        ...fact.data,
        updated_at: '2026-11-13T05:00:00.123456-05:00',
      })!.revision,
    ).toBe(first.revision);
    expect(
      taxonomyUpdate(fact.name, {
        ...fact.data,
        updated_at: '2026-11-13T10:00:00.123457Z',
      })!.revision,
    ).toBe(first.revision + 1n);
  });
  it.each(['', '2026-11-13', 'yesterday', '2026-11-13T10:00:00'])(
    'rejects an unordered value timestamp %s',
    (updated_at) => {
      expect(() =>
        parseCatalogMessage({
          ...envelope(facts[4]!),
          data: { ...facts[4]!.data, updated_at },
        }),
      ).toThrow(InvalidCatalogMessage);
    },
  );
});
