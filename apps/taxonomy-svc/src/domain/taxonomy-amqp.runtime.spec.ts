import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsumeMessage } from 'amqplib';
import {
  parseChecked,
  TaxonomyMessageStore,
} from '../persistence/taxonomy-message.store.js';
import { leerAmqp, TaxonomyAmqpRuntime } from './taxonomy-amqp.runtime.js';

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('amqplib', () => ({ connect: mocks.connect }));

const config = {
  RABBITMQ_URL: 'amqp://taxonomy:fixture@localhost/g6-productos-ofertas',
  TAXONOMY_CATALOG_AMQP_USER: 'catalog',
};
const envelope = {
  message_id: '11111111-1111-4111-8111-111111111111',
  correlation_id: '22222222-2222-4222-8222-222222222222',
  operation_id: '33333333-3333-4333-8333-333333333333',
  causation_id: '44444444-4444-4444-8444-444444444444',
  schema_version: 1,
  occurred_at: '2026-11-02T00:00:00Z',
  producer: 'catalog-svc',
  kind: 'result',
  name: 'catalog.master.deactivation.checked',
  data: {
    entity_type: 'BRAND',
    entity_id: '55555555-5555-4555-8555-555555555555',
    version: 0,
    result: 'CLEAR',
  },
};

function fixture() {
  let recibir: (m: ConsumeMessage | null) => void = () => undefined;
  const consumer = Object.assign(new EventEmitter(), {
    checkQueue: vi.fn().mockResolvedValue({}),
    prefetch: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn(async (_queue: string, cb: typeof recibir) => {
      recibir = cb;
    }),
    ack: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
  });
  const publisher = Object.assign(new EventEmitter(), {
    publish: vi.fn(
      (
        _exchange: string,
        _key: string,
        _body: Buffer,
        _options: unknown,
        cb: (e?: Error) => void,
      ) => {
        cb();
        return true;
      },
    ),
  });
  const connection = Object.assign(new EventEmitter(), {
    createChannel: vi.fn().mockResolvedValue(consumer),
    createConfirmChannel: vi.fn().mockResolvedValue(publisher),
    close: vi.fn().mockResolvedValue(undefined),
  });
  mocks.connect.mockResolvedValue(connection);
  const store = {
    publicarUno: vi.fn().mockResolvedValue('VACIO'),
    consumir: vi.fn().mockResolvedValue(undefined),
    guardarInvalido: vi.fn().mockResolvedValue(undefined),
  };
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
  };
  const runtime = new TaxonomyAmqpRuntime(
    store as unknown as TaxonomyMessageStore,
  );
  runtime.usarLogger(logger);
  runtime.configurar(config);
  const entregar = (obj: unknown, options: Record<string, unknown> = {}) =>
    recibir({
      content: Buffer.from(JSON.stringify(obj)),
      properties: {
        userId: 'catalog',
        contentType: 'application/json',
        messageId: envelope.message_id,
        correlationId: envelope.correlation_id,
        ...options,
      },
      fields: { routingKey: envelope.name, consumerTag: 'test' },
    } as ConsumeMessage);
  return { runtime, store, consumer, publisher, connection, entregar, logger };
}
const esperar = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  vi.clearAllMocks();
});

