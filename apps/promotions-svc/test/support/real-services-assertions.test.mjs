import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertLiveness,
  assertReaderDeadline,
} from './real-services-assertions.mjs';

const healthy = {
  status: 200,
  contentType: 'application/json; charset=utf-8',
  body: { status: 'ok', service: 'catalog-svc' },
};
test('health accepts the actual liveness contract', () =>
  assertLiveness('catalog-svc', healthy));
for (const [name, response] of [
  ['404 route', { ...healthy, status: 404 }],
  ['503 dependency failure', { ...healthy, status: 503 }],
  [
    'wrong application',
    { ...healthy, body: { status: 'ok', service: 'other-svc' } },
  ],
  [
    '200 unhealthy body',
    { ...healthy, body: { status: 'down', service: 'catalog-svc' } },
  ],
  ['200 non-JSON', { ...healthy, contentType: 'text/html' }],
])
  test('health rejects ' + name, () =>
    assert.throws(() => assertLiveness('catalog-svc', response)),
  );

const timeout = {
  outcome: 'REJECTED',
  name: 'TimeoutError',
  elapsedMs: 2001,
  cancellation: {
    aborted: true,
    reasonName: 'TimeoutError',
    matchesReason: true,
  },
};
test('deadline accepts the actual timer reason', () =>
  assertReaderDeadline(timeout, 2000));
for (const [name, result] of [
  [
    'authentication rejection',
    { ...timeout, name: 'Error', error: 'COMMERCIAL_SESSION_UNAVAILABLE' },
  ],
  [
    'HTTP failure',
    { ...timeout, name: 'Error', error: 'COMMERCIAL_HTTP_UNAVAILABLE' },
  ],
  [
    'different error after timer',
    {
      ...timeout,
      cancellation: { ...timeout.cancellation, matchesReason: false },
    },
  ],
  [
    'caller abort',
    {
      ...timeout,
      name: 'AbortError',
      cancellation: {
        aborted: true,
        reasonName: 'AbortError',
        matchesReason: true,
      },
    },
  ],
  ['unbounded duration', { ...timeout, elapsedMs: 6000 }],
])
  test('deadline rejects ' + name, () =>
    assert.throws(() => assertReaderDeadline(result, 2000)),
  );
