// Seal a completed run against an immutable commit, without rewriting its
// original checkoutHead/dirty-source metadata or claiming a rerun on another SHA.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const revision = process.argv[2];
assert.match(revision ?? '', /^[a-f0-9]{40}$/);
const git = (args) =>
  execFileSync('git', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const file = (path) => git(['show', revision + ':' + path]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const base = 'apps/promotions-svc/';
const real = JSON.parse(
  file(base + 'test/evidence/marketplace-real-2026-11-04.json'),
);
const native = JSON.parse(
  file(base + 'test/evidence/marketplace-native-2026-11-04.json'),
);
assert.equal(real.status, 'PARTIAL');
assert.equal(
  real.checks.every((c) => c.result === 'PASS'),
  true,
);
assert.equal(native.status, 'PASS');
const sourcePaths = Object.keys(real.promotions.sourceSha256);
for (const [path, expected] of Object.entries(real.promotions.sourceSha256)) {
  assert.ok(path.startsWith(base + 'src/'));
  assert.equal(hash(file(path)), expected, path);
}
for (const [path, expected] of Object.entries(real.harnessSha256))
  assert.equal(hash(file(base + 'test/' + path)), expected, path);
assert.equal(
  hash(file(base + 'test/support/service-token-wiring-checks.mjs')),
  native.harnessSha256,
);
console.log(
  JSON.stringify(
    {
      status: 'PASS',
      verifiedConsumerCommit: revision,
      originalRunCheckoutHead: real.promotions.checkoutHead,
      interpretation:
        'The run used a modified worktree at the recorded base HEAD. Every compiled consumer source and executed harness file matches this immutable commit byte-for-byte. This is source equivalence verification, not a rerun.',
      verifiedSourcePaths: sourcePaths.length,
      verifiedRealHarnessFiles: Object.keys(real.harnessSha256).length,
      nativeHarnessVerified: true,
      realProvidersMaster: real.master,
      realProviderChecks: real.checks.length,
    },
    null,
    2,
  ),
);
