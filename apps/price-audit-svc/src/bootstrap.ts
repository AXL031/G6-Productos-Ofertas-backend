import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PriceAuditSvcModule } from './price-audit-svc.module.js';
import {
  InvalidAuditConfig,
  validateEnvironment,
} from './config/environment.js';
import { SafeLogger } from './logging/safe-logger.js';

export async function createApplication(env: NodeJS.ProcessEnv = process.env) {
  const config = validateEnvironment(env);
  const logger = new SafeLogger(config.nodeEnv);
  const app = await NestFactory.create(PriceAuditSvcModule.forRoot(env), {
    logger,
    abortOnError: false,
  });
  app.enableShutdownHooks();
  return { app, config, logger };
}

export async function startAudit(): Promise<void> {
  try {
    const envPath = resolve(process.cwd(), '.env');
    if (existsSync(envPath)) process.loadEnvFile(envPath);
    const { app, config, logger } = await createApplication();
    try {
      await app.listen(config.port);
      logger.log('price-audit-svc iniciado.');
    } catch (error) {
      await app.close();
      throw error;
    }
  } catch (error) {
    new SafeLogger().error(
      error instanceof InvalidAuditConfig
        ? 'Configuración inválida: revisar NODE_ENV, PRICE_AUDIT_SVC_PORT/PORT y DATABASE_URL/TLS.'
        : 'No se pudo iniciar price-audit-svc.',
    );
    process.exitCode = 1;
  }
}
