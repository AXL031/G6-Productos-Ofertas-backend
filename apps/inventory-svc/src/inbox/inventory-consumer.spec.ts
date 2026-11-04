import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import amqp from 'amqplib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InventoryCommandService,
  InventoryMessageError,
} from './inventory-command.service.js';
import { InventoryConsumerService } from './inventory-consumer.service.js';

vi.mock('amqplib', () => ({ default: { connect: vi.fn() } }));

describe('Consumer de inventario — transporte simulado (#102/#103)', () => {
  const process = vi.fn<InventoryCommandService['process']>();
  let service: InventoryConsumerService;
  let channel: ReturnType<typeof makeChannel>;
  let connection: ReturnType<typeof makeConnection>;
  const message = (payload: unknown = {}) =>
    ({ content: Buffer.from(JSON.stringify(payload)) }) as amqp.ConsumeMessage;

  function makeChannel() {
    return Object.assign(new EventEmitter(), {
      ack: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      checkQueue: vi.fn().mockResolvedValue({}),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockResolvedValue({ consumerTag: 'inventory-test' }),
    });
  }
  function makeConnection() {
    return Object.assign(new EventEmitter(), {
      createChannel: vi.fn().mockResolvedValue(channel),
      close: vi.fn().mockResolvedValue(undefined),
    });
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubEnv('RABBITMQ_URL', 'amqp://localhost/test');
    process.mockResolvedValue({ duplicate: false, status: 'INITIALIZED' });
    service = new InventoryConsumerService({
      process,
    } as unknown as InventoryCommandService);
    channel = makeChannel();
    connection = makeConnection();
    vi.mocked(amqp.connect).mockResolvedValue(
      connection as unknown as amqp.ChannelModel,
    );
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('comprueba la cola preexistente, limita prefetch y exige ACK manual', async () => {
    await service.start();
    expect(channel.checkQueue).toHaveBeenCalledWith('po.inventario.q');
    expect(channel.prefetch).toHaveBeenCalledWith(20);
    expect(channel.consume).toHaveBeenCalledWith(
      'po.inventario.q',
      expect.any(Function),
      { noAck: false },
    );
    expect(service.getMetrics().connected).toBe(true);
  });

  it('no confirma antes de finalizar la transacción durable', async () => {
    let commit!: (result: { duplicate: boolean }) => void;
    process.mockReturnValueOnce(
      new Promise((resolve) => {
        commit = resolve;
      }),
    );
    const incoming = message();
    const pending = service.deliver(channel, incoming);
    expect(channel.ack).not.toHaveBeenCalled();
    commit({ duplicate: false });
    await pending;
    expect(channel.ack).toHaveBeenCalledWith(incoming);
  });

  it.each([
    { duplicate: true },
    { duplicate: false, status: 'REJECTED' as const },
  ])(
    'confirma duplicados o rechazos de negocio durables: %j',
    async (result) => {
      process.mockResolvedValueOnce(result);
      await service.deliver(channel, message());
      expect(channel.ack).toHaveBeenCalledOnce();
      expect(channel.close).not.toHaveBeenCalled();
      expect(service.getMetrics()).toMatchObject({
        acknowledged: 1,
        failures: 0,
        duplicates: result.duplicate ? 1 : 0,
        rejected: 'status' in result ? 1 : 0,
      });
    },
  );

  it.each([
    new Error('ECONNRESET'),
    new InventoryMessageError('BLOCKED_CONTRACT'),
  ])('un fallo pausa sin ACK y no reconecta en bucle: %s', async (failure) => {
    await service.start();
    process.mockRejectedValueOnce(failure);
    await service.deliver(channel, message());
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(service.getMetrics()).toMatchObject({
      paused: true,
      acknowledged: 0,
      failures: 1,
    });
    await vi.advanceTimersByTimeAsync(90000);
    expect(amqp.connect).toHaveBeenCalledOnce();
    await service.resume();
    expect(amqp.connect).toHaveBeenCalledTimes(2);
    await service.deliver(channel, message());
    expect(service.getMetrics()).toMatchObject({
      paused: false,
      acknowledged: 1,
    });
  });

  it('JSON inválido queda sin confirmar y ni siquiera ejecuta el comando', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await service.deliver(channel, {
      content: Buffer.from('dato-privado-sintetico JSON inválido'),
    } as amqp.ConsumeMessage);
    expect(process).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(service.getMetrics().paused).toBe(true);
    expect(service.getMetrics().pauseReason).toBe('INVALID_MESSAGE');
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      'dato-privado-sintetico',
    );
    log.mockRestore();
  });

  it('reconecta tras perder la conexión y cancela futuros reintentos al detenerse', async () => {
    await service.start();
    connection.emit('close');
    await vi.advanceTimersByTimeAsync(29999);
    expect(amqp.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(amqp.connect).toHaveBeenCalledTimes(2);
    expect(service.getMetrics().reconnects).toBe(1);
    connection.emit('close');
    await service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(60000);
    expect(amqp.connect).toHaveBeenCalledTimes(2);
  });

  it('un cierre síncrono fallido no convierte el mensaje en ACK ni genera rechazo no manejado', async () => {
    process.mockRejectedValueOnce(new Error('DB no disponible'));
    channel.close.mockImplementationOnce(() => {
      throw new Error('canal ya cerrado');
    });
    await expect(service.deliver(channel, message())).resolves.toBeUndefined();
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('si se detiene mientras conecta, cierra la conexión sin iniciar un consumidor', async () => {
    let connect!: (value: amqp.ChannelModel) => void;
    vi.mocked(amqp.connect).mockReturnValueOnce(
      new Promise((resolve) => {
        connect = resolve;
      }),
    );
    const starting = service.start();
    await service.onModuleDestroy();
    connect(connection as unknown as amqp.ChannelModel);
    await starting;
    expect(connection.close).toHaveBeenCalledOnce();
    expect(channel.consume).not.toHaveBeenCalled();
  });
});
