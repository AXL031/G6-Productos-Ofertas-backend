import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  validatePromotionsConfiguration,
  readPromotionsEnvironment,
} from '../../../dist/apps/promotions-svc/infrastructure/config/promotions-config.js';

let child;
try {
  validatePromotionsConfiguration(readPromotionsEnvironment());
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve) => reservation.close(resolve));
  child = spawn(process.execPath, ['dist/apps/promotions-svc/main.js'], {
    env: { ...process.env, PROMOTIONS_SVC_PORT: String(port) },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let startupError = false;
  child.once('error', () => {
    startupError = true;
  });
  let alive = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startupError || child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        status: 'ok',
        service: 'promotions-svc',
      });
      alive = true;
      break;
    } catch {
      await delay(200);
    }
  }
  assert.ok(alive);
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        scope: 'USER_LOCAL_STARTUP_AND_LIVENESS_ONLY',
        configuration_valid: true,
        db_integration_tested: false,
        shared_consumers_started: false,
        credentials_printed: false,
      },
      null,
      2,
    ),
  );
} catch {
  console.error('LOCAL_STARTUP_FAILED');
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
}
