import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import * as fs from 'node:fs';
import pg from 'pg';
import { SanitizedLogger } from '../logging/sanitized-logger.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../drizzle/schema.js';
import {
  IDatabaseClient,
  IDatabaseService,
  QueryResult,
  DrizzleDatabase,
} from './database.interface.js';
import {
  loadInventoryConfig,
  InventoryConfig,
} from '../config/inventory.config.js';

const { Pool } = pg;

@Injectable()
export class DatabaseService
  implements IDatabaseService, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new SanitizedLogger(
    new Logger(DatabaseService.name),
  );
  private pool: pg.Pool | null = null;
  private drizzleDb: DrizzleDatabase | null = null;
  private isConnected = false;
  private customService: IDatabaseService | null = null;

  constructor() {}

  /**
   * Allows injecting a custom database implementation for testing (e.g. in-memory transactional store)
   */
  setCustomService(custom: IDatabaseService | null): void {
    this.customService = custom;
  }

  getDrizzle(): DrizzleDatabase | null {
    if (this.customService && (this.customService as any).getDrizzle) {
      return (this.customService as any).getDrizzle();
    }
    return this.drizzleDb;
  }

  async onModuleInit(): Promise<void> {
    if (this.customService) {
      return;
    }

    const config = loadInventoryConfig();
    await this.initPool(config);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.drizzleDb = null;
      this.isConnected = false;
    }
  }

  private async initPool(config: InventoryConfig): Promise<void> {
    try {
      let sslConfig: boolean | { ca?: string; rejectUnauthorized?: boolean } =
        false;
      if (config.pgSslRootCert && fs.existsSync(config.pgSslRootCert)) {
        sslConfig = {
          ca: fs.readFileSync(config.pgSslRootCert, 'utf8'),
          rejectUnauthorized: true,
        };
      } else if (config.pgSslMode === 'disable') {
        sslConfig = false;
      } else if (config.databaseUrl) {
        if (
          config.databaseUrl.includes('localhost') ||
          config.databaseUrl.includes('sslmode=disable')
        ) {
          sslConfig = false;
        } else {
          sslConfig = { rejectUnauthorized: true };
        }
      } else if (
        config.pgHost &&
        config.pgSslMode &&
        config.pgSslMode !== 'disable'
      ) {
        sslConfig = { rejectUnauthorized: true };
      }

      if (config.databaseUrl) {
        this.pool = new Pool({
          connectionString: config.databaseUrl,
          ssl: sslConfig,
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
          statement_timeout: 15000,
          lock_timeout: 5000,
          query_timeout: 20000,
        });
      } else if (
        config.pgHost &&
        config.pgUser &&
        config.pgDatabase &&
        config.pgPassword
      ) {
        this.pool = new Pool({
          host: config.pgHost,
          port: config.pgPort ?? 5432,
          database: config.pgDatabase,
          user: config.pgUser,
          password: config.pgPassword,
          ssl: sslConfig,
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
          statement_timeout: 15000,
          lock_timeout: 5000,
          query_timeout: 20000,
        });
      } else {
        this.logger.warn(
          'No se configuró DATABASE_URL ni credenciales PG en el entorno. La conexión real queda en espera.',
        );
        return;
      }

      // Conectar Drizzle ORM a la instancia del pool PostgreSQL
      this.drizzleDb = drizzle(this.pool, { schema });
      this.pool.on('error', (error: Error) => {
        this.isConnected = false;
        this.logger.error({ event: 'inventory.database.pool_error', error });
      });

      // Configure default search_path to inventory on each new client
      this.pool.on('connect', (client) => {
        client.query('SET search_path TO inventory, public').catch((err) => {
          this.logger.error(
            'Error configurando search_path en cliente PG',
            err,
          );
        });
      });

      // Validate connection
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
        this.isConnected = true;
        this.logger.log(
          'Conexión PostgreSQL hacia schema inventory inicializada y validada con éxito (Drizzle ORM activo).',
        );
      } finally {
        client.release();
      }
    } catch (err) {
      this.isConnected = false;
      this.logger.warn(
        `No fue posible validar la conexión a PostgreSQL: ${(err as Error).message}. Las operaciones transaccionales dependerán de la disponibilidad del broker/base de datos.`,
      );
    }
  }

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    if (this.customService) {
      return this.customService.query<T>(sql, params);
    }

    if (!this.pool) {
      throw new Error('DatabaseService no tiene conexión activa a PostgreSQL.');
    }

    const res = await this.pool.query(sql, params);
    return {
      rows: res.rows as T[],
      rowCount: res.rowCount ?? res.rows.length,
    };
  }

  async transaction<T>(
    fn: (client: IDatabaseClient) => Promise<T>,
  ): Promise<T> {
    if (this.customService) {
      return this.customService.transaction<T>(fn);
    }

    if (!this.pool) {
      throw new Error('DatabaseService no tiene conexión activa a PostgreSQL.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txDrizzle = drizzle(client, { schema });
      const wrappedClient: IDatabaseClient = {
        query: async <R = any>(
          sql: string,
          params?: any[],
        ): Promise<QueryResult<R>> => {
          const res = await client.query(sql, params);
          return {
            rows: res.rows as R[],
            rowCount: res.rowCount ?? res.rows.length,
          };
        },
        drizzle: txDrizzle,
      };

      const result = await fn(wrappedClient);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        this.logger.error('Error durante ROLLBACK de transacción PG', rbErr);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async isHealthy(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    if (this.customService) {
      return this.customService.isHealthy();
    }

    if (!this.pool) {
      return { healthy: false, error: 'Sin pool configurado' };
    }

    const start = Date.now();
    try {
      await this.pool.query('SELECT 1');
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { healthy: false, error: (err as Error).message };
    }
  }
}
