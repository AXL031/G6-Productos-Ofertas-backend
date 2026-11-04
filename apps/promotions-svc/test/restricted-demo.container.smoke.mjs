// Real Docker peers, production bootstrap, no published service ports or shared data.
// Tests the service boundary; does not certify Oracle's external Gateway perimeter.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { rootCertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.env.G6_PROMOTIONS_TEST_IMAGE ?? 'g6-service:promotions-svc-ci';
const directory = mkdtempSync(join(tmpdir(), 'g6-promotions-private-demo-'));
const certificate = join(directory, 'root.crt');
writeFileSync(certificate, rootCertificates[0]);
const network = 'g6-promotions-demo-' + randomUUID();
const created = [];
let networkCreated = false;
function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function run(alias, command, environment = {}) {
  const name = 'g6-promotions-demo-' + randomUUID();
  created.push(name);
  docker([
    'run', '--detach', '--name', name, '--network', network,
    '--network-alias', alias,
    '--mount', `type=bind,source=${certificate},target=/test-root.crt,readonly`,
    ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    ...(command ? ['--entrypoint', 'node'] : []), image,
    ...(command ? ['-e', command] : []),
  ]);
  return name;
}
function request(caller, target, path, method = 'POST', headers = {}) {
  const script = `const r = await fetch(${JSON.stringify('http://' + target + ':3004' + path)}, ${JSON.stringify({ method, headers: { 'content-type': 'application/json', ...headers }, ...(method === 'POST' ? { body: '{}' } : {}) })}); console.log(JSON.stringify({status:r.status,body:await r.json()}));`;
  return JSON.parse(docker(['exec', caller, 'node', '--input-type=module', '-e', script]));
}
try {
  docker(['network', 'create', '--internal', network]);
  networkCreated = true;
  const gateway = run('g6-api-gateway', 'setInterval(() => {}, 1000)');
  const neighbor = run('untrusted-peer', 'setInterval(() => {}, 1000)');
  const environment = {
    NODE_ENV: 'production', PORT: '3004', PROMOTIONS_SVC_PORT: '3004',
    PGHOST: '127.0.0.1', PGPORT: '1', PGDATABASE: 'isolated', PGUSER: 'isolated',
    PGPASSWORD: randomUUID(), PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/test-root.crt',
    G6_DATABASE_SCHEMA: 'promotions', G6_CONNECTION_MODE: 'session',
    RABBITMQ_URL: 'amqp://isolated:synthetic@127.0.0.1:1/test',
    PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'false', PROMOTIONS_COUPON_RUNTIME_ENABLED: 'false',
    AUTH_ISSUER: 'https://issuer.invalid', AUTH_JWKS_URL: 'https://issuer.invalid/jwks',
  };
  const demo = run('promotions-demo', undefined, { ...environment, GATEWAY_DEMO_NO_AUTH_ENABLED: 'true' });
  const authenticated = run('promotions-auth', undefined, environment);
  for (const name of [demo, authenticated]) {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        docker(['exec', name, 'node', '-e', "fetch('http://127.0.0.1:3004/health').then(r => { if (!r.ok) process.exit(1); })"]);
        ready = true;
        break;
      } catch { await delay(250); }
    }
    assert.ok(ready, 'production container starts');
    assert.equal(docker(['inspect', name, '--format', '{{json .HostConfig.PortBindings}}']), '{}');
  }
  const nominal = request(gateway, 'promotions-demo', '/api/v1/cupones');
  assert.equal(nominal.status, 400);
  assert.equal(nominal.body.code, 'VALIDACION');
  assert.equal(request(gateway, 'promotions-demo', '/api/v1/cupones', 'POST', { Authorization: 'Bearer untrusted' }).status, 400);
  const spoofed = request(neighbor, 'promotions-demo', '/api/v1/cupones', 'POST', {
    'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1',
    'X-User-Role': 'GESTOR_COMERCIAL', Authorization: 'Bearer untrusted',
  });
  assert.equal(spoofed.status, 403);
  assert.equal(spoofed.body.code, 'SCOPE_INSUFICIENTE');
  assert.equal(request(gateway, 'promotions-demo', '/api/v1/not-contractual', 'GET').status, 404);
  assert.equal(request(gateway, 'promotions-auth', '/api/v1/cupones').status, 401);
  assert.equal(request(gateway, 'promotions-auth', '/api/v1/cupones', 'POST', { Authorization: 'Bearer untrusted' }).status, 401);
  const missing = request(gateway, 'promotions-demo', '/api/v1/promociones/evaluar');
  assert.equal(missing.status, 400); // DTO still validated before unavailable upstreams.
  console.log(JSON.stringify({
    status: 'PASS', imageId: docker(['image', 'inspect', image, '--format', '{{.Id}}']),
    environment: 'isolated Docker internal network, NODE_ENV=production',
    checks: ['Gateway TCP peer reaches real validation without JWT', 'untrusted neighbor with spoofed headers denied', 'no published service ports', 'unknown route 404', 'flag absent restores JWT 401', 'invalid bearer never enables fallback'],
    persistence: 'not asserted here; separate PostgreSQL suite',
    externalPerimeter: 'PENDING_ORACLE', couponRuntime: 'disabled',
  }));
} finally {
  for (const name of created.reverse()) {
    try { docker(['rm', '--force', name]); } catch { /* already stopped */ }
  }
  if (networkCreated) docker(['network', 'rm', network]);
  const target = resolve(directory);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep));
  rmSync(target, { recursive: true, force: true });
}
