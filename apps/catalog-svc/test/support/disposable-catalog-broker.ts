import { spawnSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import {
  connect,
  type ChannelModel,
  type Channel,
  type GetMessage,
} from 'amqplib';
import {
  ConfirmedCatalogPublisher,
  type CatalogAmqpSettings,
} from '../../src/catalog-amqp.js';

/** Test infrastructure only: loopback ports, fixture credentials, no caller URLs. */
export class DisposableCatalogBroker {
  private readonly name = 'catalog-joint-' + process.pid + '-' + Date.now();
  private readonly password = 'disposable-joint-fixture';
  private connections: ChannelModel[] = [];
  private channel?: Channel;
  private base = '';
  settings: CatalogAmqpSettings = {};
  command(args: string[]): string {
    const result = spawnSync('docker', args, {
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new Error('Disposable joint broker command failed');
    return result.stdout.trim();
  }
  async start(): Promise<void> {
    this.command([
      'run',
      '--detach',
      '--name',
      this.name,
      '--publish',
      '127.0.0.1::5672',
      '--env',
      'RABBITMQ_DEFAULT_USER=catalog-joint',
      '--env',
      'RABBITMQ_DEFAULT_PASS=' + this.password,
      '--env',
      'RABBITMQ_DEFAULT_VHOST=g6-productos-ofertas',
      'rabbitmq:4.2.9-alpine',
    ]);
    const port = this.command(['port', this.name, '5672/tcp'])
      .split(':')
      .at(-1)!;
    this.base = '@127.0.0.1:' + port + '/g6-productos-ofertas';
    const admin = await this.open('catalog-joint');
    this.channel = await admin.createChannel();
    for (const exchange of ['po.comandos.x', 'po.eventos.x', 'po.resultados.x'])
      await this.channel.assertExchange(exchange, 'topic', { durable: true });
    for (const exchange of ['po.retry.x', 'po.dlx.x'])
      await this.channel.assertExchange(exchange, 'direct', { durable: true });
    for (const queue of ['po.catalogo.q', 'po.inventario.q', 'po.precios.q'])
      await this.channel.assertQueue(queue, {
        durable: true,
        arguments: { 'x-queue-type': 'quorum' },
      });
    for (const [prefix, queue] of [
      ['inventory', 'po.inventario.q'],
      ['pricing', 'po.precios.q'],
    ]) {
      await this.channel.bindQueue(
        queue,
        'po.comandos.x',
        prefix +
          '.' +
          (prefix === 'pricing' ? 'product' : 'sku') +
          '.initialization.requested',
      );
      for (const result of ['completed', 'rejected'])
        await this.channel.bindQueue(
          'po.catalogo.q',
          'po.resultados.x',
          prefix +
            '.' +
            (prefix === 'pricing' ? 'product' : 'sku') +
            '.initialization.' +
            result,
        );
      const user = prefix + '-joint';
      this.command([
        'exec',
        this.name,
        'rabbitmqctl',
        'add_user',
        user,
        this.password,
      ]);
      this.command([
        'exec',
        this.name,
        'rabbitmqctl',
        'set_permissions',
        '-p',
        'g6-productos-ofertas',
        user,
        '.*',
        '.*',
        '.*',
      ]);
    }
    await this.channel.assertQueue('po.catalogo.q.retry', {
      durable: true,
      arguments: {
        'x-message-ttl': 30000,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'po.catalogo.q',
      },
    });
    await this.channel.bindQueue(
      'po.catalogo.q.retry',
      'po.retry.x',
      'po.catalogo.q',
    );
    await this.channel.assertQueue('po.catalogo.q.dlq', { durable: true });
    await this.channel.bindQueue(
      'po.catalogo.q.dlq',
      'po.dlx.x',
      'po.catalogo.q',
    );
    this.settings = {
      isolatedTestRecovery: true,
      connection: {
        url: 'amqp://catalog-joint:' + this.password + this.base,
        user: 'catalog-joint',
        producerUsers: {
          'pricing-svc': 'pricing-joint',
          'inventory-svc': 'inventory-joint',
          'taxonomy-svc': 'taxonomy-joint',
          'bulk-svc': 'bulk-joint',
        },
      },
    };
  }
  private async open(user: string): Promise<ChannelModel> {
    const deadline = Date.now() + 60000;
    while (true) {
      try {
        const connection = await connect(
          'amqp://' + user + ':' + this.password + this.base,
          { timeout: 2000 },
        );
        connection.on('error', () => undefined);
        this.connections.push(connection);
        return connection;
      } catch {
        if (Date.now() > deadline)
          throw new Error('Disposable broker unavailable');
        await pause(200);
      }
    }
  }
  async next(queue: string): Promise<GetMessage> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const message = await this.channel!.get(queue, { noAck: false });
      if (message) {
        this.channel!.ack(message);
        return message;
      }
      await pause(50);
    }
    throw new Error('Joint requested message not delivered');
  }
  async result(
    producer: 'inventory' | 'pricing',
    body: Record<string, unknown>,
  ): Promise<void> {
    const connection = await this.open(producer + '-joint'),
      channel = await connection.createConfirmChannel();
    channel.on('error', () => undefined);
    await new ConfirmedCatalogPublisher(channel, producer + '-joint').raw(
      'po.resultados.x',
      String(body.name),
      Buffer.from(JSON.stringify(body)),
      {
        messageId: String(body.message_id),
        correlationId: String(body.correlation_id),
      },
    );
  }
  stop(): void {
    this.command(['stop', '--time', '2', this.name]);
  }
  async resume(): Promise<void> {
    this.command(['start', this.name]);
    // Docker may reassign an ephemeral host port after restart.
    const port = this.command(['port', this.name, '5672/tcp'])
      .split(':')
      .at(-1)!;
    this.base = '@127.0.0.1:' + port + '/g6-productos-ofertas';
    this.settings.connection!.url =
      'amqp://catalog-joint:' + this.password + this.base;
    const connection = await this.open('catalog-joint');
    this.channel = await connection.createChannel();
  }
  async close(): Promise<void> {
    await Promise.allSettled(this.connections.map((c) => c.close()));
    spawnSync('docker', ['rm', '--force', this.name], {
      windowsHide: true,
      timeout: 15000,
      stdio: 'ignore',
    });
  }
}
