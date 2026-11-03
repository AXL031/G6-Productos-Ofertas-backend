import assert from 'node:assert/strict';

export function assertLiveness(service, response) {
  assert.equal(response.status, 200, `${service}: expected HTTP 200`);
  assert.match(response.contentType ?? '', /^application\/json(?:;|$)/i);
  assert.deepEqual(response.body, { status: 'ok', service });
}

export function assertReaderDeadline(result, milliseconds) {
  assert.equal(result.outcome, 'REJECTED');
  assert.equal(result.name, 'TimeoutError');
  assert.deepEqual(result.cancellation, {
    aborted: true,
    reasonName: 'TimeoutError',
    matchesReason: true,
  });
  assert.ok(result.elapsedMs >= milliseconds - 50);
  assert.ok(result.elapsedMs < milliseconds + 2000);
}