describe('Taxonomy AMQP', () => {
  it.each([
    'taxonomy.product-type-schema.changed',
    'taxonomy.characteristic-value.updated',
  ])('publica %s en el exchange contractual', async (name) => {
    const f = fixture();
    f.store.publicarUno
      .mockImplementationOnce(
        async (publish: (r: Record<string, unknown>) => Promise<void>) => {
          await publish({
            event_name: name,
            message_id: envelope.message_id,
            correlation_id: envelope.correlation_id,
            payload: {
              name,
              message_id: envelope.message_id,
              correlation_id: envelope.correlation_id,
              producer: 'taxonomy-svc',
              kind: 'event',
              schema_version: 1,
              data: {},
            },
          });
          return 'PUBLICADO';
        },
      )
      .mockResolvedValue('VACIO');
    f.runtime.iniciar();
    try {
      await esperar();
      expect(f.publisher.publish).toHaveBeenCalledWith(
        'po.eventos.x',
        name,
        expect.any(Buffer),
        expect.objectContaining({
          mandatory: true,
          persistent: true,
          type: name,
        }),
        expect.any(Function),
      );
    } finally {
      await f.runtime.onModuleDestroy();
    }
  });
  it.each([
    'PRODUCT_TYPE',
    'CHARACTERISTIC_VALUE',
    'PRODUCT_TYPE_CHARACTERISTIC',
  ])('reconoce el envelope de %s', async (entityType) => {
    const checked = parseChecked({
      ...envelope,
      data: {
        ...envelope.data,
        entity_type: entityType,
        ...(entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
          ? {
              tipo_producto_id: envelope.data.entity_id,
              caracteristica_id: envelope.data.entity_id,
            }
          : {}),
      },
    });
    expect(checked.data.entity_type).toBe(entityType);
  });
  it('valida configuración sin exponer credenciales', () => {
    expect(leerAmqp({})).toBeUndefined();
    expect(() =>
      leerAmqp({ RABBITMQ_URL: 'amqp://usuario:secreto@localhost/otro' }),
    ).toThrow('Configuración AMQP taxonomy inválida');
    expect(leerAmqp(config)?.catalogUser).toBe('catalog');
  });
  it('consume con ACK solo tras persistencia y cierra conexión', async () => {
    const f = fixture();
    f.runtime.iniciar();
    await esperar();
    expect(f.runtime.disponible()).toBe(true);
    f.entregar(envelope);
    await esperar();
    expect(f.store.consumir).toHaveBeenCalledOnce();
    expect(f.consumer.ack).toHaveBeenCalledOnce();
    await f.runtime.onModuleDestroy();
    expect(f.connection.close).toHaveBeenCalledOnce();
  });
  it('mantiene la entrega sin ACK mientras Inbox está pendiente', async () => {
    const f = fixture();
    let confirmar!: () => void;
    f.store.consumir.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirmar = resolve;
        }),
    );
    f.runtime.iniciar();
    await esperar();
    f.entregar(envelope);
    await esperar();
    expect(f.consumer.ack).not.toHaveBeenCalled();
    confirmar();
    await esperar();
    expect(f.consumer.ack).toHaveBeenCalledOnce();
    await f.runtime.onModuleDestroy();
  });

  it('rechaza el mensaje si la cabecera AMQP tiene otro correlation_id', async () => {
    const f = fixture();
    f.runtime.iniciar();
    try {
      await esperar();
      f.entregar(envelope, {
        correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      await esperar();
      expect(f.store.consumir).not.toHaveBeenCalled();
      expect(f.store.guardarInvalido).toHaveBeenCalledOnce();
      expect(f.consumer.ack).toHaveBeenCalledOnce();
    } finally {
      await f.runtime.onModuleDestroy();
    }
  });

  it('registra mensajes inválidos antes de ACK', async () => {
    const f = fixture();
    f.runtime.iniciar();
    await esperar();
    f.entregar(envelope, { userId: 'otro' });
    await esperar();
    expect(f.store.guardarInvalido).toHaveBeenCalledOnce();
    expect(f.store.consumir).not.toHaveBeenCalled();
    expect(f.consumer.ack).toHaveBeenCalledOnce();
    await f.runtime.onModuleDestroy();
  });
  it('pausa tras tres fallos, registra diagnóstico seguro, sin ACK y falla readiness', async () => {
    const f = fixture();
    f.store.consumir.mockRejectedValue(new Error('db'));
    f.runtime.iniciar();
    await esperar();
    f.entregar(envelope);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(f.store.consumir).toHaveBeenCalledTimes(3);
    expect(f.consumer.ack).not.toHaveBeenCalled();
    expect(f.consumer.cancel).toHaveBeenCalledOnce();
    expect(f.runtime.disponible()).toBe(false);
    expect(f.logger.error).toHaveBeenCalledExactlyOnceWith({
      event: 'taxonomy.amqp.consumer_paused',
      service: 'taxonomy-svc',
      alert_name: 'taxonomy_amqp_consumer_paused',
      component: 'consumer',
      state: 'paused',
      attempts: 3,
      reason: 'PERSISTENCE_FAILURE',
    });
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain('db');
    await f.runtime.onModuleDestroy();
  });

  it('recupera un fallo transitorio antes del tercer intento y confirma una sola vez', async () => {
    const f = fixture();
    f.store.consumir
      .mockRejectedValueOnce(new Error('credential=private'))
      .mockResolvedValueOnce(undefined);
    f.runtime.iniciar();
    await esperar();
    f.entregar(envelope);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(f.store.consumir).toHaveBeenCalledTimes(2);
    expect(f.consumer.ack).toHaveBeenCalledOnce();
    expect(f.runtime.disponible()).toBe(true);
    expect(f.logger.error).not.toHaveBeenCalled();
    expect(f.logger.warn.mock.calls.flat()).not.toContain('credential=private');
    await f.runtime.onModuleDestroy();
  });

  it('marca la publicación Outbox pendiente con una señal segura y de baja cardinalidad', async () => {
    const f = fixture();
    f.store.publicarUno.mockResolvedValueOnce('PENDIENTE');
    f.runtime.iniciar();
    await esperar();
    expect(f.logger.warn).toHaveBeenCalledWith({
      event: 'taxonomy.amqp.outbox_publish_pending',
      service: 'taxonomy-svc',
      component: 'outbox',
      state: 'pending',
      reason: 'BROKER_PUBLISH_UNCONFIRMED',
    });
    await f.runtime.onModuleDestroy();
  });
  it('publica en exchange contractual y espera confirmación', async () => {
    const f = fixture();
    f.store.publicarUno
      .mockImplementationOnce(
        async (publish: (r: Record<string, unknown>) => Promise<void>) => {
          await publish({
            event_name: 'taxonomy.master.deactivation.check.requested',
            message_id: envelope.message_id,
            correlation_id: envelope.correlation_id,
            payload: {
              name: 'taxonomy.master.deactivation.check.requested',
              message_id: envelope.message_id,
              correlation_id: envelope.correlation_id,
              producer: 'taxonomy-svc',
              kind: 'command',
              schema_version: 1,
              data: {},
            },
          });
          return 'PUBLICADO';
        },
      )
      .mockResolvedValue('VACIO');
    f.runtime.iniciar();
    await esperar();
    expect(f.publisher.publish).toHaveBeenCalledWith(
      'po.comandos.x',
      'taxonomy.master.deactivation.check.requested',
      expect.any(Buffer),
      expect.objectContaining({
        mandatory: true,
        persistent: true,
        userId: 'taxonomy',
      }),
      expect.any(Function),
    );
    await f.runtime.onModuleDestroy();
  });
  it('no confirma la publicación si el broker devuelve el mensaje sin ruta', async () => {
    const f = fixture();
    let fallo = false;
    f.publisher.publish.mockImplementationOnce(
      (_exchange, _key, _body, _options, callback) => {
        f.publisher.emit('return', {
          properties: { messageId: envelope.message_id },
        });
        callback();
        return true;
      },
    );
    f.store.publicarUno.mockImplementationOnce(
      async (publish: (r: Record<string, unknown>) => Promise<void>) => {
        try {
          await publish({
            event_name: 'taxonomy.master.deactivation.check.requested',
            message_id: envelope.message_id,
            correlation_id: envelope.correlation_id,
            payload: {
              name: 'taxonomy.master.deactivation.check.requested',
              message_id: envelope.message_id,
              correlation_id: envelope.correlation_id,
              producer: 'taxonomy-svc',
              kind: 'command',
              schema_version: 1,
              data: {},
            },
          });
        } catch {
          fallo = true;
        }
        return 'PENDIENTE';
      },
    );
    f.runtime.iniciar();
    await esperar();
    expect(fallo).toBe(true);
    await f.runtime.onModuleDestroy();
  });

  it('conserva la publicación Outbox si el broker rechaza el confirm', async () => {
    const f = fixture();
    let fallo = false;
    f.publisher.publish.mockImplementationOnce(
      (_exchange, _key, _body, _options, callback) => {
        callback(new Error('password=do-not-log'));
        return true;
      },
    );
    f.store.publicarUno.mockImplementationOnce(
      async (publish: (r: Record<string, unknown>) => Promise<void>) => {
        try {
          await publish({
            event_name: 'taxonomy.master.deactivation.check.requested',
            message_id: envelope.message_id,
            correlation_id: envelope.correlation_id,
            payload: {
              name: 'taxonomy.master.deactivation.check.requested',
              message_id: envelope.message_id,
              correlation_id: envelope.correlation_id,
              producer: 'taxonomy-svc',
              kind: 'command',
              schema_version: 1,
              data: {},
            },
          });
        } catch {
          fallo = true;
        }
        return 'PENDIENTE';
      },
    );
    f.runtime.iniciar();
    await esperar();
    expect(fallo).toBe(true);
    expect(f.logger.warn).toHaveBeenCalledWith({
      event: 'taxonomy.amqp.outbox_publish_pending',
      service: 'taxonomy-svc',
      component: 'outbox',
      state: 'pending',
      reason: 'BROKER_PUBLISH_UNCONFIRMED',
    });
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain(
      'do-not-log',
    );
    await f.runtime.onModuleDestroy();
  });
});
