import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { connect, type Channel, type ChannelModel } from 'amqplib';
const exec = promisify(execFile);
const image =
  'rabbitmq:4.2-alpine@sha256:63bf2b61c7ddd5ab746d1d964f33beb1b4a2c06df79505d55251aae5f8077884';

// Solo prepara un broker descartable propio, con puerto aleatorio loopback.
export class IsolatedRabbitmq {
  private readonly name = 'vera-amqp-' + randomUUID();
  private created = false;
  connection?: ChannelModel;
  channel?: Channel;
  url = '';
  async start() {
    const password = randomUUID();
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
        'RABBITMQ_DEFAULT_USER=fixture',
        '--env',
        'RABBITMQ_DEFAULT_PASS=' + password,
        image,
      ],
      { timeout: 60000 },
    );
    this.created = true;
    const { stdout } = await exec('docker', ['port', this.name, '5672/tcp']);
    const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1];
    if (!port) throw new Error('Puerto de broker aislado inválido.');
    this.url = `amqp://fixture:${password}@127.0.0.1:${port}/%2F?heartbeat=5`;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        this.connection = await connect(this.url, { timeout: 1000 });
        break;
      } catch {
        await setTimeout(250);
      }
    }
    if (!this.connection) throw new Error('Broker aislado no disponible.');
    this.connection.on('error', () => undefined);
    this.channel = await this.connection.createChannel();
    this.channel.on('error', () => undefined);
    // Declaraciones exclusivas de esta fixture; los runtimes solo comprueban topología existente.
    await this.channel.assertExchange('po.eventos.x', 'topic', {
      durable: true,
    });
    await this.channel.assertQueue('po.auditoria-precios.q', {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    await this.channel.bindQueue(
      'po.auditoria-precios.q',
      'po.eventos.x',
      'pricing.price.changed',
    );
  }
  async pause() {
    await exec('docker', ['pause', this.name], { timeout: 10000 });
  }
  async resume() {
    await exec('docker', ['unpause', this.name], { timeout: 10000 });
  }
  async reconnect() {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.connection = await connect(this.url, { timeout: 2000 });
    this.connection.on('error', () => undefined);
    this.channel = await this.connection.createChannel();
    this.channel.on('error', () => undefined);
  }
  async stop() {
    try {
      await this.channel?.close().catch(() => undefined);
      await this.connection?.close().catch(() => undefined);
    } finally {
      if (this.created)
        await exec('docker', ['rm', '--force', '--volumes', this.name], {
          timeout: 15000,
        });
    }
  }
}
