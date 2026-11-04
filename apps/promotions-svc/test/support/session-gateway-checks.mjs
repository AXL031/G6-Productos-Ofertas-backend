// Full application entry + G7 contract fixture + native Gateway/Promotions/PG.
// This test never injects a user token into the browser or intercepts API calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifySessionGatewayFlow({
  frontend,
  port,
  gateway,
  issuer,
  certificate,
  directory,
  evidenceDir,
  fixture,
}) {
  const dependencies = createRequire(join(frontend, 'package.json'));
  const browserBase = 'http://127.0.0.1:' + port;
  const config = join(directory, 'vite.session.config.mjs');
  const options = {
    root: frontend,
    envFile: false,
    clearScreen: false,
    define: {
      'import.meta.env.VITE_DATA_MODE': JSON.stringify('api'),
      'import.meta.env.VITE_GATEWAY_ORIGIN': JSON.stringify(browserBase),
      'import.meta.env.VITE_G7_API_BASE': JSON.stringify(
        browserBase + '/g7/api/v1',
      ),
    },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: { '/api': gateway },
    },
  };
  writeFileSync(
    config,
    `import react from ${JSON.stringify(pathToFileURL(dependencies.resolve('@vitejs/plugin-react')).href)};
import { Agent } from 'node:https';
import { readFileSync } from 'node:fs';
const options = ${JSON.stringify(options)};
options.plugins = [react()];
options.server.proxy['/g7'] = { target: ${JSON.stringify(issuer)}, secure: true,
  agent: new Agent({ ca: readFileSync(${JSON.stringify(certificate)}), rejectUnauthorized: true }),
  rewrite: path => path.replace(/^\\/g7/, '') };
export default options;`,
  );
  const vite = spawn(
    process.execPath,
    [
      join(dirname(dependencies.resolve('vite/package.json')), 'bin/vite.js'),
      '--config',
      config,
      '--configLoader',
      'native',
    ],
    {
      cwd: frontend,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VITE_DATA_MODE: 'api' },
    },
  );
  let diagnostics = '';
  vite.stdout.on('data', (v) => {
    diagnostics += v;
  });
  vite.stderr.on('data', (v) => {
    diagnostics += v;
  });
  try {
    let available = false;
    for (let i = 0; i < 80; i++) {
      if (vite.exitCode !== null) throw new Error('SESSION_VITE_EXITED');
      try {
        if (
          (await fetch(browserBase, { signal: AbortSignal.timeout(500) })).ok
        ) {
          available = true;
          break;
        }
      } catch {
        /* startup only */
      }
      await delay(250);
    }
    assert.equal(available, true, 'session application starts');
    const testConfig = join(directory, 'playwright.session.config.mjs');
    writeFileSync(
      testConfig,
      'export default ' +
        JSON.stringify({
          testDir: join(frontend, 'tests'),
          testMatch: 'promotions-session-gateway.spec.ts',
          workers: 1,
          timeout: 60000,
          outputDir: join(evidenceDir, 'session-playwright'),
          use: { baseURL: browserBase, viewport: { width: 1440, height: 900 } },
        }) +
        ';',
    );
    const test = spawn(
      process.execPath,
      [
        join(
          dirname(dependencies.resolve('@playwright/test/package.json')),
          'cli.js',
        ),
        'test',
        '--config',
        testConfig,
        '--reporter=line',
      ],
      {
        cwd: frontend,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PROMOTIONS_SESSION_E2E_BASE_URL: browserBase,
          PROMOTIONS_E2E_EVIDENCE: evidenceDir,
        },
      },
    );
    let output = '';
    test.stdout.on('data', (v) => {
      output += v;
    });
    test.stderr.on('data', (v) => {
      output += v;
    });
    const [code] = await once(test, 'exit');
    writeFileSync(
      join(evidenceDir, 'session-browser-results.log'),
      fixture.redact(output),
    );
    assert.equal(
      code,
      0,
      'session browser flow; see session-browser-results.log',
    );
    const counts = fixture.snapshot();
    assert.deepEqual(counts, {
      login: 7,
      send: 1,
      verify: 2,
      refresh: 2,
      logout: 2,
      reuse: 0,
    });
    return {
      status: 'PASS',
      browserTests: 5,
      entry: 'src/main.tsx (no harness or injected token)',
      auth: 'explicit disposable G7 contract fixture, not external G7',
      transport:
        'same-origin test proxy with verified TLS to G7 fixture; native Gateway/Promotions and real restricted PostgreSQL/TLS',
      counters: counts,
      screenshots: [
        'session-gateway-coupon-1440.png',
        'session-gateway-mfa-1440.png',
        'session-gateway-forbidden-1440.png',
      ],
    };
  } catch (error) {
    writeFileSync(
      join(evidenceDir, 'session-gateway-diagnostics.log'),
      fixture.redact(diagnostics),
    );
    throw error;
  } finally {
    if (vite.exitCode === null) {
      const closed = once(vite, 'exit');
      vite.kill();
      await Promise.race([closed, delay(5000)]);
      if (vite.exitCode === null) vite.kill('SIGKILL');
    }
  }
}
