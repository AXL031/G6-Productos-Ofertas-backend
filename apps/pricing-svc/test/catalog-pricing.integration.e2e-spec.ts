import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from 'amqplib';
import { Pool } from 'pg';
import { IsolatedPostgres } from './isolated-postgres.js';

const exec = promisify(execFile);
const enabled = process.env.PRICING_TEST_CATALOG === '1';
const expectedCatalogSha = '263bd2655184c3cd559ab1f682a75f3730f5f85f';
const PREFIX = '__CATALOG_PRICING__';
const rabbitImage =
  'rabbitmq:4.2-alpine@sha256:63bf2b61c7ddd5ab746d1d964f33beb1b4a2c06df79505d55251aae5f8077884';

function docker(args: string[], input?: string): string {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    timeout: 120000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Disposable integration Docker command failed (${args[0] ?? 'unknown'}): ${
        result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`
      }`,
    );
  return result.stdout.trim();
}

async function waitFor<T>(
  get: () => Promise<T | undefined>,
  description: string,
  timeoutMs = 30000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await get();
    if (value !== undefined) return value;
    await pause(100);
  }
  throw new Error(`Timeout esperando ${description}.`);
}

class SharedRabbitFixture {
  readonly name = 'pricing-catalog-' + randomUUID();
  readonly password = randomUUID();
  readonly vhost = 'g6-productos-ofertas';
  port = 0;
  url = '';
  connection?: ChannelModel;
  channel?: Channel;
  catalogUrl = '';
  pricingUrl = '';
  readonly catalogUser = 'catalog-runtime';
  readonly pricingUser = 'pricing-svc';
  async start(): Promise<void> {
    docker([
      'run',
      '--detach',
      '--name',
      this.name,
      '--publish',
      '127.0.0.1::5672',
      '--env',
      'RABBITMQ_DEFAULT_VHOST=' + this.vhost,
      '--env',
      'RABBITMQ_DEFAULT_USER=integration-admin',
      '--env',
      'RABBITMQ_DEFAULT_PASS=' + this.password,
      rabbitImage,
    ]);
    this.port = Number(
      docker(['port', this.name, '5672/tcp']).split(':').at(-1),
    );
    this.url = `amqp://integration-admin:${this.password}@127.0.0.1:${this.port}/${this.vhost}`;
    const deadline = Date.now() + 60000;
    while (!this.connection && Date.now() < deadline) {
      try {
        this.connection = await connect(this.url, { timeout: 2000 });
      } catch {
        await pause(100);
      }
    }
    if (!this.connection) {
      const logs = spawnSync('docker', ['logs', '--tail', '30', this.name], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });
      throw new Error(
        `Broker temporal no disponible; logs: ${(logs.stdout + logs.stderr).slice(-3000)}`,
      );
    }
    const credentials = [
      ['catalog-runtime', 'catalog-runtime-pass'],
      ['pricing-svc', 'pricing-svc-pass'],
      ['inventory-svc', 'inventory-svc-pass'],
      ['taxonomy-svc', 'taxonomy-svc-pass'],
      ['bulk-svc', 'bulk-svc-pass'],
    ] as const;
    for (const [user, password] of credentials) {
      docker(['exec', this.name, 'rabbitmqctl', 'add_user', user, password]);
      docker([
        'exec',
        this.name,
        'rabbitmqctl',
        'set_permissions',
        '-p',
        this.vhost,
        user,
        '.*',
        '.*',
        '.*',
      ]);
    }
    this.catalogUrl = `amqp://catalog-runtime:catalog-runtime-pass@127.0.0.1:${this.port}/${this.vhost}`;
    this.pricingUrl = `amqp://pricing-svc:pricing-svc-pass@127.0.0.1:${this.port}/${this.vhost}`;
    this.connection.on('error', () => undefined);
    this.channel = await this.connection.createChannel();
    this.channel.on('error', () => undefined);
    await this.channel.assertExchange('po.sin-ruta.x', 'fanout', {
      durable: true,
    });
    for (const name of ['po.comandos.x', 'po.eventos.x', 'po.resultados.x'])
      await this.channel.assertExchange(name, 'topic', {
        durable: true,
        arguments: { 'alternate-exchange': 'po.sin-ruta.x' },
      });
    for (const name of ['po.catalogo.q', 'po.inventario.q', 'po.precios.q'])
      await this.channel.assertQueue(name, {
        durable: true,
        arguments: { 'x-queue-type': 'quorum' },
      });
    await this.channel.assertQueue('po.sin-ruta.q', {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    await this.channel.bindQueue('po.sin-ruta.q', 'po.sin-ruta.x', '#');
    await this.channel.bindQueue(
      'po.precios.q',
      'po.comandos.x',
      'pricing.product.initialization.requested',
    );
    await this.channel.bindQueue(
      'po.precios.q',
      'po.eventos.x',
      'catalog.sku.deactivated',
    );
    await this.channel.bindQueue(
      'po.inventario.q',
      'po.comandos.x',
      'inventory.sku.initialization.requested',
    );
    for (const ending of ['completed', 'rejected'])
      await this.channel.bindQueue(
        'po.catalogo.q',
        'po.resultados.x',
        `pricing.product.initialization.${ending}`,
      );
  }
  async take(queue: string): Promise<ConsumeMessage> {
    return waitFor(async () => {
      const message = await this.channel!.get(queue, { noAck: false });
      return message || undefined;
    }, `mensaje en ${queue}`);
  }
  async stop(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    docker(['rm', '--force', '--volumes', this.name]);
  }
}

class CatalogPostgresFixture {
  readonly name = 'catalog-pricing-pg-' + randomUUID();
  readonly password = randomUUID();
  directory = '';
  cert = '';
  port = 0;
  admin?: Pool;
  runtimeEnv: Record<string, string> = {};
  async start(catalogRoot: string): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), 'catalog-pricing-cert-'));
    const certDirectory = join(this.directory, 'certs');
    await mkdir(certDirectory);
    this.cert = join(certDirectory, 'server.crt');
    const key = join(certDirectory, 'server.key');
    await chmod(certDirectory, 0o755);
    const generated = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        this.cert,
      ],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    );
    if (generated.status !== 0)
      throw new Error('OpenSSL no pudo crear certificado PostgreSQL temporal.');
    await chmod(key, 0o644);
    await chmod(this.cert, 0o644);
    docker([
      'run',
      '--detach',
      '--name',
      this.name,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_PASSWORD=' + this.password,
      '--volume',
      certDirectory + ':/certs:ro',
      '--entrypoint',
      'sh',
      'postgres:17-alpine',
      '-c',
      'cp /certs/server.key /tmp/server.key; chown postgres:postgres /tmp/server.key; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/tmp/server.key',
    ]);
    this.port = Number(
      docker(['port', this.name, '5432/tcp']).split(':').at(-1),
    );
    this.admin = new Pool({
      host: '127.0.0.1',
      port: this.port,
      database: 'postgres',
      user: 'postgres',
      password: this.password,
      ssl: false,
      connectionTimeoutMillis: 3000,
    });
    await waitFor(
      async () => {
        try {
          await this.admin!.query('SELECT 1');
          return true;
        } catch {
          return undefined;
        }
      },
      'PostgreSQL Catalog temporal',
      60000,
    );
    const migration1 = await readFile(
      join(
        catalogRoot,
        'apps/catalog-svc/test/fixtures/0001_create_catalog.sql',
      ),
      'utf8',
    );
    const migration2 = await readFile(
      join(
        catalogRoot,
        'apps/catalog-svc/migrations/0002_create_sku_barcodes.sql',
      ),
      'utf8',
    );
    const migration3 = await readFile(
      join(
        catalogRoot,
        'apps/catalog-svc/migrations/0003_product_publication_history.sql',
      ),
      'utf8',
    );
    const setup = [
      'CREATE ROLE po_catalog_owner NOLOGIN;',
      `CREATE ROLE catalog_app LOGIN PASSWORD '${this.password}';`,
      'CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner;',
      'SET ROLE po_catalog_owner;',
      migration1,
      migration2,
      migration3,
    ].join('\n');
    const applied = spawnSync(
      'docker',
      [
        'exec',
        '-i',
        this.name,
        'psql',
        '-U',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { encoding: 'utf8', input: setup, timeout: 120000, windowsHide: true },
    );
    if (applied.status !== 0)
      throw new Error('Migraciones Catalog fallaron en PostgreSQL desechable.');
    this.runtimeEnv = {
      NODE_ENV: 'test',
      CATALOG_SVC_PORT: '3019',
      CATALOG_SVC_HOST: '127.0.0.1',
      PGHOST: 'localhost',
      G6_CONNECT_HOST: '127.0.0.1',
      PGPORT: String(this.port),
      PGDATABASE: 'postgres',
      PGUSER: 'catalog_app',
      PGPASSWORD: this.password,
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: this.cert,
      G6_DATABASE_SCHEMA: 'catalog',
      G6_EXPECTED_ROLE: 'catalog_app',
      G6_CONNECTION_MODE: 'direct',
    };
  }
  async stop(): Promise<void> {
    await this.admin?.end();
    docker(['rm', '--force', '--volumes', this.name]);
    if (this.directory) {
      const rel = relative(tmpdir(), this.directory);
      if (!rel || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Path de limpieza de certificados fuera de temp.');
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}

class ChildService {
  private stdout = '';
  private stderr = '';
  private stdoutLog = '';
  readonly child: ReturnType<typeof spawn>;
  private readonly messages = new Map<
    string,
    (value: Record<string, unknown>) => void
  >();
  private sequence = 0;
  constructor(
    command: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ) {
    this.child = spawn(command, args, {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout?.on('data', (chunk) => {
      this.stdout += String(chunk);
      for (;;) {
        const end = this.stdout.indexOf('\n');
        if (end < 0) break;
        const line = this.stdout.slice(0, end).trim();
        this.stdout = this.stdout.slice(end + 1);
        if (!line.startsWith(PREFIX)) {
          this.stdoutLog = (this.stdoutLog + line + '\n').slice(-6000);
          continue;
        }
        const value = JSON.parse(line.slice(PREFIX.length)) as Record<
          string,
          unknown
        >;
        const id = String(value.id ?? 'ready');
        this.messages.get(id)?.(value);
        this.messages.delete(id);
      }
    });
    this.child.stderr?.on('data', (chunk) => {
      this.stderr += String(chunk);
    });
  }
  request(
    command: Record<string, unknown>,
    timeoutMs = 30000,
  ): Promise<Record<string, unknown>> {
    const id = String(++this.sequence);
    const line = JSON.stringify({ ...command, id });
    return new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => {
        this.messages.delete(id);
        reject(
          new Error(`Child service timeout (${id}); ${this.safeStderr()}`),
        );
      }, timeoutMs);
      this.messages.set(id, (value) => {
        clearTimeout(timer);
        resolveMessage(value);
      });
      this.child.stdin!.write(line + '\n');
    });
  }
  ready(timeoutMs = 30000): Promise<Record<string, unknown>> {
    const timerId = 'ready';
    return new Promise((resolveMessage, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Child startup timeout; ${this.safeStderr()}`)),
        timeoutMs,
      );
      this.messages.set(timerId, (value) => {
        clearTimeout(timer);
        resolveMessage(value);
      });
    });
  }
  safeStderr(): string {
    return this.stderr
      .replace(/amqps?:\/\/[^\s"']+/gi, '[AMQP_URL]')
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[POSTGRES_URL]')
      .slice(-3000);
  }
  safeStdoutLog(): string {
    return this.stdoutLog
      .replace(/amqps?:\/\/[^\s"']+/gi, '[AMQP_URL]')
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[POSTGRES_URL]')
      .slice(-3000);
  }
  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.kill('SIGTERM');
    await Promise.race([once(this.child, 'exit'), pause(10000)]);
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }
}

describe.skipIf(!enabled)(
  'Catalog exacto #185 ↔ Pricing real en broker común AsyncAPI rc.4',
  () => {
    const pricingPostgres = new IsolatedPostgres();
    const catalogPostgres = new CatalogPostgresFixture();
    const broker = new SharedRabbitFixture();
    let pricingAdmin: Pool;
    let catalogRoot: string;
    let catalog: ChildService;
    let pricing: ChildService;
    let catalogDbEnv: Record<string, string>;
    let catalogRunner: string;
    let pricingPort = 0;
    const pricingRuntimeDirs: string[] = [];

    beforeAll(async () => {
      catalogRoot = process.env.CATALOG_PRICING_WORKTREE!;
      if (!catalogRoot)
        throw new Error(
          'Defina CATALOG_PRICING_WORKTREE con la worktree Poma aislada.',
        );
      const head = (
        await exec('git', ['-C', catalogRoot, 'rev-parse', 'HEAD'])
      ).stdout.trim();
      const status = (
        await exec('git', ['-C', catalogRoot, 'status', '--porcelain'])
      ).stdout.trim();
      if (head !== expectedCatalogSha || status)
        throw new Error(
          `Catalog worktree debe estar limpio en ${expectedCatalogSha}.`,
        );
      await exec(
        process.execPath,
        [
          join(catalogRoot, 'node_modules/@nestjs/cli/bin/nest.js'),
          'build',
          'catalog-svc',
        ],
        { cwd: catalogRoot, timeout: 120000 },
      );
      await Promise.all([pricingPostgres.start(), broker.start()]);
      await catalogPostgres.start(catalogRoot);
      catalogDbEnv = catalogPostgres.runtimeEnv;
      pricingAdmin = pricingPostgres.admin!;
      const catalogDist = join(catalogRoot, 'dist/apps/catalog-svc');
      const moduleUrl = (name: string) =>
        pathToFileURL(join(catalogDist, name + '.js')).href;
      const testingUrl = pathToFileURL(
        join(catalogRoot, 'node_modules/@nestjs/testing/index.js'),
      ).href;
      catalogRunner = `
      import { Test } from ${JSON.stringify(testingUrl)};
      import { AppModule } from ${JSON.stringify(moduleUrl('app.module'))};
      import { CatalogConfig } from ${JSON.stringify(moduleUrl('config'))};
      import { CATALOG_AMQP_SETTINGS, CatalogAmqpRuntime, readCatalogAmqpConfig } from ${JSON.stringify(moduleUrl('catalog-amqp'))};
      import { CatalogMutationService } from ${JSON.stringify(moduleUrl('catalog-mutation.service'))};
      import { CatalogMasterClient as MasterClient } from ${JSON.stringify(moduleUrl('catalog-master.client'))};
      import { Database } from ${JSON.stringify(moduleUrl('database'))};
      import { randomUUID } from 'node:crypto';
      import readline from 'node:readline';
      const prefix = ${JSON.stringify(PREFIX)};
      const env = process.env;
      const config = new CatalogConfig(env);
      let directAmqpConfig = false;
      let directAmqpError = '';
      try { directAmqpConfig = Boolean(readCatalogAmqpConfig(env)); } catch (error) { directAmqpError = String(error?.message ?? error); }
      const module = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
        .overrideProvider(CATALOG_AMQP_SETTINGS)
        .useValue({ ...config.amqp, isolatedTestRecovery: true })
        .overrideProvider(MasterClient)
        .useValue({ masters: async () => ({ schemaVersion: 1 }), attributes: async (_type, values) => values })
        .compile();
      const db = module.get(Database);
      await db.verifyIdentity();
      const app = module.createNestApplication({ logger: false });
      await app.init();
      await app.listen(0, '127.0.0.1');
      const runtime = app.get(CatalogAmqpRuntime);
      const deadline = Date.now() + 30000;
      while (!runtime.ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      if (!runtime.ready) throw new Error('Catalog AMQP runtime no quedó suscrito.');
      process.stdout.write(prefix + JSON.stringify({ kind: 'ready', envHasRabbitmq: Boolean(env.RABBITMQ_URL), rabbitPath: env.RABBITMQ_URL ? new URL(env.RABBITMQ_URL).pathname : '', producerUsersPresent: Boolean(env.CATALOG_AMQP_PRODUCER_USERS), directAmqpConfig, directAmqpError, configHasAmqp: Boolean(config.amqp.connection), amqpRequired: runtime.required, amqpReady: runtime.ready }) + '\\n');
      const mutations = app.get(CatalogMutationService);
      const inputFor = (sku, hasVariants) => ({
        nombre: 'Catalog Pricing ' + sku,
        descripcion: 'Fixture de integración descartable',
        categoriaId: 'category-fixture', tipoProductoId: 'type-fixture', marcaId: 'brand-fixture',
        skuBase: sku, tieneVariantes: hasVariants, precioBaseInicial: 20,
        imagenes: [{ url: 'https://example.test/catalog-pricing' }],
        ...(hasVariants ? {} : { perfilFisico: { pesoKg: 1, dimensionesCm: { largo: 10, ancho: 10, alto: 10 } } }),
      });
      const actor = () => ({ authorization: 'Bearer isolated-test-actor', correlationId: randomUUID() });
      const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of input) {
        let command;
        try {
          command = JSON.parse(line);
          let result;
          if (command.action === 'create-product') {
            const product = await mutations.createProduct(inputFor(command.sku, command.hasVariants), actor());
            let variant;
            if (command.hasVariants) variant = await mutations.createVariant(product.product_id, {
              sku: command.variantSku,
              atributosIdentificadores: [{ caracteristica_id: 'size', nombre: 'Size', valor_id: 'L', valor: 'L' }],
              imagenUrl: 'https://example.test/catalog-pricing-variant',
              perfilFisico: { pesoKg: 1, dimensionesCm: { largo: 10, ancho: 10, alto: 10 } },
            }, actor());
            result = { product, variant };
          } else if (command.action === 'deactivate-variant') {
            result = await mutations.state(command.productId, command.variantId, 'deactivate', undefined, actor());
          } else throw new Error('Unsupported test command');
          process.stdout.write(prefix + JSON.stringify({ id: command.id, result }) + '\\n');
        } catch (error) {
          process.stdout.write(prefix + JSON.stringify({ id: command?.id ?? 'unknown', error: String(error?.message ?? error) }) + '\\n');
        }
      }
      await app.close();
    `;
      catalogDbEnv = {
        ...catalogDbEnv,
        CATALOG_AMQP_ENABLED: 'true',
        RABBITMQ_URL: broker.catalogUrl,
        CATALOG_AMQP_PRODUCER_USERS: JSON.stringify({
          'pricing-svc': 'pricing-svc',
          'inventory-svc': 'inventory-svc',
          'taxonomy-svc': 'taxonomy-svc',
          'bulk-svc': 'bulk-svc',
        }),
      };
    }, 180000);

    afterAll(async () => {
      await pricing?.stop();
      await catalog?.stop();
      await pricingAdmin?.end();
      await catalogPostgres.stop().catch(() => undefined);
      await broker.stop().catch(() => undefined);
      await pricingPostgres.stop().catch(() => undefined);
      for (const directory of pricingRuntimeDirs) {
        const rel = relative(tmpdir(), directory);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel))
          await rm(directory, { recursive: true, force: true });
      }
    }, 60000);

    async function startCatalog(): Promise<void> {
      catalog = new ChildService(
        process.execPath,
        ['--input-type=module', '-e', catalogRunner],
        {
          cwd: catalogRoot,
          env: catalogDbEnv,
        },
      );
      const ready = await catalog.ready();
      if (
        ready.envHasRabbitmq !== true ||
        ready.configHasAmqp !== true ||
        ready.amqpRequired !== true ||
        ready.amqpReady !== true
      )
        throw new Error(
          `Catalog AMQP no está activo en el proceso real: ${JSON.stringify(ready)}.`,
        );
    }

    async function startPricing(): Promise<void> {
      const net = await import('node:net');
      const server = net.createServer();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      pricingPort = (server.address() as { port: number }).port;
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      const env = {
        NODE_ENV: 'test',
        PRICING_SVC_PORT: String(pricingPort),
        DATABASE_URL: pricingPostgres.runtimeUrl,
        PGSSLMODE: 'disable',
        PRICING_AMQP_URL: broker.pricingUrl,
        PRICING_PRICE_CHANGED_PUBLISH_ENABLED: 'false',
      };
      const runtimeDirectory = await mkdtemp(
        join(tmpdir(), 'pricing-catalog-runtime-'),
      );
      pricingRuntimeDirs.push(runtimeDirectory);
      pricing = new ChildService(
        process.execPath,
        [join(process.cwd(), 'dist/apps/pricing-svc/main.js')],
        {
          cwd: runtimeDirectory,
          env,
        },
      );
      await waitFor(async () => {
        const stats = await broker.channel!.checkQueue('po.precios.q');
        return stats.consumerCount === 1 ? true : undefined;
      }, 'consumidor Pricing en po.precios.q');
    }

    async function waitCatalogCheck(
      productId: string,
      status: 'COMPLETED' | 'REJECTED',
    ) {
      try {
        return await waitFor(
          async () => {
            const result = await catalogPostgres.admin!.query(
              `SELECT state, correlation_id, operation_id, result_payload, result_message_id FROM catalog.activation_checks WHERE product_id=$1 AND dependency='PRICING'`,
              [productId],
            );
            return result.rows[0]?.state === status
              ? (result.rows[0] as Record<string, unknown>)
              : undefined;
          },
          `resultado Catalog ${status}`,
          10000,
        );
      } catch (error) {
        const [inboxRows, outboxRows, queue, catalogOutbox, activation] =
          await Promise.all([
            pricingAdmin.query(
              `SELECT event_name, result FROM pricing.inbox ORDER BY created_at DESC LIMIT 5`,
            ),
            pricingAdmin.query(
              `SELECT event_name, published_at, last_error FROM pricing.outbox ORDER BY created_at DESC LIMIT 5`,
            ),
            broker.channel!.checkQueue('po.precios.q'),
            catalogPostgres.admin!.query(
              `SELECT event_name, published_at, attempts, last_error, payload FROM catalog.outbox WHERE payload->>'product_id'=$1 ORDER BY occurred_at`,
              [productId],
            ),
            catalogPostgres.admin!.query(
              `SELECT state, operation_id, request_payload FROM catalog.activation_checks WHERE product_id=$1 AND dependency='PRICING'`,
              [productId],
            ),
          ]);
        throw new Error(
          `${String(error)}; Catalog log=${catalog?.safeStdoutLog()}; Catalog stderr=${catalog?.safeStderr()}; Pricing log=${pricing?.safeStdoutLog()}; Pricing stderr=${pricing?.safeStderr()}; queue=${JSON.stringify({ messages: queue.messageCount, consumers: queue.consumerCount })}; activation=${JSON.stringify(activation.rows)}; Catalog outbox=${JSON.stringify(catalogOutbox.rows)}; Pricing inbox=${JSON.stringify(inboxRows.rows)}; Pricing outbox=${JSON.stringify(outboxRows.rows)}`,
        );
      }
    }

    it('usa Catalog #185 y Pricing como procesos reales: READY/REJECTED, baja SKU, duplicado, Inbox/Outbox y aislamiento', async () => {
      const pricingEntry = join(process.cwd(), 'dist/apps/pricing-svc/main.js');
      if (
        !(await import('node:fs/promises').then(({ access }) =>
          access(pricingEntry)
            .then(() => true)
            .catch(() => false),
        ))
      )
        throw new Error(
          'Compile Pricing antes de ejecutar el orquestador real.',
        );
      await startCatalog();
      await startPricing();

      const first = await catalog.request({
        action: 'create-product',
        sku: 'INTEGRATION-BASE-' + randomUUID(),
        variantSku: 'INTEGRATION-SKU-' + randomUUID(),
        hasVariants: true,
      });
      const product = first.result!.product as {
        product_id: string;
        sku_base: string;
      };
      const variant = first.result!.variant as {
        variant_id: string;
        sku: string;
      };
      const ready = await waitCatalogCheck(product.product_id, 'COMPLETED');
      const requestRows = await catalogPostgres.admin!.query(
        `SELECT * FROM catalog.outbox WHERE event_name='pricing.product.initialization.requested' AND payload->>'product_id'=$1`,
        [product.product_id],
      );
      expect(requestRows.rows).toHaveLength(1);
      expect(ready.correlation_id).toBe(requestRows.rows[0].correlation_id);
      expect(ready.operation_id).toBe(requestRows.rows[0].operation_id);
      expect(requestRows.rows[0].published_at).not.toBeNull();
      const pricingResult = await pricingAdmin.query(
        `SELECT * FROM pricing.outbox WHERE event_name='pricing.product.initialization.completed' AND operation_id=$1`,
        [ready.operation_id],
      );
      expect(pricingResult.rows).toHaveLength(1);
      expect(pricingResult.rows[0].causation_id).toBe(
        requestRows.rows[0].message_id,
      );
      expect(pricingResult.rows[0].published_at).not.toBeNull();

      await pricing.stop();
      const rejectedProductResult = await catalog.request({
        action: 'create-product',
        sku: 'INTEGRATION-REJECT-' + randomUUID(),
        hasVariants: false,
      });
      const rejectedProduct = rejectedProductResult.result!.product as {
        product_id: string;
        sku_base: string;
      };
      const pendingRequest = await broker.take('po.precios.q');
      const requestedEnvelope = JSON.parse(
        pendingRequest.content.toString('utf8'),
      ) as {
        message_id: string;
        correlation_id: string;
        operation_id: string;
        data: { product_id: string; sku_base: string };
      };
      expect(requestedEnvelope.data.product_id).toBe(
        rejectedProduct.product_id,
      );
      broker.channel!.nack(pendingRequest, false, true);
      const conflictingPriceId = randomUUID();
      await pricingAdmin.query('BEGIN');
      try {
        await pricingAdmin.query(
          `INSERT INTO pricing.prices(id,product_id,price_version) VALUES($1,$2,1)`,
          [conflictingPriceId, rejectedProduct.product_id],
        );
        await pricingAdmin.query(
          `INSERT INTO pricing.price_validities(price_id,precio_regular,precio_oferta,currency,valid_from,price_version,motivo_cambio,usuario_id) VALUES($1,'19.00',NULL,'PEN','2030-01-01T00:00:00Z',1,'FIXTURE_CONFLICT','integration-fixture')`,
          [conflictingPriceId],
        );
        await pricingAdmin.query('COMMIT');
      } catch (error) {
        await pricingAdmin.query('ROLLBACK');
        throw error;
      }
      await startPricing();
      const rejected = await waitCatalogCheck(
        rejectedProduct.product_id,
        'REJECTED',
      );
      expect(rejected.correlation_id).toBe(requestedEnvelope.correlation_id);
      expect((rejected.result_payload as Record<string, unknown>).status).toBe(
        'REJECTED',
      );
      const pricingRejected = await pricingAdmin.query(
        `SELECT * FROM pricing.outbox WHERE event_name='pricing.product.initialization.rejected' AND operation_id=$1`,
        [rejected.operation_id],
      );
      expect(pricingRejected.rows).toHaveLength(1);
      expect(pricingRejected.rows[0].causation_id).toBe(
        requestedEnvelope.message_id,
      );

      const skuStart = new Date(Date.now() - 3600000);
      const skuFuture = new Date(Date.now() + 3600000);
      const skuPriceId = randomUUID();
      const siblingSku = 'INTEGRATION-SIBLING-' + randomUUID();
      const siblingPriceId = randomUUID();
      const oldValidity = randomUUID();
      const futureValidity = randomUUID();
      const siblingValidity = randomUUID();
      const oldCorrelation = randomUUID();
      const futureCorrelation = randomUUID();
      const siblingCorrelation = randomUUID();
      await pricingAdmin.query('BEGIN');
      try {
        await pricingAdmin.query(
          `INSERT INTO pricing.prices(id,sku,channel_id,price_version) VALUES($1,$2,'INTEGRATION',3),($3,$4,'INTEGRATION',2)`,
          [skuPriceId, variant.sku, siblingPriceId, siblingSku],
        );
        await pricingAdmin.query(
          `INSERT INTO pricing.price_validities(id,price_id,precio_regular,currency,valid_from,valid_until,price_version,motivo_cambio,usuario_id) VALUES
        ($1,$2,'90.00','PEN','2020-01-01T00:00:00Z',$3,1,'BASE','integration-fixture'),
        ($4,$2,'95.00','PEN',$3,$5,2,'OLD_PENDING','integration-fixture'),
        ($6,$2,'99.00','PEN',$5,NULL,3,'FUTURE_PENDING','integration-fixture'),
        ($7,$8,'70.00','PEN','2020-01-01T00:00:00Z',NULL,2,'SIBLING_PENDING','integration-fixture')`,
          [
            randomUUID(),
            skuPriceId,
            skuStart,
            oldValidity,
            skuFuture,
            futureValidity,
            siblingValidity,
            siblingPriceId,
          ],
        );
        await pricingAdmin.query(
          `INSERT INTO pricing.scheduled_prices(price_id,validity_id,product_id,correlation_id,tipo_precio,importe,status) VALUES
        ($1,$2,$3,$4,'REGULAR','95.00','SCHEDULED'),($1,$5,$3,$6,'REGULAR','99.00','SCHEDULED'),($7,$8,$3,$9,'REGULAR','70.00','SCHEDULED')`,
          [
            skuPriceId,
            oldValidity,
            product.product_id,
            oldCorrelation,
            futureValidity,
            futureCorrelation,
            siblingPriceId,
            siblingValidity,
            siblingCorrelation,
          ],
        );
        await pricingAdmin.query('COMMIT');
      } catch (error) {
        await pricingAdmin.query('ROLLBACK');
        throw error;
      }
      await catalog.request({
        action: 'deactivate-variant',
        productId: product.product_id,
        variantId: variant.variant_id,
      });
      const skuOutbox = await waitFor(async () => {
        const result = await catalogPostgres.admin!.query(
          `SELECT * FROM catalog.outbox WHERE event_name='catalog.sku.deactivated' AND payload->>'sku'=$1`,
          [variant.sku],
        );
        const row = result.rows[0] as Record<string, unknown> | undefined;
        return row?.published_at ? row : undefined;
      }, 'Catalog sku.deactivated Outbox');
      expect(skuOutbox.published_at).not.toBeNull();
      const eventEnvelope = {
        message_id: skuOutbox.message_id,
        schema_version: skuOutbox.schema_version,
        occurred_at: (skuOutbox.occurred_at as Date).toISOString(),
        correlation_id: skuOutbox.correlation_id,
        causation_id: skuOutbox.causation_id,
        operation_id: skuOutbox.operation_id,
        producer: 'catalog-svc',
        kind: 'event',
        name: skuOutbox.event_name,
        data: skuOutbox.payload,
      };
      expect(
        (eventEnvelope.data as Record<string, unknown>).sku_version,
      ).toBeGreaterThan(0);
      await waitFor(async () => {
        const applied = await pricingAdmin.query(
          `SELECT result,correlation_id FROM pricing.inbox WHERE message_id=$1 AND handler='pricing.catalog-sku-deactivated.v1'`,
          [skuOutbox.message_id],
        );
        return applied.rows[0]?.result === 'APPLIED'
          ? (applied.rows[0] as Record<string, unknown>)
          : undefined;
      }, 'baja durable en Pricing Inbox');
      const scheduleRows = await pricingAdmin.query(
        `SELECT s.id,s.status,v.is_cancelled FROM pricing.scheduled_prices s JOIN pricing.price_validities v ON v.id=s.validity_id WHERE s.price_id IN ($1,$2) ORDER BY s.price_id,s.id`,
        [skuPriceId, siblingPriceId],
      );
      const skuRows = scheduleRows.rows.filter(
        (row) => row.status !== 'SCHEDULED',
      );
      expect(skuRows.map((row) => row.status).sort()).toEqual([
        'CANCELLED',
        'HISTORICAL',
      ]);
      expect(scheduleRows.rows.filter((row) => row.is_cancelled)).toHaveLength(
        1,
      );
      const sibling = scheduleRows.rows.find(
        (row) => row.status === 'SCHEDULED',
      );
      expect(sibling).toBeDefined();
      const basePreserved = await pricingAdmin.query(
        `SELECT price_version FROM pricing.prices WHERE product_id=$1 AND sku IS NULL AND channel_id IS NULL`,
        [product.product_id],
      );
      expect(basePreserved.rows).toHaveLength(1);

      const catalogPublisher = await connect(broker.catalogUrl, {
        timeout: 3000,
      });
      const duplicateChannel = await catalogPublisher.createConfirmChannel();
      duplicateChannel.on('error', () => undefined);
      const duplicateConfirmed = new Promise<void>((resolveConfirm, reject) => {
        duplicateChannel.publish(
          'po.eventos.x',
          'catalog.sku.deactivated',
          Buffer.from(JSON.stringify(eventEnvelope)),
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            messageId: String(skuOutbox.message_id),
            correlationId: String(skuOutbox.correlation_id),
            type: 'catalog.sku.deactivated',
            userId: broker.catalogUser,
          },
          (error) => (error ? reject(error) : resolveConfirm()),
        );
      });
      await duplicateConfirmed;
      await catalogPublisher.close();
      await waitFor(async () => {
        const rows = await pricingAdmin.query(
          `SELECT count(*)::int AS n FROM pricing.inbox WHERE message_id=$1 AND handler='pricing.catalog-sku-deactivated.v1'`,
          [skuOutbox.message_id],
        );
        return Number(rows.rows[0].n) === 1 ? true : undefined;
      }, 'deduplicación del evento repetido');
      const duplicateInbox = await pricingAdmin.query(
        `SELECT count(*)::int AS n FROM pricing.inbox WHERE message_id=$1 AND handler='pricing.catalog-sku-deactivated.v1'`,
        [skuOutbox.message_id],
      );
      expect(duplicateInbox.rows[0].n).toBe(1);
      const catalogInbox = await catalogPostgres.admin!.query(
        `SELECT count(*)::int AS n FROM catalog.inbox WHERE message_id=$1 AND handler='catalog.preparation-results.v1'`,
        [ready.result_message_id],
      );
      expect(Number(catalogInbox.rows[0].n)).toBe(1);
      expect(ready.correlation_id).toBe(requestRows.rows[0].correlation_id);
    }, 240000);
  },
);
