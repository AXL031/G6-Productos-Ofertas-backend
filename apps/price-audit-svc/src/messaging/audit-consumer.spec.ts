import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ConsumeMessage } from 'amqplib';
import { AuditConsumer, decodeEnvelope } from './audit-consumer.js';
import type { AuditRepository } from '../persistence/audit.repository.js';
import type { AuditConfig } from '../config/environment.js';

describe('Límite del consumidor de auditoría', () => {
  const body = () => ({
    message_id: randomUUID(),
    correlation_id: randomUUID(),
    schema_version: 1,
    occurred_at: '2026-10-23T00:00:00Z',
    producer: 'pricing-svc',
    kind: 'event',
    name: 'pricing.price.changed',
    data: {},
  });
  const message = (value: unknown, properties = {}): ConsumeMessage =>
    ({
      content: Buffer.from(JSON.stringify(value)),
      properties: { contentType: 'application/json', ...properties },
      fields: {},
    }) as ConsumeMessage;
  it('acepta solo el envelope tipado; no interpreta GenericData ni sintetiza un asiento', () => {
    const value = body();
    expect(decodeEnvelope(message(value))).toEqual({
      id: value.message_id,
      correlationId: value.correlation_id,
      payload: value,
      data: {},
      occurredAt: new Date(value.occurred_at),
    });
  });
  it.each([
    { occurred_at: '2026-02-30T00:00:00Z' },
    { occurred_at: '2026-02-29T23:00:00-05:00' },
    { occurred_at: '2026-04-31T12:00:00Z' },
    { occurred_at: '2026-11-05T24:00:00Z' },
    { schema_version: 2 },
    { kind: 'command' },
    { producer: 'foreign' },
    { message_id: 'not-uuid' },
    { correlation_id: null },
    { occurred_at: 'not-a-date' },
    { data: [] },
    { name: 'other' },
  ])('rechaza metadatos incompatibles: %j', (changes) => {
    expect(() => decodeEnvelope(message({ ...body(), ...changes }))).toThrow();
  });
  it('rechaza metadata AMQP divergente, UTF-8 inválido y contenido excesivo', () => {
    expect(() =>
      decodeEnvelope(message(body(), { messageId: randomUUID() })),
    ).toThrow();
    expect(() =>
      decodeEnvelope(message(body(), { contentType: 'text/plain' })),
    ).toThrow();
    expect(() =>
      decodeEnvelope({ ...message(body()), content: Buffer.from([0xff]) }),
    ).toThrow();
    expect(() =>
      decodeEnvelope({
        ...message(body()),
        content: Buffer.alloc(1024 * 1024 + 1),
      }),
    ).toThrow();
  });
  it('sin decoder aprobado no inicia AMQP ni acepta payloads inventados', () => {
    const consumer = new AuditConsumer(
      {} as AuditRepository,
      { amqpUrl: 'amqp://unused' } as AuditConfig,
    );
    expect(() => consumer.onApplicationBootstrap()).toThrow('P-AUD-02');
    expect(consumer.available).toBe(false);
  });
});
