import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type LoggerService,
  type OnModuleDestroy,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import pg, { type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

export function parseDatabaseUrl(
  urlStr: string,
): Partial<Record<string, string>> {
  try {
    const url = new URL(urlStr);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.pathname.replace(/^\//, '')
    )
      return {};
    const result: Partial<Record<string, string>> = {};
    if (url.hostname) result.PGHOST = url.hostname;
    if (url.port) result.PGPORT = url.port;
    const dbName = url.pathname.replace(/^\//, '');
    if (dbName) result.PGDATABASE = dbName;
    if (url.username) result.PGUSER = decodeURIComponent(url.username);
    if (url.password) result.PGPASSWORD = decodeURIComponent(url.password);
    const sslmode = url.searchParams.get('sslmode');
    if (sslmode) result.PGSSLMODE = sslmode;
    const sslrootcert = url.searchParams.get('sslrootcert');
    if (sslrootcert) result.PGSSLROOTCERT = sslrootcert;
    const schema =
      url.searchParams.get('currentSchema') ||
      url.searchParams.get('search_path');
    if (schema) result.G6_DATABASE_SCHEMA = schema;
    return result;
  } catch {
    return {};
  }
}

export function readDatabaseConfig(
  env: Readonly<NodeJS.ProcessEnv>,
): PoolConfig {
  try {
    if (env.DATABASE_URL?.trim() && !parseDatabaseUrl(env.DATABASE_URL).PGHOST)
      throw new Error();
    const urlParams = env.DATABASE_URL?.trim()
      ? parseDatabaseUrl(env.DATABASE_URL)
      : {};
    const effectiveEnv: NodeJS.ProcessEnv = {
      ...env,
      ...urlParams,
    };
    for (const key of [
      'PGHOST',
      'PGPORT',
      'PGDATABASE',
      'PGUSER',
      'PGPASSWORD',
      'PGSSLMODE',
      'PGSSLROOTCERT',
      'G6_DATABASE_SCHEMA',
      'G6_EXPECTED_ROLE',
      'G6_CONNECTION_MODE',
    ]) {
      if (!effectiveEnv[key]?.trim()) throw new Error();
    }
    if (
      effectiveEnv.G6_DATABASE_SCHEMA !== 'taxonomy' ||
      effectiveEnv.PGSSLMODE !== 'verify-full' ||
      !['taxonomy_dev_login', 'taxonomy_app'].includes(
        effectiveEnv.G6_EXPECTED_ROLE!,
      ) ||
      effectiveEnv.PGUSER!.split('.')[0] !== effectiveEnv.G6_EXPECTED_ROLE ||
      !['session', 'direct'].includes(effectiveEnv.G6_CONNECTION_MODE!) ||
      !/^\d+$/.test(effectiveEnv.PGPORT!) ||
      +effectiveEnv.PGPORT! < 1 ||
      +effectiveEnv.PGPORT! > 65535 ||
      !isAbsolute(effectiveEnv.PGSSLROOTCERT!)
    )
      throw new Error();
    const ca = readFileSync(effectiveEnv.PGSSLROOTCERT!, 'utf8');
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error();
    return {
      host: effectiveEnv.G6_CONNECT_HOST || effectiveEnv.PGHOST,
      port: Number(effectiveEnv.PGPORT),
      database: effectiveEnv.PGDATABASE,
      user: effectiveEnv.PGUSER,
      password: effectiveEnv.PGPASSWORD,
      ssl: {
        ca,
        rejectUnauthorized: true,
        servername: effectiveEnv.PGHOST,
        checkServerIdentity: (_host, certificate) =>
          checkServerIdentity(effectiveEnv.PGHOST!, certificate),
      },
      max: 4,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      query_timeout: 10000,
      statement_timeout: 10000,
    };
  } catch {
    throw new Error('Configuración PostgreSQL taxonomy inválida');
  }
}

@Injectable()
export class Database implements OnModuleDestroy {
  private logger: LoggerService = new Logger(Database.name);
  private pool?: pg.Pool;
  private db?: NodePgDatabase;
  private closed = false;
  private env: Readonly<NodeJS.ProcessEnv> = process.env;

  usarLogger(logger: LoggerService): void {
    this.logger = logger;
  }

  async read<T>(query: (db: NodePgDatabase) => Promise<T>): Promise<T> {
    try {
      if (this.closed) throw new Error();
      if (!this.pool) {
        this.pool = new pg.Pool(readDatabaseConfig(this.env));
        // pg emite errores de clientes idle fuera de la promesa de consulta.
        // Nunca emitir el error del driver, SQL, parámetros ni configuración.
        this.pool.on('error', () => {
          this.db = undefined;
          this.logger.error({
            event: 'taxonomy.database.idle_connection_failed',
            service: 'taxonomy-svc',
            component: 'postgres',
            state: 'unavailable',
            reason: 'IDLE_CONNECTION_FAILURE',
          });
        });
      }
      this.db ??= drizzle(this.pool);
      return await query(this.db);
    } catch {
      this.logger.error({
        event: 'taxonomy.database.query_failed',
        service: 'taxonomy-svc',
        component: 'postgres',
        state: 'unavailable',
        reason: 'POSTGRES_QUERY_FAILURE',
      });
      throw new ServiceUnavailableException(
        'Servicio temporalmente no disponible',
      );
    }
  }

  async verifyIdentity(
    env: Readonly<NodeJS.ProcessEnv> = this.env,
  ): Promise<void> {
    if (!this.pool) this.env = { ...env };
    const urlParams = this.env.DATABASE_URL?.trim()
      ? parseDatabaseUrl(this.env.DATABASE_URL)
      : {};
    const effectiveEnv: NodeJS.ProcessEnv = {
      ...this.env,
      ...urlParams,
    };
    await this.read(async (db) => {
      const result = await db.execute(sql`SELECT current_user AS role,
        current_database() AS database, r.rolsuper, r.rolbypassrls,
        r.rolcreaterole, r.rolcreatedb,
        has_schema_privilege(current_user, ${'taxonomy'}, 'USAGE') AS usage,
        EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = ${'taxonomy'}
          AND pg_has_role(current_user, n.nspowner, 'MEMBER')) AS owner_member
        FROM pg_roles r WHERE r.rolname = current_user`);
      const row = result.rows[0];
      if (
        !row ||
        row.role !== effectiveEnv.G6_EXPECTED_ROLE ||
        row.database !== effectiveEnv.PGDATABASE ||
        row.rolsuper ||
        row.rolbypassrls ||
        row.rolcreaterole ||
        row.rolcreatedb ||
        !row.usage ||
        row.owner_member
      ) {
        throw new Error();
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool?.end();
  }
}
