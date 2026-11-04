// #78 single entry for all currently implementable local flows. Never accepts
// shared database/broker URLs, activates production flags, or claims G7/G5 E2E.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const frontend = process.env.G6_PROMOTIONS_FRONTEND_ROOT;
if (
  !frontend ||
  !existsSync(join(frontend, 'tests/promotions-session-gateway.spec.ts'))
)
  throw new Error('G6_PROMOTIONS_FRONTEND_ROOT_REQUIRED_WITH_SESSION_TEST');
const output = resolve(
  process.env.G6_PROMOTIONS_E2E_OUTPUT_DIR ??
    'node_modules/.cache/promotions-work/flow-e2e',
);
mkdirSync(output, { recursive: true });
function source(root, paths) {
  const git = (args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  const files = git([
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    ...paths,
  ])
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const manifest = files.map((file) => [
    file,
    createHash('sha256')
      .update(readFileSync(join(root, file)))
      .digest('hex'),
  ]);
  return {
    sha: git(['rev-parse', 'HEAD']),
    branch: git(['branch', '--show-current']),
    workingTree: git(['status', '--porcelain']) ? 'MODIFIED' : 'CLEAN',
    files: manifest,
    contentHash: createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex'),
  };
}
const sources = () => ({
  backend: source(process.cwd(), [
    'apps/promotions-svc/src',
    'apps/promotions-svc/test',
  ]),
  frontend: source(resolve(frontend), [
    'src/main.tsx',
    'src/app/config',
    'src/features/promotions',
    'tests/promotions*',
    'tests/harness/promotions*',
  ]),
});
const initial = sources();
const stages = [];
let current;
async function run(name, file) {
  current = name;
  console.log('Running isolated ' + name);
  const child = spawn(process.execPath, [file], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      G6_PROMOTIONS_FRONTEND_ROOT: resolve(frontend),
      G6_PROMOTIONS_E2E_OUTPUT_DIR: join(output, 'gateway'),
    },
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (value) => {
    stdout += value;
  });
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  const code = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('exit', resolveExit);
  });
  writeFileSync(join(output, name + '.log'), stdout + stderr);
  assert.equal(code, 0, name + ' failed; see its isolated log');
  const report =
    name === 'gateway'
      ? JSON.parse(
          readFileSync(join(output, 'gateway/gateway-evidence.json'), 'utf8'),
        )
      : JSON.parse(stdout);
  assert.equal(report.status ?? report.result, 'PASS');
  assert.equal(report.sharedWrites ?? report.shared_writes, false);
  stages.push({ name, status: 'PASS', report });
  console.log('PASS ' + name);
}
let passed = false;
try {
  await run('gateway', 'apps/promotions-svc/test/gateway.isolated.smoke.mjs');
  assert.equal(stages[0].report.frontend.session.status, 'PASS');
  assert.equal(stages[0].report.frontend.session.browserTests, 5);
  await run('amqp', 'apps/promotions-svc/test/coupons.isolated.smoke.mjs');
  const final = sources();
  for (const name of ['backend', 'frontend']) {
    assert.equal(
      final[name].sha,
      initial[name].sha,
      'source SHA changed during flow',
    );
    assert.equal(
      final[name].contentHash,
      initial[name].contentHash,
      'source files changed during flow',
    );
  }
  passed = true;
} catch {
  console.error(
    'FAIL isolated ' + current + '; see flow-evidence.json and stage logs',
  );
  process.exitCode = 1;
} finally {
  const evidence = {
    status: passed ? 'PASS' : 'FAIL',
    scope: 'LOCAL_DISPOSABLE_ONLY',
    capturedAt: new Date().toISOString(),
    node: process.version,
    sources: initial,
    stages,
    dimensions: {
      localFlow: passed ? 'PASS' : 'FAIL',
      authenticatedExternal: 'NOT_EXECUTED',
      homologation: 'NOT_DONE',
      deployment: 'NOT_EXECUTED',
    },
    fixtures: [
      'G7 published-contract session issuer and HTTPS JWKS',
      'durable commercial/reservation facts and explicit assigned-event decoders',
    ],
    sharedWrites: false,
    productionConsumerEnabled: false,
  };
  writeFileSync(
    join(output, 'flow-evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({
      status: evidence.status,
      scope: evidence.scope,
      stages: stages.map((s) => s.name),
      sharedWrites: false,
    }),
  );
}
