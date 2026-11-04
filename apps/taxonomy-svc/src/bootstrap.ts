import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TaxonomySvcModule } from './taxonomy-svc.module.js';
import { Database, readDatabaseConfig, parseDatabaseUrl } from './database.js';
import { DeactivationRecoveryRunner } from './domain/deactivation-integration.ports.js';
import { TaxonomyAmqpRuntime } from './domain/taxonomy-amqp.runtime.js';
import {
  validarEntorno,
  ConfiguracionInvalidaError,
} from './config/environment.js';
import type { Entorno, TaxonomyEnv } from './config/environment.js';
import { SanitizedLogger } from './logging/sanitized-logger.js';

export interface OpcionesArranque {
  env?: Record<string, string | undefined>;
  logger?: LoggerService;
}

export interface AplicacionCreada {
  app: INestApplication;
  env: TaxonomyEnv;
}

function cargarEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
}

export function readHttpConfig(env: Readonly<NodeJS.ProcessEnv>) {
  const raw = env.TAXONOMY_SVC_PORT ?? env.PORT ?? '';
  const port = Number(raw);
  const host = env.TAXONOMY_SVC_HOST ?? '127.0.0.1';
  if (
    !/^\d+$/.test(raw) ||
    port < 1 ||
    port > 65535 ||
    !['127.0.0.1', '0.0.0.0', '::1', '::'].includes(host) ||
    !['development', 'test', 'production'].includes(env.NODE_ENV ?? '')
  ) {
    throw new Error('Configuración HTTP taxonomy inválida');
  }
  return { port, host };
}

export async function crearAplicacion(
  opciones: OpcionesArranque = {},
): Promise<AplicacionCreada> {
  const env = opciones.env ?? process.env;
  const configuracion = validarEntorno(env);
  if (configuracion.nodeEnv === 'production') {
    throw new ConfiguracionInvalidaError([
      'crearAplicacion() no está permitido en runtime productivo; use iniciarTaxonomySvc con las garantías obligatorias de TLS e identidad.',
    ]);
  }
  const logger = new SanitizedLogger(opciones.logger);
  const app = await NestFactory.create(
    TaxonomySvcModule.forRoot({ databaseUrl: configuracion.databaseUrl, env }),
    { logger },
  );
  app.useLogger(logger);
  logger.log('Configuracion de arranque validada', {
    entorno: configuracion.nodeEnv,
    puerto: configuracion.port,
  });
  return { app, env: configuracion };
}

export async function iniciarTaxonomySvc(
  opciones: OpcionesArranque = {},
): Promise<AplicacionCreada> {
  if (!opciones.env) {
    cargarEnv();
  }

  const rawEnv = opciones.env ?? process.env;
  const urlParams = rawEnv.DATABASE_URL?.trim()
    ? parseDatabaseUrl(rawEnv.DATABASE_URL)
    : {};
  const env: NodeJS.ProcessEnv = {
    ...rawEnv,
    ...urlParams,
  };

  readDatabaseConfig(env);
  const { port, host } = readHttpConfig(env);
  const logger = new SanitizedLogger(opciones.logger);
  const app = await NestFactory.create(TaxonomySvcModule.forRuntime(env), {
    logger,
    abortOnError: false,
  });
  app.useLogger(logger);
  try {
    app.get(TaxonomyAmqpRuntime).configurar(env);
    await app.get(Database).verifyIdentity(env);
    app.enableShutdownHooks();
    await app.listen(port, host);
    app.get(DeactivationRecoveryRunner).iniciar();
    app.get(TaxonomyAmqpRuntime).iniciar();
    logger.log({ service: 'taxonomy-svc', code: 'APPLICATION_STARTED' });
    return {
      app,
      env: {
        nodeEnv: env.NODE_ENV as Entorno,
        port,
        databaseUrl: rawEnv.DATABASE_URL ?? '',
      },
    };
  } catch (err) {
    await app.close();
    throw err;
  }
}
