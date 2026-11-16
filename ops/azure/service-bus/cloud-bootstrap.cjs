// Only built-ins until the locked dependency installation succeeds.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const child = require('node:child_process');
try {
  // One-day lab-only TLS material, generated on the host and never exported.
  fs.mkdirSync('/pilot-status/tls', { recursive: true });
  child.execFileSync('apk', ['add', '--no-cache', 'openssl'], {
    stdio: 'ignore',
    timeout: 120000,
  });
  child.execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-noenc',
      '-days',
      '1',
      '-subj',
      '/CN=g6-isolated-pilot',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout',
      '/pilot-status/tls/server.key',
      '-out',
      '/pilot-status/tls/server.crt',
    ],
    { stdio: 'ignore', timeout: 30000 },
  );
  fs.chownSync('/pilot-status/tls/server.key', 70, 70);
  fs.chmodSync('/pilot-status/tls/server.key', 0o600);
  fs.writeFileSync('/pilot-status/tls-ready', 'ready');
  const encoded = Object.keys(process.env)
    .filter((key) => /^G6_BUNDLE_\d{3}$/.test(key))
    .sort()
    .map((key) => process.env[key])
    .join('');
  const compressed = Buffer.from(encoded, 'base64');
  if (
    crypto.createHash('sha256').update(compressed).digest('hex') !==
    process.env.BUNDLE_SHA256
  )
    throw new Error('BUNDLE_HASH_MISMATCH');
  const files = JSON.parse(
    zlib.gunzipSync(compressed, { maxOutputLength: 10000000 }),
  );
  const root = '/tmp/g6-pilot';
  for (const [name, content] of files) {
    if (
      typeof name !== 'string' ||
      typeof content !== 'string' ||
      name.includes('..') ||
      name.startsWith('/') ||
      name.includes('\\')
    )
      throw new Error('INVALID_BUNDLE_FILE');
    if (
      !/^(package(-lock)?\.json|dist\/apps\/(pricing-svc|price-audit-svc)\/.+\.js|apps\/(pricing-svc|price-audit-svc)\/.+\.sql|ops\/azure\/service-bus\/cloud-runner\.mjs)$/.test(
        name,
      )
    )
      throw new Error('BUNDLE_ALLOWLIST_REJECTED');
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const install = child.spawnSync(
    'npm',
    [
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: root, timeout: 240000, encoding: 'utf8', maxBuffer: 2000000 },
  );
  if (install.status !== 0) throw new Error('LOCKED_DEPENDENCY_INSTALL_FAILED');
  const runner = child.spawnSync(
    process.execPath,
    ['ops/azure/service-bus/cloud-runner.mjs'],
    { cwd: root, stdio: 'inherit', timeout: 420000 },
  );
  if (runner.status !== 0) throw new Error('RUNNER_FAILED');
} catch (error) {
  const codes = [
    'BUNDLE_HASH_MISMATCH',
    'INVALID_BUNDLE_FILE',
    'BUNDLE_ALLOWLIST_REJECTED',
    'LOCKED_DEPENDENCY_INSTALL_FAILED',
    'RUNNER_FAILED',
  ];
  process.stdout.write(
    `${JSON.stringify({ check: 'CLOUD_BOOTSTRAP', status: 'FAIL', code: codes.includes(error.message) ? error.message : 'BOOTSTRAP_FAILED' })}\n`,
  );
  process.exitCode = 1;
}
