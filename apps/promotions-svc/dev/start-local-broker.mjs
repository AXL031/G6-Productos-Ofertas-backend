import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';

const filename = 'apps/promotions-svc/.env.local';
const original = readFileSync(filename, 'utf8');
const environment = parseEnv(original);
const require = createRequire(resolve('package.json'));
const amqp = require('amqplib');
let created;
let complete = false;
function docker(args, env = process.env) {
  const result = spawnSync('docker', args, {
    env,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('LOCAL_BROKER_DOCKER_FAILED');
  return result.stdout.trim();
}
try {
  if (environment.RABBITMQ_URL?.trim()) {
    console.log(
      JSON.stringify({
        result: 'SKIPPED',
        reason: 'EXISTING_BROKER_CONFIGURATION_PRESERVED',
      }),
    );
  } else {
    const name = 'g6-promotions-local-' + randomUUID();
    const user = 'promotions_local';
    const password = randomUUID();
    created = docker(
      [
        'run',
        '--rm',
        '--detach',
        '--name',
        name,
        '--label',
        'g6.scope=local-development',
        '--publish',
        '127.0.0.1::5672',
        '--env',
        'RABBITMQ_DEFAULT_USER',
        '--env',
        'RABBITMQ_DEFAULT_PASS',
        'rabbitmq:4.1-alpine',
      ],
      {
        ...process.env,
        RABBITMQ_DEFAULT_USER: user,
        RABBITMQ_DEFAULT_PASS: password,
      },
    );
    const ports = JSON.parse(
      docker([
        'inspect',
        created,
        '--format',
        '{{json .NetworkSettings.Ports}}',
      ]),
    );
    const port = Number(ports['5672/tcp'][0].HostPort);
    const url = `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}`;
    let connected = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        const connection = await amqp.connect(url, { timeout: 1000 });
        connection.on('error', () => undefined);
        await connection.close();
        connected = true;
        break;
      } catch {
        await delay(500);
      }
    }
    if (!connected) throw new Error('LOCAL_BROKER_START_TIMEOUT');
    if (readFileSync(filename, 'utf8') !== original)
      throw new Error('LOCAL_ENV_CHANGED_DURING_SETUP');
    const line = 'RABBITMQ_URL=' + JSON.stringify(url);
    const next = /^RABBITMQ_URL=.*$/m.test(original)
      ? original.replace(/^RABBITMQ_URL=.*$/m, line)
      : original.trimEnd() + '\n' + line + '\n';
    writeFileSync(filename, next);
    complete = true;
    console.log(
      JSON.stringify(
        {
          result: 'PASS',
          scope: 'LOCAL_DEVELOPMENT_ONLY',
          container: name,
          host: '127.0.0.1',
          port,
          environment_file: filename,
          credentials_printed: false,
          shared_topology_changed: false,
          stop: `docker stop ${name}`,
        },
        null,
        2,
      ),
    );
  }
} catch {
  console.error('LOCAL_BROKER_SETUP_FAILED');
  process.exitCode = 1;
} finally {
  if (created && !complete) docker(['rm', '--force', created]);
}
