import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
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
import { createPostgresPoolOptions } from './postgres-connection-options.js';

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
  private requiredSchemaReady = false;
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
    const production = process.env.NODE_ENV === 'production';
    const isH5 = process.env.MESSAGING_PROVIDER === 'AZURE_SERVICE_BUS';
    try {
      const poolOptions = createPostgresPoolOptions(config);
      if (!poolOptions) {
        if (isH5) {
          throw new Error(
            'PostgreSQL no está configurado para el transporte Azure Service Bus (H5).',
          );
        }
        this.logger.warn(
          'PostgreSQL no está configurado; readiness permanecerá no listo.',
        );
        return;
      }
      this.pool = new Pool(poolOptions);

      // Conectar Drizzle ORM a la instancia del pool PostgreSQL
      this.drizzleDb = drizzle(this.pool, { schema });
      this.pool.on('error', (error: Error) => {
        this.isConnected = false;
        this.logger.error({ event: 'inventory.database.pool_error', error });
      });

      // Validate connection
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
        if (production) await this.assertRequiredSchema();
        if (isH5) await this.assertRequiredH5Schema(client);
        this.requiredSchemaReady = true;
        this.isConnected = true;
        this.logger.log(
          'Conexión PostgreSQL hacia schema inventory inicializada y validada con éxito (Drizzle ORM activo).',
        );
      } finally {
        client.release();
      }
    } catch (err) {
      this.isConnected = false;
      this.requiredSchemaReady = false;
      await this.pool?.end().catch(() => undefined);
      this.pool = null;
      this.drizzleDb = null;
      this.logger.error({
        event: 'inventory.database.initialization_failed',
        reason: 'POSTGRES_CONFIGURATION_CONNECTION_OR_SCHEMA',
        errorCode:
          err &&
          typeof err === 'object' &&
          'code' in err &&
          typeof err.code === 'string'
            ? err.code
            : 'CONFIGURATION_OR_TLS_ERROR',
      });
      if (production || isH5) {
        throw new Error(
          'PostgreSQL o el esquema requerido de Inventory no está preparado.',
        );
      }
    }
  }

  private async assertRequiredH5Schema(
    client: pg.PoolClient | pg.Pool,
  ): Promise<void> {
    // 1. Validar existencia de la tabla y columnas requeridas por InventoryDeliveryStore
    const columnsResult = await client.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'inventory'
          AND table_name = 'outbox_delivery'`,
    );

    const requiredColumns = [
      'message_id',
      'destination',
      'route_version',
      'transport',
      'created_at',
      'next_attempt_at',
      'attempts',
      'lease_token',
      'lease_until',
      'sent_at',
      'last_error',
    ];

    const actualColumns = new Set(columnsResult.rows.map((r) => r.column_name));
    for (const col of requiredColumns) {
      if (!actualColumns.has(col)) {
        throw new Error(
          `Columna requerida '${col}' no encontrada en inventory.outbox_delivery`,
        );
      }
    }

    // 2. Validar Primary Key (message_id, destination)
    const pkResult = await client.query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'inventory'
          AND tc.table_name = 'outbox_delivery'
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
    );

    const pkColumns = pkResult.rows.map((r) => r.column_name);
    if (
      pkColumns.length !== 2 ||
      pkColumns[0] !== 'message_id' ||
      pkColumns[1] !== 'destination'
    ) {
      throw new Error(
        'Clave primaria compuesta (message_id, destination) no encontrada en inventory.outbox_delivery',
      );
    }

    // 3. Validar FK contra inventory.outbox(event_id)
    const fkResult = await client.query<{
      column_name: string;
      foreign_table_schema: string;
      foreign_table_name: string;
      foreign_column_name: string;
    }>(
      `SELECT kcu.column_name,
              ccu.table_schema AS foreign_table_schema,
              ccu.table_name AS foreign_table_name,
              ccu.column_name AS foreign_column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'inventory'
          AND tc.table_name = 'outbox_delivery'
          AND tc.constraint_type = 'FOREIGN KEY'`,
    );

    const hasFk = fkResult.rows.some(
      (r) =>
        r.column_name === 'message_id' &&
        r.foreign_table_schema === 'inventory' &&
        r.foreign_table_name === 'outbox' &&
        r.foreign_column_name === 'event_id',
    );

    if (!hasFk) {
      throw new Error(
        'Clave foránea contra inventory.outbox(event_id) no encontrada en inventory.outbox_delivery',
      );
    }

    // 4. Validar permisos SELECT, INSERT y UPDATE del usuario de aplicación
    const privResult = await client.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
    }>(
      `SELECT has_table_privilege('inventory.outbox_delivery', 'SELECT') AS can_select,
              has_table_privilege('inventory.outbox_delivery', 'INSERT') AS can_insert,
              has_table_privilege('inventory.outbox_delivery', 'UPDATE') AS can_update`,
    );

    const priv = privResult.rows[0];
    if (!priv?.can_select || !priv?.can_insert || !priv?.can_update) {
      throw new Error(
        'El usuario de base de datos no cuenta con permisos SELECT, INSERT y UPDATE sobre inventory.outbox_delivery',
      );
    }
  }

  private async assertRequiredSchema(): Promise<void> {
    if (!this.pool) throw new Error('Database pool is unavailable');
    const result = await this.pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'inventory'
          AND (table_name, column_name) IN (
            ('sku_lifecycle', 'sku_id'),
            ('sku_lifecycle', 'product_id'),
            ('sku_lifecycle', 'sku_version'),
            ('sku_lifecycle', 'active'),
            ('sku_lifecycle', 'changed_at'),
            ('sku_lifecycle', 'updated_at'),
            ('offline_sale_reconciliations', 'client_id'),
            ('offline_sale_reconciliations', 'offline_sale_id'),
            ('offline_sale_reconciliations', 'operation_id'),
            ('offline_sale_reconciliations', 'order_id'),
            ('offline_sale_reconciliations', 'request_fingerprint'),
            ('offline_sale_reconciliations', 'request_payload'),
            ('offline_sale_reconciliations', 'result_payload'),
            ('offline_sale_reconciliations', 'status'),
            ('offline_sale_reconciliations', 'completed_at')
          )`,
    );
    if (result.rows.length !== 15) {
      throw new Error('Required Inventory schema is missing or incompatible');
    }
    const constraints = await this.pool.query<{
      table_name: string;
      constraint_type: string;
      columns: string;
    }>(
      `SELECT tc.table_name, tc.constraint_type,
              string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS columns
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_catalog = tc.constraint_catalog
          AND kcu.constraint_schema = tc.constraint_schema
          AND kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
          AND kcu.table_name = tc.table_name
        WHERE tc.constraint_schema = 'inventory'
          AND tc.table_name IN ('sku_lifecycle', 'offline_sale_reconciliations')
          AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
        GROUP BY tc.table_name, tc.constraint_type`,
    );
    const actual = new Set(
      constraints.rows.map(
        (row) => `${row.table_name}:${row.constraint_type}:${row.columns}`,
      ),
    );
    if (
      !actual.has('sku_lifecycle:PRIMARY KEY:sku_id') ||
      !actual.has(
        'offline_sale_reconciliations:PRIMARY KEY:client_id,offline_sale_id',
      ) ||
      !actual.has('offline_sale_reconciliations:UNIQUE:operation_id')
    ) {
      throw new Error('Required Inventory schema constraints are missing');
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
      if (process.env.NODE_ENV === 'production') {
        await this.assertRequiredSchema();
      }
      this.requiredSchemaReady = true;
      if (!this.requiredSchemaReady) {
        return { healthy: false, error: 'Esquema requerido no preparado' };
      }
      return { healthy: true, latencyMs: Date.now() - start };
    } catch {
      this.requiredSchemaReady = false;
      return {
        healthy: false,
        error: 'PostgreSQL o esquema requerido no disponible',
      };
    }
  }
}
