import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import amqp, { type Channel, type ChannelModel } from 'amqplib';

const exec = promisify(execFile);

/** Disposable loopback broker for integration tests only. */
export class IsolatedBulkRabbitmq {
  private readonly name = `bulk93-rabbit-${randomUUID()}`;
  private readonly password = randomUUID();
  private created = false;
  private adminConnection: ChannelModel | null = null;
  private adminChannel: Channel | null = null;
  url = '';

  async start(): Promise<void> {
    await exec(
      'docker',
      [
        'run',
        '--detach',
        '--name',
        this.name,
        '--publish',
        '127.0.0.1::5672',
        '--env',
        'RABBITMQ_DEFAULT_USER=bulk93-fixture',
        '--env',
        `RABBITMQ_DEFAULT_PASS=${this.password}`,
        '--env',
        'RABBITMQ_DEFAULT_VHOST=g6-productos-ofertas',
        'rabbitmq:4.2.9-management',
      ],
      { timeout: 60000, windowsHide: true },
    );
    this.created = true;
    const { stdout } = await exec('docker', ['port', this.name, '5672/tcp'], {
      windowsHide: true,
    });
    const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout.trim())?.[1];
    if (!port)
      throw new Error('RabbitMQ aislado no publicó un puerto loopback.');
    this.url = `amqp://bulk93-fixture:${this.password}@127.0.0.1:${port}/g6-productos-ofertas?heartbeat=5`;
    const deadline = Date.now() + 60000;
    while (!this.adminConnection && Date.now() < deadline) {
      try {
        this.adminConnection = await amqp.connect(this.url, { timeout: 1000 });
      } catch {
        await pause(250);
      }
    }
    if (!this.adminConnection)
      throw new Error('RabbitMQ aislado no quedó disponible.');
    this.adminConnection.on('error', () => undefined);
    this.adminChannel = await this.adminConnection.createChannel();
    await this.adminChannel.assertExchange('po.comandos.x', 'topic', {
      durable: true,
    });
    await this.adminChannel.assertExchange('po.resultados.x', 'topic', {
      durable: true,
    });
    await this.adminChannel.assertQueue('po.catalogo.q', { durable: true });
    await this.adminChannel.bindQueue(
      'po.catalogo.q',
      'po.comandos.x',
      'catalog.bulk.upsert.requested',
    );
    await this.adminChannel.assertQueue('po.masivos.q', { durable: true });
    await this.adminChannel.bindQueue(
      'po.masivos.q',
      'po.resultados.x',
      'catalog.bulk.upsert.completed',
    );
    await this.adminChannel.bindQueue(
      'po.masivos.q',
      'po.resultados.x',
      'catalog.bulk.upsert.rejected',
    );
  }

  async nextCommand(): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const message = await this.adminChannel!.get('po.catalogo.q', {
        noAck: false,
      });
      if (message) {
        this.adminChannel!.ack(message);
        return JSON.parse(message.content.toString('utf8')) as Record<
          string,
          unknown
        >;
      }
      await pause(25);
    }
    throw new Error(
      'No llegó el comando Bulk a la cola Catalog del broker aislado.',
    );
  }

  async publishResult(body: Record<string, unknown>): Promise<void> {
    const channel = await this.adminConnection!.createConfirmChannel();
    try {
      const envelope = body as {
        name: string;
        message_id: string;
        correlation_id: string;
      };
      channel.publish(
        'po.resultados.x',
        envelope.name,
        Buffer.from(JSON.stringify(body)),
        {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          type: envelope.name,
          messageId: envelope.message_id,
          correlationId: envelope.correlation_id,
        },
      );
      await channel.waitForConfirms();
    } finally {
      await channel.close();
    }
  }

  async suspend(): Promise<void> {
    await this.adminChannel?.close().catch(() => undefined);
    await this.adminConnection?.close().catch(() => undefined);
    this.adminChannel = null;
    this.adminConnection = null;
    await exec('docker', ['exec', this.name, 'rabbitmqctl', 'stop_app'], {
      timeout: 15000,
      windowsHide: true,
    });
  }

  async resume(): Promise<void> {
    await exec('docker', ['exec', this.name, 'rabbitmqctl', 'start_app'], {
      timeout: 15000,
      windowsHide: true,
    });
    const deadline = Date.now() + 30000;
    while (!this.adminConnection && Date.now() < deadline) {
      try {
        this.adminConnection = await amqp.connect(this.url, { timeout: 1000 });
      } catch {
        await pause(250);
      }
    }
    if (!this.adminConnection)
      throw new Error('RabbitMQ aislado no se recuperó tras reiniciarlo.');
    this.adminConnection.on('error', () => undefined);
    this.adminChannel = await this.adminConnection.createChannel();
  }

  async stop(): Promise<void> {
    await this.adminChannel?.close().catch(() => undefined);
    await this.adminConnection?.close().catch(() => undefined);
    if (this.created)
      await exec('docker', ['rm', '--force', '--volumes', this.name], {
        timeout: 15000,
        windowsHide: true,
      }).catch(() => undefined);
  }
}
