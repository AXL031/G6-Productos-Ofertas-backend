import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { BulkSvcModule } from './bulk-svc.module.js';
import { BulkProblemFilter } from './http/bulk-problem.filter.js';
import {
  InvalidBulkEnvironment,
  parseBulkEnvironment,
} from './config/bulk-environment.js';

async function bootstrap(): Promise<void> {
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  try {
    if (process.env.NODE_ENV !== 'production') {
      const envPath = resolve(process.cwd(), '.env');
      if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(envPath);
      }
    }

    const config = parseBulkEnvironment(process.env);
    app = await NestFactory.create(BulkSvcModule, {
      abortOnError: false,
      logger: false,
    });
    app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
    app.useGlobalFilters(new BulkProblemFilter());
    await app.init();

    const server = app.getHttpServer();
    server.requestTimeout = config.httpRequestTimeoutMs;
    server.headersTimeout = config.httpHeadersTimeoutMs;
    server.keepAliveTimeout = config.httpKeepAliveTimeoutMs;
    server.maxRequestsPerSocket = config.httpMaxRequestsPerSocket;
    server.maxHeadersCount = config.httpMaxHeadersCount;
    await app.listen(config.port, config.host);
    console.log('bulk-svc iniciado.');
  } catch (error) {
    if (app) await app.close().catch(() => undefined);
    console.error(
      error instanceof InvalidBulkEnvironment
        ? 'Configuración inválida de bulk-svc.'
        : 'No se pudo iniciar bulk-svc.',
    );
    process.exitCode = 1;
  }
}

await bootstrap();
