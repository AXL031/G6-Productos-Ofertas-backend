import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { CombosSvcModule } from './combos-svc.module.js';
import { readCombosEnvironment } from './config/combos-environment.js';
import { CombosProblemFilter } from './http/combos-problem.filter.js';
import { combosCorrelationMiddleware } from './http/combos-correlation.middleware.js';

function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
}

async function bootstrap() {
  loadEnv();
  const config = readCombosEnvironment(process.env);
  const app = await NestFactory.create(CombosSvcModule, { bodyParser: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  app.use(express.json({ limit: '64kb', strict: true }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(combosCorrelationMiddleware);
  app.useGlobalFilters(new CombosProblemFilter());
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}
await bootstrap();
