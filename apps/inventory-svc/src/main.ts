import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { InventorySvcModule } from './inventory-svc.module.js';
import { ProblemDetailsFilter } from './errors/problem-details.filter.js';
import { loadInventoryConfig } from './config/inventory.config.js';
import { SanitizedLogger } from './logging/sanitized-logger.js';

function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
}

async function bootstrap() {
  const logger = new SanitizedLogger();
  loadEnv();

  let config;
  try {
    config = loadInventoryConfig();
  } catch (error) {
    logger.error((error as Error).message, 'Bootstrap');
    process.exit(1);
  }

  const app = await NestFactory.create(InventorySvcModule, { logger });
  app.useLogger(logger);
  app.enableShutdownHooks();
  app.useGlobalFilters(new ProblemDetailsFilter());
  if (config.commercialDemo.enabled) {
    logger.warn(
      'Excepción demo activa solo para consultarDisponibilidadComercial y verificarCantidadComercial desde las IPs configuradas del Gateway.',
      'Bootstrap',
    );
  }
  // Configuración validada previamente; conserva la precedencia del registro Oracle.
  const port = process.env.INVENTORY_SVC_PORT ?? process.env.PORT ?? '3005';
  await app.listen(Number(port));
  logger.log(
    `inventory-svc escuchando en el puerto ${config.port}`,
    'Bootstrap',
  );
}
await bootstrap();
