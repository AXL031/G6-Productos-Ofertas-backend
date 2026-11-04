// Native processes and HTTP only across service boundaries. No Gateway edits,
// provider overrides, fake persistence, auth bypass or shared credentials.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer as httpsServer } from 'node:https';
import { createServer as netServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PromotionsPersistence } from '../../../../dist/apps/promotions-svc/infrastructure/persistence/promotions-persistence.js';
import { httpContracts } from '../../../../dist/apps/promotions-svc/http/http-contract.generated.js';
import { valid } from '../../../../dist/apps/promotions-svc/http/http-validation.js';
import { createG7SessionFixture } from './g7-session-fixture.mjs';
import { verifySessionGatewayFlow } from './session-gateway-checks.mjs';

async function freePort() {
  const server = netServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function ready(url, children) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (children.some((c) => c.exitCode !== null))
      throw new Error('ISOLATED_CHILD_EXITED');
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch {
      /* bounded startup polling, never business retry */
    }
    await delay(250);
  }
  throw new Error('ISOLATED_CHILD_START_TIMEOUT');
}
function gitSha(root) {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}
function workingTree(root) {
  return execFileSync('git', ['-C', root, 'status', '--porcelain'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
    ? 'MODIFIED'
    : 'CLEAN';
}
export async function verifyGatewayFlow(resources, baseConfig, directory) {
  const checks = [],
    children = [],
    logs = [];
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid: 'gateway-isolated-key',
    alg: 'RS256',
    use: 'sig',
  };
  let jwksRequests = 0;
  let sessionFixture;
  const auth = httpsServer(
    {
      cert: readFileSync(join(directory, 'server.crt')),
      key: readFileSync(join(directory, 'server.key')),
    },
    async (req, res) => {
      if (await sessionFixture?.handle(req, res)) return;
      if (req.url !== '/jwks') {
        res.writeHead(404).end();
        return;
      }
      jwksRequests++;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ keys: [jwk] }));
    },
  );
  auth.listen(0, '127.0.0.1');
  await once(auth, 'listening');
  const issuer = 'https://127.0.0.1:' + auth.address().port;
  function token(changes = {}) {
    const now = Math.floor(Date.now() / 1000);
    const parts = [
      { alg: 'RS256', kid: jwk.kid, typ: 'JWT' },
      {
        iss: issuer,
        sub: randomUUID(),
        tipo: 'acceso',
        roles: ['GESTOR_COMERCIAL'],
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        ...changes,
      },
    ].map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'));
    return (
      parts.join('.') +
      '.' +
      sign(
        'RSA-SHA256',
        Buffer.from(parts.join('.')),
        pair.privateKey,
      ).toString('base64url')
    );
  }
  const user = token(),
    forbidden = token({ roles: ['LECTOR'] });
  sessionFixture = createG7SessionFixture(token);
  const service = token({
    tipo: 'servicio',
    sub: 'modulo-marketplace',
    aud: ['api-productos'],
    scope:
      'promociones:leer promociones:evaluar cupones:validar recomendaciones:leer',
    roles: undefined,
  });
  const db = baseConfig.settings.database;
  const start = (file, env, cwd = directory) => {
    const child = spawn(process.execPath, [file], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    child.on('error', () => {
      logs.push('ISOLATED_CHILD_SPAWN_FAILED');
    });
    child.stdout.on('data', (v) => logs.push(v.toString()));
    child.stderr.on('data', (v) => logs.push(v.toString()));
    children.push(child);
    return child;
  };
  const env = {
    ...process.env,
    ENV_FILE: undefined,
    NODE_ENV: 'test',
    AUTH_ISSUER: issuer,
    AUTH_JWKS_URL: issuer + '/jwks',
    NODE_EXTRA_CA_CERTS: join(directory, 'server.crt'),
    NODE_TLS_REJECT_UNAUTHORIZED: '1',
    PGHOST: db.host,
    PGPORT: String(db.port),
    PGDATABASE: db.database,
    PGUSER: db.user,
    PGPASSWORD: db.password,
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: db.sslRootCert,
    G6_DATABASE_SCHEMA: 'promotions',
    G6_CONNECTION_MODE: 'session',
    RABBITMQ_URL: baseConfig.settings.rabbitmqUrl,
    PROMOTIONS_COUPON_RUNTIME_ENABLED: 'false',
    PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'false',
  };
  try {
    const persistence = new PromotionsPersistence(resources.pool);
    const from = new Date(Date.now() - 86400000).toISOString(),
      until = new Date(Date.now() + 30 * 86400000).toISOString();
    const seeded = await persistence.transaction(async (r) => {
      const campaign = await r.promotions.create(
        {
          name: 'GATEWAY-CUPON-FIXTURE',
          discountType: 'PORCENTAJE',
          discountValue: '10',
          modality: 'CUPON',
          state: 'ACTIVO',
          validFrom: from,
          validUntil: until,
          priority: 1,
          enabledChannels: ['MARKETPLACE'],
        },
        [{ sku: 'GATEWAY-SKU' }],
        { pricingOffer: false, automaticPromotion: false, coupon: false },
      );
      const rule = await r.recommendations.create(
        {
          name: 'GATEWAY-REGLA-FIXTURE',
          recommendationType: 'CROSS_SELL',
          originType: 'PRODUCTO',
          originId: 'GATEWAY-ORIGIN',
          priority: 1,
          state: 'INACTIVO',
          validFrom: from,
          validUntil: until,
        },
        [{ productId: 'GATEWAY-TARGET', itemOrder: 1 }],
      );
      return { campaign, rule };
    });
    const before = await resources.pool.query(
      'SELECT (SELECT count(*)::int FROM promotions.coupon_uses) AS uses, (SELECT count(*)::int FROM promotions.coupon_command_receipts) AS receipts, (SELECT count(*)::int FROM promotions.inbox) AS inbox, (SELECT count(*)::int FROM promotions.outbox) AS outbox',
    );
    const promotionPort = await freePort();
    start(resolve('dist/apps/promotions-svc/main.js'), {
      ...env,
      PORT: String(promotionPort),
      PROMOTIONS_SVC_PORT: String(promotionPort),
    });
    await ready('http://127.0.0.1:' + promotionPort + '/health', children);
    const gatewayPort = await freePort(),
      gateway = 'http://127.0.0.1:' + gatewayPort;
    const gatewayChild = start(resolve('dist/apps/api-gateway/main.js'), {
      ...env,
      API_GATEWAY_PORT: String(gatewayPort),
      PORT: String(gatewayPort),
      GATEWAY_PROMOTIONS_SVC_URL: 'http://127.0.0.1:' + promotionPort,
      GATEWAY_TIMEOUT_MS: '5000',
    });
    await ready(gateway + '/health', children);
    async function call(id, path, body, expected = 200, bearer = user) {
      const trace = randomUUID();
      const response = await fetch(gateway + '/api/v1' + path, {
        method: httpContracts[id].method,
        headers: {
          ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
          'X-Correlation-Id': trace,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await response.json();
      assert.equal(
        response.status,
        expected,
        id + ' expected HTTP ' + expected,
      );
      assert.equal(response.headers.get('x-correlation-id'), trace);
      if (expected < 400)
        assert.equal(
          valid(data, httpContracts[id].response),
          true,
          id + ' official DTO',
        );
      else {
        assert.equal(data.status, expected);
        assert.equal(data.correlationId, trace);
        assert.match(
          response.headers.get('content-type'),
          /^application\/problem\+json/,
        );
        assert.ok(
          httpContracts[id].errors[String(expected)].includes(data.code),
        );
        assert.equal(JSON.stringify(data).includes(db.password), false);
        assert.ok(typeof data.code === 'string');
      }
      return data;
    }
    await call('listarCupones', '/cupones', undefined, 401, '');
    await call('listarCupones', '/cupones', undefined, 403, forbidden);
    await call(
      'listarCupones',
      '/cupones',
      undefined,
      401,
      user.slice(0, -12) + 'invalid',
    );
    await call('listarCupones', '/cupones', undefined, 401, token({ exp: 1 }));
    await call('listarCupones', '/cupones', undefined, 403, service);
    await call(
      'listarPromociones',
      '/promociones?canal=MARKETPLACE',
      undefined,
      200,
      service,
    );
    const input = {
      codigo: 'GATEWAY_API',
      promocionId: seeded.campaign.id,
      estado: 'INACTIVO',
      montoMinimo: null,
      maxUsosGlobal: 4,
      maxUsosPorCliente: null,
      politicaCancelacion: 'RESTAURAR_EN_CANCELACION',
    };
    const created = await call('crearCupon', '/cupones', input, 201);
    await call('crearCupon', '/cupones', input, 409);
    await call(
      'crearCupon',
      '/cupones',
      { ...input, codigo: 'BAD', maxUsosGlobal: 0 },
      400,
    );
    await call('obtenerCuponAdmin', '/cupones/' + randomUUID(), undefined, 404);
    await call('actualizarCupon', '/cupones/' + created.cuponId, {
      codigo: 'GATEWAY_UPDATED',
      maxUsosGlobal: null,
    });
    await call('activarCupon', '/cupones/' + created.cuponId + '/activar');
    await call(
      'desactivarCupon',
      '/cupones/' + created.cuponId + '/desactivar',
    );
    const confirmed = await call(
      'obtenerCuponAdmin',
      '/cupones/' + created.cuponId,
    );
    assert.equal(confirmed.codigo, 'GATEWAY_UPDATED');
    assert.equal(confirmed.estado, 'INACTIVO');
    assert.equal(confirmed.usosGlobalesConsumidos, 0);
    assert.equal(confirmed.maxUsosGlobal, null);
    await call('obtenerPromocionAdmin', '/promociones/' + seeded.campaign.id);
    await call('listarReglasRecomendacion', '/recomendaciones/reglas');
    await call(
      'obtenerReglaRecomendacion',
      '/recomendaciones/reglas/' + seeded.rule.id,
    );
    await call(
      'evaluarPromociones',
      '/promociones/evaluar',
      {
        channel_id: 'MARKETPLACE',
        lines: [{ sku: 'GATEWAY-SKU', quantity: 1 }],
      },
      503,
      service,
    );
    checks.push(
      'native Gateway and Promotions validate real RS256 JWT via HTTPS JWKS; valid/expired/tampered/role/service checks return 200/401/403 without auth overrides',
    );
    checks.push(
      'Gateway→Promotions→restricted PostgreSQL/TLS: create/read/patch/activate/deactivate coupon, 400/409/404, DTOs and correlation; production commercial gate remains 503',
    );
    assert.ok(jwksRequests >= 2, 'both native processes fetched JWKS');
    let frontendEvidence = {
      status: 'NOT_EXECUTED',
      reason: 'G6_PROMOTIONS_FRONTEND_ROOT not supplied',
    };
    if (process.env.G6_PROMOTIONS_FRONTEND_ROOT) {
      const frontend = resolve(process.env.G6_PROMOTIONS_FRONTEND_ROOT);
      if (!existsSync(join(frontend, 'tests/promotions-gateway.spec.ts')))
        throw new Error('FRONTEND_GATEWAY_TEST_MISSING');
      const requireFrontend = createRequire(join(frontend, 'package.json'));
      const vitePort = await freePort(),
        browserBase = 'http://127.0.0.1:' + vitePort;
      const viteConfig = join(directory, 'vite.gateway.config.mjs');
      writeFileSync(
        viteConfig,
        'import react from ' +
          JSON.stringify(
            pathToFileURL(requireFrontend.resolve('@vitejs/plugin-react')).href,
          ) +
          ';\nexport default {root:' +
          JSON.stringify(frontend) +
          ',clearScreen:false,plugins:[react()],server:' +
          JSON.stringify({
            host: '127.0.0.1',
            port: vitePort,
            strictPort: true,
            proxy: { '/api': gateway },
          }) +
          '};',
      );
      // A test-only middleware serves the harness for commercial browser routes.
      // The regular Vite config and production entrypoint remain untouched.
      const configSource = readFileSync(viteConfig, 'utf8').replace(
        'plugins:[react()]',
        'plugins:[react(),{name:"isolated-promotions-harness",configureServer(server){server.middlewares.use((req,_res,next)=>{if(/^\\/(cupones|promociones|recomendaciones)(\\/|\\?|$)/.test(req.url||"")) req.url="/tests/harness/promotions-http.html";next();});}}]',
      );
      writeFileSync(viteConfig, configSource);
      const viteChild = spawn(
        process.execPath,
        [
          join(
            dirname(requireFrontend.resolve('vite/package.json')),
            'bin/vite.js',
          ),
          '--config',
          viteConfig,
          '--configLoader',
          'native',
        ],
        {
          cwd: frontend,
          env: { ...process.env, VITE_DATA_MODE: 'api' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      viteChild.stdout.on('data', (v) => logs.push(v.toString()));
      viteChild.stderr.on('data', (v) => logs.push(v.toString()));
      children.push(viteChild);
      await ready(
        browserBase + '/tests/harness/promotions-http.html',
        children,
      );
      const evidenceDir = resolve(
        process.env.G6_PROMOTIONS_E2E_OUTPUT_DIR ??
          'node_modules/.cache/promotions-work/gateway-e2e',
      );
      mkdirSync(evidenceDir, { recursive: true });
      const testConfig = join(directory, 'playwright.gateway.config.mjs');
      writeFileSync(
        testConfig,
        'export default ' +
          JSON.stringify({
            testDir: join(frontend, 'tests'),
            testMatch: 'promotions-gateway.spec.ts',
            workers: 1,
            timeout: 60000,
            outputDir: join(evidenceDir, 'playwright'),
            use: {
              baseURL: browserBase,
              viewport: { width: 1440, height: 900 },
            },
          }) +
          ';',
      );
      const testChild = spawn(
        process.execPath,
        [
          join(
            dirname(requireFrontend.resolve('@playwright/test/package.json')),
            'cli.js',
          ),
          'test',
          '--config',
          testConfig,
          '--reporter=line',
        ],
        {
          cwd: frontend,
          env: {
            ...process.env,
            PROMOTIONS_E2E_BASE_URL: browserBase,
            PROMOTIONS_E2E_TOKEN: user,
            PROMOTIONS_E2E_FORBIDDEN_TOKEN: forbidden,
            PROMOTIONS_E2E_CAMPAIGN_ID: seeded.campaign.id,
            PROMOTIONS_E2E_RULE_ID: seeded.rule.id,
            PROMOTIONS_E2E_EVIDENCE: evidenceDir,
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let testOutput = '';
      testChild.stdout.on('data', (v) => {
        testOutput += v.toString();
      });
      testChild.stderr.on('data', (v) => {
        testOutput += v.toString();
      });
      const [code] = await once(testChild, 'exit');
      writeFileSync(
        join(evidenceDir, 'browser-results.log'),
        testOutput
          .replaceAll(user, '[synthetic-token]')
          .replaceAll(forbidden, '[synthetic-token]'),
      );
      assert.equal(
        code,
        0,
        'real browser flow; see sanitized browser-results.log',
      );
      frontendEvidence = {
        status: 'PASS',
        sha: gitSha(frontend),
        workingTree: workingTree(frontend),
        viewport: '1440x900',
        playwrightVersion: requireFrontend('@playwright/test/package.json')
          .version,
        screenshots: [
          'gateway-coupons-1440.png',
          'gateway-session-error-1440.png',
        ],
        transport:
          'browser→test-only same-origin Vite proxy→native Gateway→native Promotions→real PostgreSQL/TLS',
      };
      checks.push(
        'real React pages through Gateway: persistent coupon create/edit/state, reload, visible 401/403/404/409, no mock fallback, 1440px screenshots',
      );
      const uiCoupon = await persistence.read((r) =>
        r.coupons.findByCode('UI_GATEWAY'),
      );
      assert.equal(uiCoupon.maxGlobalUses, 5);
      assert.equal(uiCoupon.state, 'ACTIVO');
      frontendEvidence.session = await verifySessionGatewayFlow({
        frontend,
        port: await freePort(),
        gateway,
        issuer,
        certificate: join(directory, 'server.crt'),
        directory,
        evidenceDir,
        fixture: sessionFixture,
      });
      const sessionCoupon = await persistence.read((r) =>
        r.coupons.findByCode('UI_SESSION'),
      );
      assert.equal(sessionCoupon.maxGlobalUses, 7);
      assert.equal(sessionCoupon.state, 'ACTIVO');
      checks.push(
        'full main entry: G7 contract login/MFA/refresh/logout fixture → native Gateway/Promotions → real PG; CRUD/reload, 409, signed expired JWT renewal, revoked refresh and real role 403; no injected browser tokens',
      );
    }
    const after = await resources.pool.query(
      'SELECT (SELECT count(*)::int FROM promotions.coupon_uses) AS uses, (SELECT count(*)::int FROM promotions.coupon_command_receipts) AS receipts, (SELECT count(*)::int FROM promotions.inbox) AS inbox, (SELECT count(*)::int FROM promotions.outbox) AS outbox',
    );
    assert.deepEqual(after.rows, before.rows);
    checks.push(
      'administration/evaluation through Gateway and React create no uses, receipts, Inbox or Outbox effects',
    );
    assert.equal(logs.join('').includes(db.password), false);
    assert.equal(logs.join('').includes(user), false);
    assert.equal(gatewayChild.exitCode, null);
    const evidence = {
      status: 'PASS',
      backendSha: gitSha(process.cwd()),
      backendWorkingTree: workingTree(process.cwd()),
      frontend: frontendEvidence,
      environment: 'DISPOSABLE_LOCAL_ONLY',
      node: process.version,
      platform: process.platform,
      jwks: 'real HTTPS fixture, not G7',
      sessionProvider:
        'G7 published contract fixture only; shared G7 not tested',
      checks,
      sharedWrites: false,
      deployedE2E: 'NOT_EXECUTED',
      externalHomologation: 'NOT_DONE',
    };
    const target = resolve(
      process.env.G6_PROMOTIONS_E2E_OUTPUT_DIR ??
        'node_modules/.cache/promotions-work/gateway-e2e',
    );
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'gateway-evidence.json'),
      JSON.stringify(evidence, null, 2),
    );
    return checks;
  } catch (error) {
    const target = resolve(
      process.env.G6_PROMOTIONS_E2E_OUTPUT_DIR ??
        'node_modules/.cache/promotions-work/gateway-e2e',
    );
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'gateway-diagnostics.log'),
      sessionFixture.redact(
        logs
          .join('')
          .replaceAll(db.password, '[synthetic-secret]')
          .replaceAll(user, '[synthetic-token]')
          .replaceAll(forbidden, '[synthetic-token]') +
          '\n' +
          (error instanceof Error ? error.message : 'ISOLATED_FAILURE'),
      ),
    );
    throw error;
  } finally {
    for (const child of children.reverse()) {
      if (child.exitCode !== null) continue;
      const closing = once(child, 'exit');
      child.kill();
      await Promise.race([closing, delay(5000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await new Promise((done) => auth.close(done));
  }
}
