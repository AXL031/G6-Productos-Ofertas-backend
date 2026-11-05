// Test-only process: boot the unmodified peer module and its real workers.
// Configuration comes exclusively from the parent disposable fixture on stdin.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const config = JSON.parse(readFileSync(0, 'utf8'));
const require = createRequire(join(config.build, 'main.js'));
const { NestFactory } = require('@nestjs/core');
const name = config.peer === 'pricing' ? 'pricing-svc' : 'inventory-svc';
let app;
try {
  const module = await import(
    pathToFileURL(join(config.build, name + '.module.js')).href
  );
  app = await NestFactory.createApplicationContext(
    module[
      config.peer === 'pricing' ? 'PricingSvcModule' : 'InventorySvcModule'
    ],
    { logger: false },
  );
  let closing = false;
  process.on('SIGTERM', async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
  console.log('PREPARATION_PEER_READY');
} catch {
  console.error('PREPARATION_PEER_FAILED');
  await app?.close();
  process.exitCode = 1;
}
