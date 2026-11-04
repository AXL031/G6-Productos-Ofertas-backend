// Opt-in real Gateway/Promotions/PostgreSQL flow. Never loads shared .env files.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

if (!existsSync(resolve('dist/apps/api-gateway/main.js')))
  throw new Error('Build Gateway and Promotions first: npm run build:all');
const child = spawn(
  process.execPath,
  ['apps/promotions-svc/test/persistence.isolated.smoke.mjs'],
  {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env, G6_PROMOTIONS_GATEWAY_E2E: 'true' },
  },
);
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
