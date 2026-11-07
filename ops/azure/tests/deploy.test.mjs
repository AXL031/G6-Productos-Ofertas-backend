import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

const repo = resolve('.');
const bash = process.env.G6_TEST_BASH ?? (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? '', 'Programs/Git/bin/bash.exe') : 'bash');
const posix = path => path.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => '/' + drive.toLowerCase() + '/');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const sha = 'a'.repeat(40), digest = 'sha256:' + 'b'.repeat(64), oldDigest = 'sha256:' + 'c'.repeat(64);
const registry = 'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc';
const next = registry + '@' + digest, old = registry + '@' + oldDigest;

// This is a command/state simulation of the actual executor, not a VM deployment
// or proof of registry connectivity. No Docker/SSH/Azure command is run here.
function run(scenario = {}, command = `service-deploy catalog-svc ${sha} ${digest}`) {
  const root = mkdtempSync(join(tmpdir(), 'g6-azure-executor-'));
  const unix = posix(root);
  try {
    const paths = ['bin', 'etc/g6-catalog-svc', 'opt/g6-productos-ofertas/shared', 'var/lib/g6-productos-ofertas/catalog-svc'];
    for (const path of paths) mkdirSync(join(root, path), { recursive: true });
    const rewrite = source => source.replaceAll('\r\n', '\n').replaceAll('/etc/', unix + '/etc/').replaceAll('/opt/', unix + '/opt/').replaceAll('/var/lib/', unix + '/var/lib/');
    for (const name of ['service-registry.sh', 'services.psv'])
      writeFileSync(join(root, name), rewrite(readFileSync(join(repo, 'ops/oracle', name), 'utf8')));
    let engine = rewrite(readFileSync(join(repo, 'ops/azure/deploy-g6-service.sh'), 'utf8'));
    engine = engine.replaceAll('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'PATH=' + unix + '/bin:/usr/bin:/bin');
    // Three immediate polls test both branches; production keeps its 30 bounded polls.
    engine = engine.replaceAll('{1..30}', '{1..3}');
    writeFileSync(join(root, 'deploy.sh'), engine);
    writeFileSync(join(root, 'etc/g6-catalog-svc/runtime.env'), 'FIXTURE_ONLY=true\n');
    writeFileSync(join(root, 'opt/g6-productos-ofertas/shared/docker-compose.service.yml'), 'services: {}\n');
    writeFileSync(join(root, 'opt/g6-productos-ofertas/shared/docker-compose.service.http.yml'), 'services: {}\n');
    const state = { ...scenario, active: scenario.firstDeploy ? null : old, events: [], sha, next };
    writeFileSync(join(root, 'state.json'), JSON.stringify(state));
    const stateFile = join(root, 'var/lib/g6-productos-ofertas/catalog-svc/active-image');
    if (state.active) writeFileSync(stateFile, state.active + '\n');
    writeFileSync(join(root, 'mock.mjs'), `
      import { readFileSync, writeFileSync } from 'node:fs';
      const file=${JSON.stringify(join(root, 'state.json'))};
      const s=JSON.parse(readFileSync(file,'utf8')), args=process.argv.slice(3), tool=process.argv[2];
      const save=()=>writeFileSync(file,JSON.stringify(s));
      if(tool==='jq') { const body=JSON.parse(readFileSync(0,'utf8')); process.exit(body.status==='ready' && body.service==='catalog-svc'?0:1); }
      if(tool==='curl') { if(args.at(-1).endsWith('/health/ready')) { if(s.notReady && s.active===s.next) process.exit(22); console.log(JSON.stringify({status:'ready',service:'catalog-svc'})); } process.exit(0); }
      if(args[0]==='network') { console.log(args.includes('--format') && args[3].includes('.Driver')?'bridge|local|false|false|false|false|default|1|0':''); process.exit(0); }
      if(args[0]==='image') { const format=args[3]; console.log(format.includes('RepoDigests')?(s.digestMismatch?'wrong-digest':s.next):(s.revisionMismatch?'wrong-revision':s.sha)); process.exit(0); }
      if(args[0]==='inspect') { if(!s.active) process.exit(1); console.log(args[2].includes('Config.Image')?s.active:(s.unhealthy && s.active===s.next?'unhealthy':'healthy')); process.exit(0); }
      if(args[0]==='compose') {
        if(args.includes('pull')) { s.events.push('pull'); save(); process.exit(s.pullFailure?1:0); }
        if(args.includes('up')) { s.active=process.env.G6_SERVICE_IMAGE; s.events.push('up:'+s.active); save(); process.exit(s.startFailure && s.active===s.next?1:0); }
        if(args.includes('rm')) { s.active=null; s.events.push('remove'); save(); process.exit(0); }
      }
      process.exit(99);
    `);
    for (const tool of ['docker', 'curl', 'jq'])
      writeFileSync(join(root, 'bin', tool), '#!/usr/bin/env bash\nexec ' + quote(posix(process.execPath)) + ' ' + quote(join(root, 'mock.mjs').replaceAll('\\', '/')) + ' ' + tool + ' "$@"\n', { mode: 0o755 });
    for (const tool of ['flock', 'sleep']) writeFileSync(join(root, 'bin', tool), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(root, 'bin/timeout'), '#!/usr/bin/env bash\nshift\nexec "$@"\n', { mode: 0o755 });
    const result = spawnSync(bash, ['-c', 'export PATH=' + quote(unix + '/bin') + ':"$PATH"; exec bash ' + quote(posix(join(root, 'deploy.sh')))], { env: {
      ...process.env,
      SSH_ORIGINAL_COMMAND: command, MSYS_NO_PATHCONV: '1',
    }, input: '', encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (result.error) throw result.error;
    return { code: result.status, log: result.stdout + result.stderr,
      state: JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')),
      active: existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : null };
  } finally {
    const inside = relative(tmpdir(), root);
    assert(inside && !inside.startsWith('..') && !isAbsolute(inside));
    rmSync(root, { recursive: true, force: true });
  }
}

test('deploys the exact approved digest and revision', () => {
  const result = run(); assert.equal(result.code, 0, result.log);
  assert.equal(result.active, next); assert.equal(result.state.active, next);
});
for (const scenario of ['digestMismatch', 'revisionMismatch', 'pullFailure'])
  test('keeps the old container on ' + scenario, () => {
    const result = run({ [scenario]: true }); assert.notEqual(result.code, 0);
    assert.equal(result.state.active, old); assert(!result.state.events.some(x => x.startsWith('up:')));
  });
for (const scenario of ['unhealthy', 'notReady', 'startFailure'])
  test('actually attempts and restores the old digest on ' + scenario, () => {
    const result = run({ [scenario]: true }); assert.notEqual(result.code, 0, result.log);
    assert.deepEqual(result.state.events.filter(x => x.startsWith('up:')), ['up:' + next, 'up:' + old]);
    assert.equal(result.state.active, old); assert.equal(result.active, old);
    assert.match(result.log, /restaurada/);
  });
test('removes a failed first deployment without claiming a previous version', () => {
  const result = run({ firstDeploy: true, notReady: true }); assert.notEqual(result.code, 0, result.log);
  assert.equal(result.state.active, null); assert.equal(result.active, null);
  assert.deepEqual(result.state.events, ['pull', 'up:' + next, 'remove']);
});
test('rejects tag-only, unsupported service, missing digest and shell injection before any Docker change', () => {
  for (const command of [`service-deploy catalog-svc ${sha}`, `service-deploy inventory-svc ${sha} ${digest}`,
    `service-deploy catalog-svc ${sha} latest`, `service-deploy catalog-svc ${sha} ${digest};echo bad`]) {
    const result = run({}, command); assert.notEqual(result.code, 0); assert.deepEqual(result.state.events, []);
  }
});
