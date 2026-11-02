import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { correlationId, isCorrelationId } from './correlation.js';
import type { Request, Response, NextFunction } from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { CatalogConfig } from './config.js';
import { SanitizedLogger } from './sanitized-logger.js';
import { Database } from './database.js';
import { catalogRequestLog } from './catalog-telemetry.js';

export function catalogCorrelation(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const supplied = req.get('X-Correlation-Id');
  const id = correlationId(supplied);
  req.headers['x-correlation-id'] = id;
  res.setHeader('X-Correlation-Id', id);
  if (supplied !== undefined && !isCorrelationId(supplied)) {
    next(new BadRequestException());
    return;
  }
  next();
}

export async function createApplication(
  env: Record<string, string | undefined> = process.env,
) {
  const config = new CatalogConfig(env);
  const secrets = Object.entries(env)
    .filter(([key]) =>
      /password|secret|token|key|credential|url|dsn/i.test(key),
    )
    .flatMap(([, value]) => (value ? [value] : []));
  const credentials = [config.database.user, config.database.password];
  for (const credential of credentials) {
    if (credential) {
      secrets.push(credential);
      try {
        secrets.push(decodeURIComponent(credential));
      } catch {
        // Keep the encoded value redacted even for malformed percent escapes.
      }
    }
  }
  const logger = new SanitizedLogger(config.environment, secrets);
  const app = await NestFactory.create(AppModule.forRoot(config), {
    logger,
    abortOnError: false,
  });
  app.use(catalogRequestLog(logger));
  app.use(catalogCorrelation);
  app.enableShutdownHooks();
  return { app, config };
}

export async function startCatalog() {
  try {
    const serviceEnvPath = resolve(
      process.cwd(),
      'apps/catalog-svc/.env.local',
    );
    const rootEnvPath = resolve(process.cwd(), '.env');
    if (existsSync(serviceEnvPath)) process.loadEnvFile(serviceEnvPath);
    if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);
    const { app, config } = await createApplication();
    try {
      await app.get(Database).verifyIdentity();
      await app.listen(config.port, config.host);
      new SanitizedLogger(config.environment).log({
        code: 'APPLICATION_STARTED',
      });
    } catch {
      await app.close();
      throw new Error('Listen failed');
    }
  } catch {
    new SanitizedLogger('bootstrap', [], (line) =>
      process.stderr.write(line + '\n'),
    ).error({
      code: 'APPLICATION_START_FAILED',
      message:
        'catalog-svc no pudo iniciar; verificar configuracion y disponibilidad del puerto.',
    });
    process.exitCode = 1;
  }
}
