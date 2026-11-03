import { HttpStatus, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  TaxonomyAuthGuard,
  TAXONOMY_SECURITY_CONFIG,
} from '../src/taxonomy-auth.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { vi } from 'vitest';
import { Database } from '../src/database.js';
import { DeactivationCheckService } from '../src/domain/deactivation-check.service.js';
import { DeactivationIntentService } from '../src/domain/deactivation-intent.service.js';
import { BrandReactivationService } from '../src/domain/brand-reactivation.service.js';
import { CategoryReactivationService } from '../src/domain/category-reactivation.service.js';
import { CategoryCreateService } from '../src/domain/category-create.service.js';
import { CategoryUpdateService } from '../src/domain/category-update.service.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ProblemDetailsException } from './../src/errors/taxonomy.errors.js';
import { crearRepositorioDrizzle } from './../src/persistence/persistence.providers.js';
import {
  esquemaTaxonomia,
  categorias,
  categorySeo,
  marcas,
  operacionesBaja,
} from './../src/persistence/taxonomy.schema.js';
import type { TaxonomyDb } from './../src/persistence/drizzle-taxonomy.repository.js';
import type { DrizzleTaxonomyRepository } from './../src/persistence/drizzle-taxonomy.repository.js';
import {
  PostgresTaxonomyRepository,
  type TaxonomyDataSource,
} from './../src/postgres-taxonomy.repository.js';
import { TAXONOMY_REPOSITORY } from './../src/taxonomy.repository.js';
import { TaxonomySvcModule } from './../src/taxonomy-svc.module.js';
import { AcreditacionInstanciaEfimera } from './postgres-isolation.js';
import {
  PASSWORD_APP,
  ROL_APP,
  construirSentenciaDropDdl,
  construirSentenciasDdl,
  construirSentenciasSemilla,
} from './ddl-taxonomy-prueba.js';

const URL_BASE = process.env.TAXONOMY_TEST_DATABASE_URL?.trim();
const describeIntegracion = URL_BASE ? describe : describe.skip;

function urlConRol(base: string, usuario: string, password: string): string {
  const url = new URL(base);
  url.username = usuario;
  url.password = password;
  return url.toString();
}

function adaptadorRuntime(pool: Pool): TaxonomyDataSource {
  let db: NodePgDatabase | undefined;
  return {
    read: <T>(consulta: (conexion: NodePgDatabase) => Promise<T>) => {
      db ??= drizzle(pool);
      return consulta(db);
    },
    verifyIdentity: () => Promise.resolve(),
  };
}

describeIntegracion(
  'Persistencia Drizzle contra Postgres aislado (#35)',
  () => {
    let admin: Pool;
    let app: Pool;
    let dbApp: TaxonomyDb;
    let repo: DrizzleTaxonomyRepository;
    let urlApp: string;
    let acreditacion: AcreditacionInstanciaEfimera;

    async function levantarAppNest(): Promise<INestApplication<App>> {
      const moduleFixture = await Test.createTestingModule({
        imports: [TaxonomySvcModule.forRoot({ databaseUrl: urlApp })],
      }).compile();
      const creada: INestApplication<App> =
        moduleFixture.createNestApplication();
      await creada.init();
      return creada;
    }

    beforeAll(async () => {
      acreditacion = await AcreditacionInstanciaEfimera.acreditar(URL_BASE);
      const urlBase = acreditacion.connectionString;
      urlApp = urlConRol(urlBase, ROL_APP, PASSWORD_APP);
      admin = new Pool({ connectionString: urlBase });
      for (const sentencia of construirSentenciasDdl(acreditacion)) {
        await admin.query(sentencia);
      }
      for (const sentencia of construirSentenciasSemilla()) {
        await admin.query(sentencia);
      }
      app = new Pool({ connectionString: urlApp });
      dbApp = drizzle(app, { schema: esquemaTaxonomia });
      repo = crearRepositorioDrizzle(urlApp);
    });

    afterAll(async () => {
      try {
        await repo?.onApplicationShutdown();
      } catch {
        /* cierre defensivo */
      }
      try {
        await app?.end();
      } catch {
        /* cierre defensivo */
      }
      try {
        await admin?.query(
          `GRANT SELECT ON ALL TABLES IN SCHEMA taxonomy TO ${ROL_APP}`,
        );
      } catch {
        /* restauración defensiva si el esquema existe */
      }
      try {
        if (acreditacion) {
          await admin?.query(construirSentenciaDropDdl(acreditacion));
        }
      } catch {
        /* limpieza defensiva */
      }
      try {
        await admin?.end();
      } catch {
        /* limpieza defensiva */
      }
    });

    it('revierte la edición si no puede registrar su evento outbox', async () => {
      const id = randomUUID();
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (callback) =>
        callback(dbApp),
      );
      try {
        await admin.query(
          "INSERT INTO taxonomy.categories (id, nombre, nivel, estado) VALUES ($1, $2, 1, 'ACTIVO')",
          [id, `Inicial ${id}`],
        );
        await admin.query(`REVOKE INSERT ON taxonomy.outbox FROM ${ROL_APP}`);
        await expect(
          new CategoryUpdateService(database).actualizar(id, {
            nombre: 'No debe quedar',
          }),
        ).rejects.toThrow();
        const result = await admin.query(
          'SELECT nombre, taxonomy_version FROM taxonomy.categories WHERE id = $1',
          [id],
        );
        expect(result.rows[0]).toMatchObject({
          nombre: `Inicial ${id}`,
          taxonomy_version: '0',
        });
      } finally {
        await admin.query(`GRANT INSERT ON taxonomy.outbox TO ${ROL_APP}`);
        await admin.query('DELETE FROM taxonomy.categories WHERE id = $1', [
          id,
        ]);
        vi.restoreAllMocks();
      }
    });

    it('revierte creación y reactivación si falla el outbox', async () => {
      const id = randomUUID();
      const slug = `rollback-${randomUUID()}`;
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (callback) =>
        callback(dbApp),
      );
      try {
        await admin.query(
          "INSERT INTO taxonomy.categories (id, nombre, nivel, estado) VALUES ($1, $2, 1, 'INACTIVO')",
          [id, `Pendiente ${id}`],
        );
        await admin.query(`REVOKE INSERT ON taxonomy.outbox FROM ${ROL_APP}`);
        await expect(
          new CategoryCreateService(database).crear({
            nombre: slug,
            descripcion: null,
            categoriaPadreId: null,
            orden: 0,
            imagenUrl: null,
            slugConfirmado: slug,
          }),
        ).rejects.toThrow();
        await expect(
          new CategoryReactivationService(database).reactivar(id),
        ).rejects.toThrow();
        const created = await admin.query(
          'SELECT id FROM taxonomy.categories WHERE nombre = $1',
          [slug],
        );
        expect(created.rows).toHaveLength(0);
        const seo = await admin.query(
          'SELECT id FROM taxonomy.category_seo WHERE slug = $1',
          [slug],
        );
        expect(seo.rows).toHaveLength(0);
        const original = await admin.query(
          'SELECT estado, taxonomy_version FROM taxonomy.categories WHERE id = $1',
          [id],
        );
        expect(original.rows[0]).toMatchObject({
          estado: 'INACTIVO',
          taxonomy_version: '0',
        });
      } finally {
        await admin.query(`GRANT INSERT ON taxonomy.outbox TO ${ROL_APP}`);
        await admin.query('DELETE FROM taxonomy.categories WHERE id = $1', [
          id,
        ]);
        vi.restoreAllMocks();
      }
    });

    it('crea categoría y slug confirmado o revierte ante colisión', async () => {
      const slug = `prueba-${randomUUID()}`;
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (callback) =>
        callback(dbApp),
      );
      const service = new CategoryCreateService(database);
      const entrada = {
        nombre: `Nombre ${slug}`,
        descripcion: null,
        categoriaPadreId: null,
        orden: 0,
        imagenUrl: null,
        slugConfirmado: slug,
      };
      let id: string | undefined;
      try {
        const first = await service.crear(entrada);
        expect(first.estado).toBe('CREADA');
        if (first.estado === 'CREADA') {
          id = first.categoria.categoriaId;
          expect(first.categoria.slug).toBe(slug);
        }
        expect(await service.crear(entrada)).toEqual({
          estado: 'SLUG_DUPLICADO',
        });
        const result = await admin.query(
          'SELECT count(*)::int AS total FROM taxonomy.categories WHERE nombre = $1',
          [entrada.nombre],
        );
        expect(result.rows[0].total).toBe(1);
        const events = await admin.query(
          "SELECT event_name, payload->'data'->>'version' AS version FROM taxonomy.outbox WHERE payload->'data'->>'categoria_id' = $1",
          [id],
        );
        expect(events.rows).toEqual([
          { event_name: 'taxonomy.category.updated', version: '0' },
        ]);
      } finally {
        if (id) {
          await admin.query(
            "DELETE FROM taxonomy.outbox WHERE payload->'data'->>'categoria_id' = $1",
            [id],
          );
          await admin.query(
            'DELETE FROM taxonomy.category_seo WHERE categoria_id = $1',
            [id],
          );
          await admin.query('DELETE FROM taxonomy.categories WHERE id = $1', [
            id,
          ]);
        }
        vi.restoreAllMocks();
      }
    });

    it('revierte la categoría si el slug confirmado ya existe', async () => {
      const id = randomUUID();
      const existing = randomUUID();
      const slug = `slug-${randomUUID()}`;
      try {
        await admin.query(
          "INSERT INTO taxonomy.categories (id, nombre, nivel, estado) VALUES ($1, $2, 1, 'ACTIVO')",
          [existing, `Existente ${existing}`],
        );
        await admin.query(
          'INSERT INTO taxonomy.category_seo (categoria_id, slug) VALUES ($1, $2)',
          [existing, slug],
        );
        await expect(
          dbApp.transaction(async (tx) => {
            await tx.insert(categorias).values({ id, nombre: `Nueva ${id}` });
            await tx.insert(categorySeo).values({ categoriaId: id, slug });
          }),
        ).rejects.toThrow();
        const result = await admin.query(
          'SELECT id FROM taxonomy.categories WHERE id = $1',
          [id],
        );
        expect(result.rows).toHaveLength(0);
      } finally {
        await admin.query(
          'DELETE FROM taxonomy.category_seo WHERE categoria_id = $1',
          [existing],
        );
        await admin.query(
          'DELETE FROM taxonomy.categories WHERE id = ANY($1::uuid[])',
          [[id, existing]],
        );
      }
    });

    it('reactiva categoría solo con padre activo y conserva la baja en curso', async () => {
      const parentId = randomUUID();
      const childId = randomUUID();
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (callback) =>
        callback(dbApp),
      );
      const service = new CategoryReactivationService(database);
      try {
        await admin.query(
          "INSERT INTO taxonomy.categories (id, nombre, nivel, estado) VALUES ($1, $2, 1, 'INACTIVO')",
          [parentId, `Padre ${parentId}`],
        );
        await admin.query(
          "INSERT INTO taxonomy.categories (id, nombre, categoria_padre_id, nivel, estado) VALUES ($1, $2, $3, 2, 'INACTIVO')",
          [childId, `Hija ${childId}`, parentId],
        );
        expect(await service.reactivar(childId)).toEqual({
          estado: 'PADRE_INACTIVO',
        });
        expect((await service.reactivar(parentId)).estado).toBe('ACTIVA');
        const first = await service.reactivar(childId);
        expect(first.estado).toBe('ACTIVA');
        if (first.estado === 'ACTIVA') expect(first.categoria.version).toBe(1);
        expect(await service.reactivar(childId)).toEqual(first);
        const events = await admin.query(
          "SELECT event_name, payload->'data'->>'version' AS version FROM taxonomy.outbox WHERE payload->'data'->>'categoria_id' = $1",
          [childId],
        );
        expect(events.rows).toEqual([
          { event_name: 'taxonomy.category.updated', version: '1' },
        ]);
        await admin.query(
          "UPDATE taxonomy.categories SET estado = 'PENDING_DEACTIVATION' WHERE id = $1",
          [childId],
        );
        expect(await service.reactivar(childId)).toEqual({
          estado: 'BAJA_EN_PROCESO',
        });
        expect(await service.reactivar(randomUUID())).toEqual({
          estado: 'NO_ENCONTRADA',
        });
      } finally {
        await admin.query(
          "DELETE FROM taxonomy.outbox WHERE payload->'data'->>'categoria_id' = ANY($1::text[])",
          [[childId, parentId]],
        );
        await admin.query('DELETE FROM taxonomy.categories WHERE id = $1', [
          childId,
        ]);
        await admin.query('DELETE FROM taxonomy.categories WHERE id = $1', [
          parentId,
        ]);
        vi.restoreAllMocks();
      }
    });

    it('reactiva marcas en transacción, conserva la barrera y revierte errores', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (callback) =>
        callback(dbApp),
      );
      const service = new BrandReactivationService(database);
      try {
        await admin.query(
          `INSERT INTO taxonomy.brands (id, nombre, estado, taxonomy_version) VALUES
          ($1, $4, 'INACTIVO', 2), ($2, $5, 'PENDING_DEACTIVATION', 3), ($3, $6, 'INACTIVO', 9223372036854775807)`,
          [
            ids[0],
            ids[1],
            ids[2],
            `Reactiva ${ids[0]}`,
            `Pendiente ${ids[1]}`,
            `Overflow ${ids[2]}`,
          ],
        );
        const first = await service.reactivar(ids[0]!);
        expect(first.estado).toBe('ACTIVA');
        if (first.estado === 'ACTIVA') expect(first.marca.version).toBe(3);
        const retry = await service.reactivar(ids[0]!);
        expect(retry).toEqual(first);
        expect(await service.reactivar(ids[1]!)).toEqual({
          estado: 'BAJA_EN_PROCESO',
        });
        expect(await service.reactivar(randomUUID())).toEqual({
          estado: 'NO_ENCONTRADA',
        });
        await expect(service.reactivar(ids[2]!)).rejects.toThrow();
        const rows = await admin.query(
          'SELECT id, estado, taxonomy_version FROM taxonomy.brands WHERE id = ANY($1::uuid[])',
          [ids],
        );
        expect(
          rows.rows.find((row: { id: string }) => row.id === ids[1]),
        ).toMatchObject({
          estado: 'PENDING_DEACTIVATION',
          taxonomy_version: '3',
        });
        expect(
          rows.rows.find((row: { id: string }) => row.id === ids[2]),
        ).toMatchObject({
          estado: 'INACTIVO',
          taxonomy_version: '9223372036854775807',
        });
      } finally {
        await admin.query(
          'DELETE FROM taxonomy.brands WHERE id = ANY($1::uuid[])',
          [ids],
        );
        vi.restoreAllMocks();
      }
    });

    it('findCategoriasActivas devuelve solo ACTIVO con el mapeo esperado', async () => {
      const filas = await repo.findCategoriasActivas();

      expect(filas.map((f) => f.nombre).sort()).toEqual([
        'Calzado',
        'Zapatillas',
      ]);
      expect(filas.every((f) => f.estado === 'ACTIVO')).toBe(true);
      const zapatillas = filas.find((f) => f.nombre === 'Zapatillas');
      expect(zapatillas?.categoria_padre_id).toBe(
        '11111111-1111-4111-8111-111111111111',
      );
    });

    it('findMarcasActivas devuelve solo ACTIVO y mapea sus columnas', async () => {
      const filas = await repo.findMarcasActivas();

      expect(filas).toEqual([
        {
          id: '44444444-4444-4444-8444-444444444444',
          nombre: 'Marathon',
          descripcion: 'Marca ecuatoriana',
          pais_origen_iso: 'EC',
          logo_url: null,
          estado: 'ACTIVO',
        },
      ]);
    });

    it('el esquema Drizzle coincide con las columnas reales de la base', async () => {
      const filas = await dbApp
        .select({
          nombre: marcas.nombre,
          normalizado: marcas.nombreNormalizado,
          pais: marcas.paisOrigenIso,
          version: marcas.taxonomyVersion,
          estado: marcas.estado,
        })
        .from(marcas)
        .orderBy(marcas.nombre);

      expect(filas).toEqual([
        {
          nombre: 'Marathon',
          normalizado: 'marathon',
          pais: 'EC',
          version: 0,
          estado: 'ACTIVO',
        },
        {
          nombre: 'Retirada',
          normalizado: 'retirada',
          pais: null,
          version: 0,
          estado: 'INACTIVO',
        },
      ]);
    });

    it('enTransaccion confirma los cambios al hacer commit', async () => {
      await repo.enTransaccion(async (tx) => {
        await tx
          .insert(marcas)
          .values({ nombre: 'Transaccion Commit', paisOrigenIso: 'EC' });
      });

      const { rows } = await admin.query<{ nombre: string }>(
        "SELECT nombre FROM taxonomy.brands WHERE nombre = 'Transaccion Commit'",
      );
      expect(rows).toHaveLength(1);
    });

    it('mapea y consulta la operación histórica, y exige operation_id único', async () => {
      const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const registro = {
        operationId,
        entityType: 'BRAND' as const,
        entityId: '44444444-4444-4444-8444-444444444444',
        correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      };
      await dbApp.insert(operacionesBaja).values(registro);
      const filas = await dbApp.select().from(operacionesBaja);
      expect(filas).toHaveLength(1);
      expect(filas[0]).toMatchObject({ ...registro, status: 'REQUESTED' });
      await expect(
        dbApp.insert(operacionesBaja).values(registro),
      ).rejects.toMatchObject({
        cause: { code: '23505', constraint: 'uq_mdo_operation_id' },
      });
    });

    it('valida versión y operación activa únicas con la migración aditiva en una transacción aislada', async () => {
      const client = await admin.connect();
      const migration = readFileSync(
        resolve(
          'apps/taxonomy-svc/migrations/0002_deactivation_source_version.sql',
        ),
        'utf8',
      );
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM taxonomy.master_deactivation_operations',
        );
        await client.query(migration);
        await client.query(
          `INSERT INTO taxonomy.master_deactivation_operations
          (operation_id, entity_type, entity_id, correlation_id, source_version)
          VALUES ($1, 'BRAND', $2, $3, $4)`,
          [
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
            '44444444-4444-4444-8444-444444444444',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            3,
          ],
        );
        await client.query('SAVEPOINT duplicado');
        await expect(
          client.query(
            `INSERT INTO taxonomy.master_deactivation_operations
          (operation_id, entity_type, entity_id, correlation_id, source_version)
          VALUES ($1, 'BRAND', $2, $3, $4)`,
            [
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
              '44444444-4444-4444-8444-444444444444',
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              3,
            ],
          ),
        ).rejects.toMatchObject({
          code: '23505',
          constraint: 'uq_mdo_active_entity',
        });
        await client.query('ROLLBACK TO SAVEPOINT duplicado');
        await client.query('SAVEPOINT sin_version');
        await expect(
          client.query(
            `INSERT INTO taxonomy.master_deactivation_operations
          (operation_id, entity_type, entity_id, correlation_id)
          VALUES ($1, 'CATEGORY', $2, $3)`,
            [
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
              '11111111-1111-4111-8111-111111111111',
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            ],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'ck_mdo_active_source_version',
        });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('detiene la migración si existen operaciones históricas activas sin versión', async () => {
      const client = await admin.connect();
      const migration = readFileSync(
        resolve(
          'apps/taxonomy-svc/migrations/0002_deactivation_source_version.sql',
        ),
        'utf8',
      );
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO taxonomy.master_deactivation_operations
          (operation_id, entity_type, entity_id, correlation_id)
          VALUES ($1, 'BRAND', $2, $3)`,
          [
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
            '44444444-4444-4444-8444-444444444444',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          ],
        );
        await expect(client.query(migration)).rejects.toThrow(
          'requieren reconciliación',
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('consulta el check correlacionado solo durante la ventana y el estado en curso', async () => {
      const client = await admin.connect();
      const migration = readFileSync(
        resolve(
          'apps/taxonomy-svc/migrations/0002_deactivation_source_version.sql',
        ),
        'utf8',
      );
      const database = new Database();
      const conexion = drizzle(client);
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(conexion),
      );
      const service = new DeactivationCheckService(database);
      const identidad = {
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
        correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        entityType: 'CATEGORY' as const,
        entityId: '11111111-1111-4111-8111-111111111111',
        version: 4,
      };
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM taxonomy.master_deactivation_operations',
        );
        await client.query(migration);
        await client.query(
          'CREATE TABLE taxonomy.product_type_characteristics (id uuid PRIMARY KEY, tipo_producto_id uuid NOT NULL, caracteristica_id uuid NOT NULL)',
        );
        await client.query(
          `INSERT INTO taxonomy.master_deactivation_operations
          (operation_id, entity_type, entity_id, correlation_id, source_version, status)
          VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS')`,
          [
            identidad.operationId,
            identidad.entityType,
            identidad.entityId,
            identidad.correlationId,
            identidad.version,
          ],
        );
        await expect(
          service.evaluar({ ...identidad, result: 'CLEAR' }),
        ).resolves.toBe('EVALUAR_BAJA');
        await expect(
          service.evaluar({ ...identidad, version: 3, result: 'CLEAR' }),
        ).resolves.toBe('IGNORAR');
        await client.query(
          "UPDATE taxonomy.master_deactivation_operations SET created_at = statement_timestamp() - interval '61 seconds' WHERE operation_id = $1",
          [identidad.operationId],
        );
        await expect(
          service.evaluar({ ...identidad, result: 'CLEAR' }),
        ).resolves.toBe('IGNORAR');
        await client.query(
          "UPDATE taxonomy.master_deactivation_operations SET created_at = statement_timestamp(), status = 'COMPLETED' WHERE operation_id = $1",
          [identidad.operationId],
        );
        await expect(
          service.evaluar({ ...identidad, result: 'CLEAR' }),
        ).resolves.toBe('IGNORAR');
      } finally {
        await client.query('ROLLBACK');
        vi.restoreAllMocks();
        client.release();
      }
    });

    it('enTransaccion revierte los cambios si la operacion falla', async () => {
      await expect(
        repo.enTransaccion(async (tx) => {
          await tx
            .insert(marcas)
            .values({ nombre: 'Transaccion Rollback', paisOrigenIso: 'EC' });
          throw new Error('rollback intencional');
        }),
      ).rejects.toThrow('rollback intencional');

      const { rows } = await admin.query<{ nombre: string }>(
        "SELECT nombre FROM taxonomy.brands WHERE nombre = 'Transaccion Rollback'",
      );
      expect(rows).toHaveLength(0);
    });

    it('revierte toda la transacción ante una restricción de unicidad normalizada', async () => {
      await expect(
        repo.enTransaccion(async (tx) => {
          await tx
            .insert(marcas)
            .values({ nombre: 'Marca rollback constraint' });
          await tx.insert(marcas).values({ nombre: '  MARATHON  ' });
        }),
      ).rejects.toMatchObject({
        cause: { code: '23505', constraint: 'uq_brands_nombre_normalizado' },
      });
      const { rows } = await admin.query(
        'SELECT id FROM taxonomy.brands WHERE nombre = $1',
        ['Marca rollback constraint'],
      );
      expect(rows).toHaveLength(0);
      const original = await admin.query(
        'SELECT nombre FROM taxonomy.brands WHERE nombre_normalizado = $1',
        ['marathon'],
      );
      expect(original.rows).toEqual([{ nombre: 'Marathon' }]);
    });

    it.each([
      [
        'nombre vacío de categoría',
        'INSERT INTO taxonomy.categories (nombre) VALUES ($1)',
        ['   '],
        'ck_categories_nombre_not_empty',
      ],
      [
        'versión negativa de categoría',
        'INSERT INTO taxonomy.categories (nombre, taxonomy_version) VALUES ($1, $2)',
        ['Versión inválida', -1],
        'ck_categories_version',
      ],
      [
        'versión negativa de marca',
        'INSERT INTO taxonomy.brands (nombre, taxonomy_version) VALUES ($1, $2)',
        ['Versión inválida', -1],
        'ck_brands_version',
      ],
      [
        'categoría autorreferenciada',
        'INSERT INTO taxonomy.categories (id, nombre, nivel, categoria_padre_id) VALUES ($1, $2, $3, $1)',
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Autorreferencia', 2],
        'ck_categories_no_self_parent',
      ],
    ])('rechaza %s', async (_caso, query, params, constraint) => {
      await expect(app.query(query, params)).rejects.toMatchObject({
        code: '23514',
        constraint,
      });
    });

    it('rechaza nombre vacío de marca', async () => {
      const error: unknown = await app
        .query('INSERT INTO taxonomy.brands (nombre) VALUES ($1)', ['   '])
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: '23514' });
      expect([
        'ck_brands_nombre_not_empty',
        'ck_brands_nombre_normalizado_not_empty',
      ]).toContain((error as { constraint?: string }).constraint);
    });

    it('aplica las restricciones oficiales de FK y CHECK de categorías', async () => {
      await expect(
        app.query(
          'INSERT INTO taxonomy.categories (nombre, nivel, categoria_padre_id) VALUES ($1, $2, $3)',
          ['Hija huérfana', 2, '99999999-9999-4999-8999-999999999999'],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_categories_categoria_padre',
      });
      await expect(
        app.query(
          'INSERT INTO taxonomy.categories (nombre, orden) VALUES ($1, $2)',
          ['Orden inválido', -1],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'ck_categories_orden',
      });
    });

    it('limita los mapeos y claves foráneas Drizzle al schema taxonomy', async () => {
      expect(getTableConfig(categorias).schema).toBe('taxonomy');
      expect(getTableConfig(marcas).schema).toBe('taxonomy');
      const fks = getTableConfig(categorias).foreignKeys;
      expect(fks).toHaveLength(1);
      const referencia = fks[0].reference();
      expect(fks[0].getName()).toBe('fk_categories_categoria_padre');
      expect(referencia.foreignTable).toBe(categorias);
      expect(getTableConfig(referencia.foreignTable).schema).toBe('taxonomy');
      expect(referencia.columns.map((column) => column.name)).toEqual([
        'categoria_padre_id',
      ]);
      expect(referencia.foreignColumns.map((column) => column.name)).toEqual([
        'id',
      ]);
      const { rows } = await admin.query(
        `SELECT n.nspname AS destino FROM pg_constraint c
        JOIN pg_class origen ON origen.oid = c.conrelid
        JOIN pg_namespace s ON s.oid = origen.relnamespace
        JOIN pg_class destino ON destino.oid = c.confrelid
        JOIN pg_namespace n ON n.oid = destino.relnamespace
        WHERE s.nspname = $1 AND c.contype = 'f'`,
        ['taxonomy'],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every((row: { destino: string }) => row.destino === 'taxonomy'),
      ).toBe(true);
    });

    it('verificarReadiness resuelve contra la base viva', async () => {
      await expect(repo.verificarReadiness()).resolves.toBeUndefined();
    });

    describe('readiness contra PostgreSQL real y permisos', () => {
      let appNest: INestApplication<App>;

      beforeAll(async () => {
        appNest = await levantarAppNest();
      }, 30_000);

      afterAll(async () => {
        await appNest?.close();
      }, 30_000);

      it('responde 200 cuando el rol puede leer las columnas requeridas', async () => {
        await request(appNest.getHttpServer())
          .get('/health/readiness')
          .expect(HttpStatus.OK);
      });

      it('responde 503 si se revoca SELECT sobre taxonomy.brands', async () => {
        await admin.query(`REVOKE SELECT ON taxonomy.brands FROM ${ROL_APP}`);
        try {
          await request(appNest.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.SERVICE_UNAVAILABLE);
        } finally {
          await admin.query(`GRANT SELECT ON taxonomy.brands TO ${ROL_APP}`);
        }
      });

      it('responde 503 si falta SELECT sobre categories.orden usado por la lectura comercial', async () => {
        await admin.query(
          `REVOKE SELECT ON taxonomy.categories FROM ${ROL_APP}`,
        );
        await admin.query(
          `GRANT SELECT (id, nombre, categoria_padre_id, nivel, estado) ON taxonomy.categories TO ${ROL_APP}`,
        );
        try {
          await request(appNest.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.SERVICE_UNAVAILABLE);
        } finally {
          await admin.query(
            `REVOKE SELECT (id, nombre, categoria_padre_id, nivel, estado) ON taxonomy.categories FROM ${ROL_APP}`,
          );
          await admin.query(
            `GRANT SELECT ON taxonomy.categories TO ${ROL_APP}`,
          );
        }
      });

      it('responde 503 si se revoca SELECT sobre la columna logo_url', async () => {
        await admin.query(`REVOKE SELECT ON taxonomy.brands FROM ${ROL_APP}`);
        await admin.query(
          `GRANT SELECT (id, nombre, descripcion, pais_origen_iso, estado) ON taxonomy.brands TO ${ROL_APP}`,
        );
        try {
          await request(appNest.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.SERVICE_UNAVAILABLE);
        } finally {
          await admin.query(
            `REVOKE SELECT (id, nombre, descripcion, pais_origen_iso, estado) ON taxonomy.brands FROM ${ROL_APP}`,
          );
          await admin.query(`GRANT SELECT ON taxonomy.brands TO ${ROL_APP}`);
        }
      });

      it('vuelve a responder 200 al restaurar los permisos', async () => {
        await request(appNest.getHttpServer())
          .get('/health/readiness')
          .expect(HttpStatus.OK);
      });
    });

    it('traduce la indisponibilidad de la base a 503', async () => {
      const repoCaido = crearRepositorioDrizzle(
        'postgresql://postgres:postgres@127.0.0.1:1/taxonomy',
      );

      try {
        const error = await repoCaido
          .findCategoriasActivas()
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ProblemDetailsException);
        expect((error as ProblemDetailsException).getStatus()).toBe(
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      } finally {
        await repoCaido.onApplicationShutdown();
      }
    });

    it('onApplicationShutdown cierra el pool y deja de atender consultas', async () => {
      const repoEfimero = crearRepositorioDrizzle(urlApp);

      await expect(repoEfimero.verificarReadiness()).resolves.toBeUndefined();
      await repoEfimero.onApplicationShutdown();

      await expect(repoEfimero.verificarReadiness()).rejects.toBeInstanceOf(
        ProblemDetailsException,
      );
    });

    it('el rol de aplicacion no puede crear objetos en el esquema', async () => {
      const error = await app
        .query('CREATE TABLE taxonomy.permiso_denegado (id int)')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe('42501');
    });

    it('GET /api/v1/categorias sirve datos reales a traves del modulo', async () => {
      const moduleFixture = await Test.createTestingModule({
        imports: [TaxonomySvcModule.forRoot({ databaseUrl: urlApp })],
      })
        .overrideGuard(TaxonomyAuthGuard)
        .useValue({ canActivate: () => true })
        .compile();
      const appNest: INestApplication<App> =
        moduleFixture.createNestApplication();
      await appNest.init();

      try {
        const categorias = await request(appNest.getHttpServer())
          .get('/api/v1/categorias')
          .expect(200);

        expect(
          categorias.body.categories
            .map((c: { name: string }) => c.name)
            .sort(),
        ).toEqual(['Calzado', 'Zapatillas']);

        await request(appNest.getHttpServer())
          .get('/health/readiness')
          .expect(200);
      } finally {
        await appNest.close();
      }
    });

    it('consulta categorías y marcas con JWT verificado y PostgreSQL aislado', async () => {
      const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const issuer = 'https://security.example.test';
      let origin = '';
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/discovery')
          res.end(JSON.stringify({ issuer, jwks_uri: origin + '/jwks' }));
        else if (req.url === '/jwks')
          res.end(
            JSON.stringify({
              keys: [
                {
                  ...keys.publicKey.export({ format: 'jwk' }),
                  kid: 'test',
                  alg: 'RS256',
                  use: 'sig',
                },
              ],
            }),
          );
        else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Puerto no disponible');
      origin = `http://127.0.0.1:${address.port}`;
      const token = (scope: string, humano = false) => {
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(
          JSON.stringify({ alg: 'RS256', kid: 'test' }),
        ).toString('base64url');
        const payload = Buffer.from(
          JSON.stringify({
            iss: issuer,
            sub: humano ? randomUUID() : 'catalog-svc',
            tipo: humano ? 'acceso' : 'servicio',
            ...(humano ? { roles: [] } : {}),
            aud: 'api-productos',
            scope,
            iat: now,
            exp: now + 60,
            jti: randomUUID(),
          }),
        ).toString('base64url');
        const input = `${header}.${payload}`;
        return `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
      };
      let nest: INestApplication<App> | undefined;
      const brandId = randomUUID();
      let nuevaMarca: string | undefined;
      let marcaConUrl: string | undefined;
      let categoryCreated: string | undefined;
      try {
        await admin.query(
          "INSERT INTO taxonomy.brands (id, nombre, estado) VALUES ($1, $2, 'INACTIVO')",
          [brandId, `Http ${brandId}`],
        );
        const moduleFixture = await Test.createTestingModule({
          imports: [TaxonomySvcModule.forRoot({ databaseUrl: urlApp })],
        })
          .overrideProvider(TAXONOMY_SECURITY_CONFIG)
          .useValue({
            issuer,
            discoveryUrl: origin + '/discovery',
            jwksUrl: origin + '/jwks',
          })
          .overrideProvider(Database)
          .useValue({
            read: (callback: (db: NodePgDatabase) => Promise<unknown>) =>
              callback(dbApp),
          })
          .compile();
        nest = moduleFixture.createNestApplication();
        await nest.init();
        for (const [path, key] of [
          ['categorias', 'categories'],
          ['marcas', 'brands'],
        ] as const) {
          await request(nest.getHttpServer())
            .get(`/api/v1/${path}`)
            .expect(401);
          const denied = await request(nest.getHttpServer())
            .get(`/api/v1/${path}`)
            .set('Authorization', `Bearer ${token('otro:leer')}`)
            .expect(403);
          expect(denied.body.code).toBe('SCOPE_INSUFICIENTE');
          const result = await request(nest.getHttpServer())
            .get(`/api/v1/${path}`)
            .set('Authorization', `Bearer ${token('catalogo:leer')}`)
            .expect(200);
          expect(result.body[key].length).toBeGreaterThan(0);
          expect(
            result.body[key].every(
              (row: { status: string }) => row.status === 'ACTIVA',
            ),
          ).toBe(true);
        }
        const endpoint = `/api/v1/marcas/${brandId}/reactivar`;
        await request(nest.getHttpServer()).post(endpoint).expect(401);
        await request(nest.getHttpServer())
          .post(endpoint)
          .set('Authorization', `Bearer ${token('catalogo:leer')}`)
          .expect(403);
        const reactivada = await request(nest.getHttpServer())
          .post(endpoint)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        expect(reactivada.body).toMatchObject({
          marcaId: brandId,
          estado: 'ACTIVO',
          version: 1,
        });
        const retry = await request(nest.getHttpServer())
          .post(endpoint)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        expect(retry.body).toEqual(reactivada.body);
        const categoryBody = {
          nombre: `Http ${brandId}`,
          slugConfirmado: `http-${brandId}`,
        };
        const createdCategory = await request(nest.getHttpServer())
          .post('/api/v1/categorias')
          .set('Authorization', `Bearer ${token('', true)}`)
          .send(categoryBody)
          .expect(201);
        categoryCreated = createdCategory.body.categoriaId;
        expect(createdCategory.body.slug).toBe(categoryBody.slugConfirmado);
        const duplicate = await request(nest.getHttpServer())
          .post('/api/v1/categorias')
          .set('Authorization', `Bearer ${token('', true)}`)
          .send(categoryBody)
          .expect(409);
        expect(duplicate.body.code).toBe('SLUG_DUPLICADO');
        const categoryPath = `/api/v1/categorias/${categoryCreated}`;
        const editedCategory = await request(nest.getHttpServer())
          .patch(categoryPath)
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({ nombre: 'Categoría editada', version: 0 })
          .expect(200);
        expect(editedCategory.body).toMatchObject({
          nombre: 'Categoría editada',
          version: 1,
        });
        const categoryConflict = await request(nest.getHttpServer())
          .patch(categoryPath)
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({ nombre: 'Obsoleta', version: 0 })
          .expect(409);
        expect(categoryConflict.body.code).toBe('VERSION_CONFLICT');
        const categoryCycle = await request(nest.getHttpServer())
          .patch(categoryPath)
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({ categoriaPadreId: categoryCreated })
          .expect(409);
        expect(categoryCycle.body.code).toBe('CICLO_CATEGORIA');
        const depth = await request(nest.getHttpServer())
          .patch(categoryPath)
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({ categoriaPadreId: '22222222-2222-4222-8222-222222222222' })
          .expect(422);
        expect(depth.body.code).toBe('PROFUNDIDAD_CATEGORIA_EXCEDIDA');
        const event = await admin.query(
          "SELECT event_name FROM taxonomy.outbox WHERE payload->'data'->>'categoria_id' = $1",
          [categoryCreated],
        );
        expect(event.rows).toEqual([
          { event_name: 'taxonomy.category.updated' },
          { event_name: 'taxonomy.category.updated' },
        ]);
        const logo = readFileSync(
          resolve('apps/taxonomy-svc/test/fixtures/logo.png'),
        );
        const nueva = await request(nest.getHttpServer())
          .post('/api/v1/marcas')
          .set('Authorization', `Bearer ${token('', true)}`)
          .field('nombre', `Marca ${brandId}`)
          .attach('logo', logo, {
            filename: 'logo.png',
            contentType: 'image/png',
          })
          .expect(201);
        nuevaMarca = nueva.body.marcaId;
        expect(nueva.body.logoUrl).toBeNull();
        const conUrl = await request(nest.getHttpServer())
          .post('/api/v1/marcas')
          .set('Authorization', `Bearer ${token('', true)}`)
          .field('nombre', `Logo explícito ${brandId}`)
          .field('logoUrl', 'https://example.org/logo.png')
          .attach('logo', logo, {
            filename: 'logo.png',
            contentType: 'image/png',
          })
          .expect(201);
        marcaConUrl = conUrl.body.marcaId;
        const persisted = await admin.query(
          'SELECT logo_url FROM taxonomy.brands WHERE id = $1',
          [marcaConUrl],
        );
        expect(persisted.rows[0].logo_url).toBe('https://example.org/logo.png');
        await admin.query(
          "UPDATE taxonomy.brands SET descripcion = 'texto', pais_origen_iso = 'PE', logo_url = 'https://example.org/logo.png' WHERE id = $1",
          [brandId],
        );
        const editada = await request(nest.getHttpServer())
          .patch(`/api/v1/marcas/${brandId}`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .field('nombre', `Modificada ${brandId}`)
          .field('version', '1')
          .expect(200);
        expect(editada.body).toMatchObject({
          version: 2,
          nombre: `Modificada ${brandId}`,
        });
        await request(nest.getHttpServer())
          .patch(`/api/v1/marcas/${brandId}`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .field('nombre', 'Obsoleta')
          .field('version', '0')
          .expect(409);
        const clear = await request(nest.getHttpServer())
          .patch(`/api/v1/marcas/${brandId}`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .field('descripcion', '')
          .field('paisOrigenIso', '')
          .field('logo', '')
          .field('version', '2')
          .expect(200);
        expect(clear.body).toMatchObject({
          descripcion: null,
          paisOrigenIso: null,
          logoUrl: null,
        });
      } finally {
        await nest?.close();
        if (nuevaMarca)
          await admin.query('DELETE FROM taxonomy.brands WHERE id = $1', [
            nuevaMarca,
          ]);
        if (marcaConUrl)
          await admin.query('DELETE FROM taxonomy.brands WHERE id = $1', [
            marcaConUrl,
          ]);
        if (categoryCreated) {
          await admin.query(
            "DELETE FROM taxonomy.outbox WHERE payload->'data'->>'categoria_id' = $1",
            [categoryCreated],
          );
          await admin.query(
            'DELETE FROM taxonomy.category_seo WHERE categoria_id = $1',
            [categoryCreated],
          );
          await admin.query('DELETE FROM taxonomy.categories WHERE id = $1', [
            categoryCreated,
          ]);
        }
        await admin.query('DELETE FROM taxonomy.brands WHERE id = $1', [
          brandId,
        ]);
        await new Promise<void>((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose())),
        );
      }
    });

    it('demo en loopback lee registros reales en PostgreSQL sin aceptar credenciales falsas', async () => {
      const fixture = await Test.createTestingModule({
        imports: [
          TaxonomySvcModule.forRoot({
            databaseUrl: urlApp,
            env: { NODE_ENV: 'test', ALLOW_DEMO_UNAUTHENTICATED: 'true' },
          }),
        ],
      }).compile();
      const demo = fixture.createNestApplication();
      await demo.init();
      try {
        for (const [path, key] of [
          ['categorias', 'categories'],
          ['marcas', 'brands'],
        ] as const) {
          const response = await request(demo.getHttpServer())
            .get(`/api/v1/${path}`)
            .expect(200);
          expect(response.body[key].length).toBeGreaterThan(0);
          expect(
            response.body[key].every(
              (row: { status: string }) => row.status === 'ACTIVA',
            ),
          ).toBe(true);
          await request(demo.getHttpServer())
            .get(`/api/v1/${path}`)
            .set('Authorization', 'Bearer invalid')
            .expect(401);
        }
      } finally {
        await demo.close();
      }
    });

    it('la migración de configuración inicializa 60 segundos y respeta un valor existente', async () => {
      const client = await admin.connect();
      const migration = readFileSync(
        resolve(
          'apps/taxonomy-svc/migrations/0003_deactivation_timeout_setting.sql',
        ),
        'utf8',
      );
      try {
        await client.query('BEGIN');
        await client.query(
          "DELETE FROM taxonomy.runtime_settings WHERE clave = 'MASTER_DEACTIVATION_TIMEOUT_SECONDS'",
        );
        await client.query(migration);
        expect(
          (
            await client.query(
              "SELECT valor_integer FROM taxonomy.runtime_settings WHERE clave = 'MASTER_DEACTIVATION_TIMEOUT_SECONDS'",
            )
          ).rows,
        ).toEqual([{ valor_integer: 60 }]);
        await client.query(
          "UPDATE taxonomy.runtime_settings SET valor_integer = 120 WHERE clave = 'MASTER_DEACTIVATION_TIMEOUT_SECONDS'",
        );
        await client.query(migration);
        expect(
          (
            await client.query(
              "SELECT valor_integer FROM taxonomy.runtime_settings WHERE clave = 'MASTER_DEACTIVATION_TIMEOUT_SECONDS'",
            )
          ).rows,
        ).toEqual([{ valor_integer: 120 }]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('registra intenciones con versión autoritativa y deduplica sin aceptar cambios', async () => {
      await admin.query('DELETE FROM taxonomy.master_deactivation_operations');
      const migration = readFileSync(
        resolve(
          'apps/taxonomy-svc/migrations/0002_deactivation_source_version.sql',
        ),
        'utf8',
      );
      await admin.query('BEGIN');
      try {
        await admin.query(migration);
        await admin.query('COMMIT');
      } catch (error) {
        await admin.query('ROLLBACK');
        throw error;
      }
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const solicitud = {
        operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        correlationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        entityType: 'CATEGORY' as const,
        entityId: '22222222-2222-4222-8222-222222222222',
        version: 0,
      };
      try {
        const service = new DeactivationIntentService(database);
        const simultaneas = await Promise.all([
          service.registrar(solicitud),
          service.registrar(solicitud),
        ]);
        expect(simultaneas.sort()).toEqual(['REGISTRADA', 'REINTENTO']);
        await expect(
          new DeactivationIntentService(database).registrar(solicitud),
        ).resolves.toBe('REINTENTO');
        await expect(
          service.registrar({ ...solicitud, version: 1 }),
        ).resolves.toBe('CONFLICTO');
        await expect(
          service.registrar({
            ...solicitud,
            operationId: 'abababab-abab-4bab-8bab-abababababab',
            entityId: '11111111-1111-4111-8111-111111111111',
            version: 1,
          }),
        ).resolves.toBe('NO_DISPONIBLE');
        await expect(
          service.registrar({ ...solicitud, entityType: 'PRODUCT_TYPE' }),
        ).resolves.toBe('NO_DISPONIBLE');
        await expect(
          service.registrar({
            ...solicitud,
            correlationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          }),
        ).resolves.toBe('CONFLICTO');
        await expect(
          service.registrar({
            ...solicitud,
            operationId: '99999999-9999-4999-8999-999999999999',
          }),
        ).resolves.toBe('CONFLICTO');
        const rows = await admin.query(
          'SELECT operation_id, source_version FROM taxonomy.master_deactivation_operations',
        );
        expect(rows.rows).toEqual([
          { operation_id: solicitud.operationId, source_version: '0' },
        ]);
        const estado = await admin.query(
          `SELECT o.status, c.estado FROM taxonomy.master_deactivation_operations o
          JOIN taxonomy.categories c ON c.id = o.entity_id WHERE o.operation_id = $1`,
          [solicitud.operationId],
        );
        expect(estado.rows).toEqual([
          { status: 'IN_PROGRESS', estado: 'PENDING_DEACTIVATION' },
        ]);
        const eventos = await admin.query(
          'SELECT event_name, kind, payload FROM taxonomy.outbox WHERE operation_id = $1',
          [solicitud.operationId],
        );
        expect(eventos.rows).toHaveLength(1);
        expect(eventos.rows[0]).toMatchObject({
          event_name: 'taxonomy.master.deactivation.check.requested',
          kind: 'command',
          payload: {
            operation_id: solicitud.operationId,
            data: {
              entity_type: 'CATEGORY',
              entity_id: solicitud.entityId,
              version: 0,
            },
          },
        });
      } finally {
        await admin.query(
          'DELETE FROM taxonomy.outbox WHERE operation_id = $1',
          [solicitud.operationId],
        );
        await admin.query(
          'DELETE FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
          [solicitud.operationId],
        );
        await admin.query(
          "UPDATE taxonomy.categories SET estado = 'ACTIVO' WHERE id = $1",
          [solicitud.entityId],
        );
        vi.restoreAllMocks();
      }
    });

    it('rechaza la baja de una categoría con subcategorías activas sin crear operación ni evento', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const operationId = '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      try {
        await expect(
          new DeactivationIntentService(database).registrar({
            operationId,
            correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            entityType: 'CATEGORY',
            entityId: '11111111-1111-4111-8111-111111111111',
            version: 0,
          }),
        ).resolves.toBe('NO_DISPONIBLE');
        expect(
          (
            await admin.query(
              'SELECT operation_id FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await admin.query(
              'SELECT message_id FROM taxonomy.outbox WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await admin.query(
              "SELECT estado FROM taxonomy.categories WHERE id = '11111111-1111-4111-8111-111111111111'",
            )
          ).rows,
        ).toEqual([{ estado: 'ACTIVO' }]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('falla cerrado cuando falta la configuración de timeout', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const intencion = {
        operationId: 'abababab-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        entityType: 'BRAND' as const,
        entityId: '44444444-4444-4444-8444-444444444444',
        version: 0,
      };
      try {
        await admin.query(
          "DELETE FROM taxonomy.runtime_settings WHERE clave = 'MASTER_DEACTIVATION_TIMEOUT_SECONDS'",
        );
        await expect(
          new DeactivationIntentService(database).registrar(intencion),
        ).rejects.toThrow('Configuración de timeout de baja no disponible');
        expect(
          (
            await admin.query(
              'SELECT operation_id FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
              [intencion.operationId],
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await admin.query(
              'SELECT estado FROM taxonomy.brands WHERE id = $1',
              [intencion.entityId],
            )
          ).rows,
        ).toEqual([{ estado: 'ACTIVO' }]);
      } finally {
        await admin.query(
          "INSERT INTO taxonomy.runtime_settings (clave, valor_integer) VALUES ('MASTER_DEACTIVATION_TIMEOUT_SECONDS', 60) ON CONFLICT (clave) DO UPDATE SET valor_integer = 60",
        );
        vi.restoreAllMocks();
      }
    });

    it('revierte la admisión completa si falla el outbox', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const intencion = {
        operationId: 'abababab-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        entityType: 'BRAND' as const,
        entityId: '44444444-4444-4444-8444-444444444444',
        version: 0,
      };
      try {
        await admin.query(`REVOKE INSERT ON taxonomy.outbox FROM ${ROL_APP}`);
        await expect(
          new DeactivationIntentService(database).registrar(intencion),
        ).rejects.toThrow();
        expect(
          (
            await admin.query(
              'SELECT operation_id FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
              [intencion.operationId],
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await admin.query(
              'SELECT estado FROM taxonomy.brands WHERE id = $1',
              [intencion.entityId],
            )
          ).rows,
        ).toEqual([{ estado: 'ACTIVO' }]);
      } finally {
        await admin.query(`GRANT INSERT ON taxonomy.outbox TO ${ROL_APP}`);
        vi.restoreAllMocks();
      }
    });

    it('notifica una versión discrepante sin cerrar y recupera tras reconciliación', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const aviso = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const operationId = '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const entityId = '44444444-4444-4444-8444-444444444444';
      try {
        await admin.query(
          "UPDATE taxonomy.brands SET estado = 'PENDING_DEACTIVATION', taxonomy_version = 1 WHERE id = $1",
          [entityId],
        );
        await admin.query(
          `INSERT INTO taxonomy.master_deactivation_operations
          (operation_id, correlation_id, entity_type, entity_id, status, source_version, created_at)
          VALUES ($1, $2, 'BRAND', $3, 'IN_PROGRESS', 0, statement_timestamp() - interval '61 seconds')`,
          [operationId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', entityId],
        );
        const service = new DeactivationIntentService(database);
        await expect(service.recuperarVencidas()).resolves.toBe(0);
        expect(aviso).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'taxonomy.deactivation.recovery_discrepancy',
            operation_id: operationId,
            reason: 'VERSION_DISTINTA',
            muestra_truncada: false,
          }),
        );
        await expect(service.recuperarVencidas()).resolves.toBe(0);
        expect(aviso).toHaveBeenCalledTimes(1);
        const momento = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(momento + 5 * 60 * 1000 + 1);
        await expect(service.recuperarVencidas()).resolves.toBe(0);
        expect(aviso).toHaveBeenCalledTimes(2);
        expect(
          (
            await admin.query(
              'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toEqual([{ status: 'IN_PROGRESS' }]);
        expect(
          (
            await admin.query(
              'SELECT id FROM taxonomy.outbox WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toHaveLength(0);
        // Solo en PostgreSQL desechable: recrea una precondición válida para probar
        // el reintento. Reducir la versión NO es una reconciliación permitida en producción.
        await admin.query(
          'UPDATE taxonomy.brands SET taxonomy_version = 0 WHERE id = $1',
          [entityId],
        );
        await expect(service.recuperarVencidas()).resolves.toBe(1);
        expect(
          (
            await admin.query(
              'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toEqual([{ status: 'FAILED' }]);
        expect(
          (
            await admin.query(
              'SELECT id FROM taxonomy.outbox WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toHaveLength(1);
      } finally {
        await admin.query(
          "UPDATE taxonomy.brands SET estado = 'ACTIVO', taxonomy_version = 0 WHERE id = $1",
          [entityId],
        );
        vi.restoreAllMocks();
      }
    });

    it('detecta CAMBIO_CONCURRENTE al esperar una actualización de otra conexión PostgreSQL', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const aviso = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const operationId = '88888888-cccc-4ccc-8ccc-cccccccccccc';
      const entityId = '44444444-4444-4444-8444-444444444444';
      const bloqueador = await admin.connect();
      let recuperacion: Promise<number> | undefined;
      try {
        await admin.query(
          "UPDATE taxonomy.brands SET estado = 'PENDING_DEACTIVATION', taxonomy_version = 0 WHERE id = $1",
          [entityId],
        );
        await admin.query(
          `INSERT INTO taxonomy.master_deactivation_operations
          (operation_id, correlation_id, entity_type, entity_id, status, source_version, created_at)
          VALUES ($1, $2, 'BRAND', $3, 'IN_PROGRESS', 0, statement_timestamp() - interval '61 seconds')`,
          [operationId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', entityId],
        );
        await bloqueador.query('BEGIN');
        await bloqueador.query(
          'UPDATE taxonomy.brands SET taxonomy_version = 1 WHERE id = $1',
          [entityId],
        );
        const pid = (await bloqueador.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        recuperacion = new DeactivationIntentService(
          database,
        ).recuperarVencidas();
        let bloqueada = false;
        for (let i = 0; i < 100; i++) {
          const espera = await admin.query(
            'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [pid],
          );
          if (espera.rowCount) {
            bloqueada = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(bloqueada).toBe(true);
        await bloqueador.query('COMMIT');
        await expect(recuperacion).resolves.toBe(0);
        expect(aviso).toHaveBeenCalledWith(
          expect.objectContaining({
            operation_id: operationId,
            reason: 'CAMBIO_CONCURRENTE',
          }),
        );
        expect(
          (
            await admin.query(
              'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toEqual([{ status: 'IN_PROGRESS' }]);
        expect(
          (
            await admin.query(
              'SELECT estado, taxonomy_version FROM taxonomy.brands WHERE id = $1',
              [entityId],
            )
          ).rows,
        ).toEqual([{ estado: 'PENDING_DEACTIVATION', taxonomy_version: '1' }]);
        expect(
          (
            await admin.query(
              'SELECT id FROM taxonomy.outbox WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await bloqueador.query('ROLLBACK');
        if (recuperacion) await recuperacion.catch(() => undefined);
        bloqueador.release();
        await admin.query(
          'DELETE FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
          [operationId],
        );
        await admin.query(
          "UPDATE taxonomy.brands SET estado = 'ACTIVO', taxonomy_version = 0 WHERE id = $1",
          [entityId],
        );
        vi.restoreAllMocks();
      }
    });

    it('notifica estado distinto y no modifica la entidad ni cierra la operación', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const aviso = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const operationId = '88888888-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const entityId = '44444444-4444-4444-8444-444444444444';
      try {
        await admin.query(
          `INSERT INTO taxonomy.master_deactivation_operations
          (operation_id, correlation_id, entity_type, entity_id, status, source_version, created_at)
          VALUES ($1, $2, 'BRAND', $3, 'IN_PROGRESS', 0, statement_timestamp() - interval '61 seconds')`,
          [operationId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', entityId],
        );
        await expect(
          new DeactivationIntentService(database).recuperarVencidas(),
        ).resolves.toBe(0);
        expect(aviso).toHaveBeenCalledWith(
          expect.objectContaining({
            operation_id: operationId,
            reason: 'ESTADO_DISTINTO',
          }),
        );
        expect(
          (
            await admin.query(
              'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toEqual([{ status: 'IN_PROGRESS' }]);
        expect(
          (
            await admin.query(
              'SELECT estado FROM taxonomy.brands WHERE id = $1',
              [entityId],
            )
          ).rows,
        ).toEqual([{ estado: 'ACTIVO' }]);
        expect(
          (
            await admin.query(
              'SELECT id FROM taxonomy.outbox WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await admin.query(
          'DELETE FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
          [operationId],
        );
        vi.restoreAllMocks();
      }
    });

    it('no bloquea recuperaciones válidas si hay más de 50 entidades ausentes', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const aviso = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const correlationId = '99999999-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const operationId = '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const entityId = '44444444-4444-4444-8444-444444444444';
      try {
        await admin.query(
          `INSERT INTO taxonomy.master_deactivation_operations
          (operation_id, correlation_id, entity_type, entity_id, status, source_version, created_at)
          SELECT gen_random_uuid(), $1, 'BRAND', gen_random_uuid(), 'IN_PROGRESS', 0,
            statement_timestamp() - interval '120 seconds' FROM generate_series(1, 51)`,
          [correlationId],
        );
        await admin.query(
          "UPDATE taxonomy.brands SET estado = 'PENDING_DEACTIVATION' WHERE id = $1",
          [entityId],
        );
        await admin.query(
          `INSERT INTO taxonomy.master_deactivation_operations
          (operation_id, correlation_id, entity_type, entity_id, status, source_version, created_at)
          VALUES ($1, $2, 'BRAND', $3, 'IN_PROGRESS', 0, statement_timestamp() - interval '61 seconds')`,
          [operationId, correlationId, entityId],
        );
        await expect(
          new DeactivationIntentService(database).recuperarVencidas(),
        ).resolves.toBe(1);
        expect(aviso).toHaveBeenCalledTimes(50);
        expect(aviso).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'taxonomy.deactivation.recovery_discrepancy',
            reason: 'ENTIDAD_AUSENTE',
            muestra_truncada: true,
          }),
        );
        expect(
          (
            await admin.query(
              "SELECT count(*)::integer AS n FROM taxonomy.master_deactivation_operations WHERE correlation_id = $1 AND status = 'IN_PROGRESS'",
              [correlationId],
            )
          ).rows,
        ).toEqual([{ n: 51 }]);
        expect(
          (
            await admin.query(
              'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toEqual([{ status: 'FAILED' }]);
      } finally {
        await admin.query(
          'DELETE FROM taxonomy.outbox WHERE correlation_id = $1',
          [correlationId],
        );
        await admin.query(
          'DELETE FROM taxonomy.master_deactivation_operations WHERE correlation_id = $1',
          [correlationId],
        );
        await admin.query(
          "UPDATE taxonomy.brands SET estado = 'ACTIVO' WHERE id = $1",
          [entityId],
        );
        vi.restoreAllMocks();
      }
    });

    it('recupera una baja vencida de forma atómica e idempotente con rechazo en outbox', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const operationId = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      try {
        const service = new DeactivationIntentService(database);
        await expect(
          service.registrar({
            operationId,
            correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            entityType: 'BRAND',
            entityId: '44444444-4444-4444-8444-444444444444',
            version: 0,
          }),
        ).resolves.toBe('REGISTRADA');
        await admin.query(
          "UPDATE taxonomy.master_deactivation_operations SET created_at = statement_timestamp() - interval '61 seconds' WHERE operation_id = $1",
          [operationId],
        );
        await admin.query(
          "UPDATE taxonomy.runtime_settings SET valor_integer = 120 WHERE clave = 'MASTER_DEACTIVATION_TIMEOUT_SECONDS'",
        );
        await expect(service.recuperarVencidas()).resolves.toBe(0);
        await admin.query(
          "UPDATE taxonomy.runtime_settings SET valor_integer = 60 WHERE clave = 'MASTER_DEACTIVATION_TIMEOUT_SECONDS'",
        );
        await expect(service.recuperarVencidas()).resolves.toBe(1);
        await expect(
          new DeactivationIntentService(database).recuperarVencidas(),
        ).resolves.toBe(0);
        const row = await admin.query(
          `SELECT o.status, o.reason, b.estado
          FROM taxonomy.master_deactivation_operations o JOIN taxonomy.brands b ON b.id = o.entity_id
          WHERE o.operation_id = $1`,
          [operationId],
        );
        expect(row.rows).toEqual([
          { status: 'FAILED', reason: 'TECHNICAL_FAILURE', estado: 'ACTIVO' },
        ]);
        const events = await admin.query(
          "SELECT event_name, payload FROM taxonomy.outbox WHERE operation_id = $1 AND event_name = 'taxonomy.master.deactivation.rejected'",
          [operationId],
        );
        expect(events.rows).toHaveLength(1);
        expect(events.rows[0]).toMatchObject({
          event_name: 'taxonomy.master.deactivation.rejected',
          payload: {
            data: {
              entity_type: 'BRAND',
              version: 0,
              reason: 'TECHNICAL_FAILURE',
            },
          },
        });
      } finally {
        await admin.query(
          "UPDATE taxonomy.runtime_settings SET valor_integer = 60 WHERE clave = 'MASTER_DEACTIVATION_TIMEOUT_SECONDS'",
        );
        vi.restoreAllMocks();
      }
    });

    it.each([
      [
        'CLEAR',
        'COMPLETADA',
        'COMPLETED',
        'INACTIVO',
        'taxonomy.master.deactivated',
      ],
      [
        'IN_USE',
        'RECHAZADA',
        'REJECTED',
        'ACTIVO',
        'taxonomy.master.deactivation.rejected',
      ],
    ])(
      'cierra %s con estado y outbox correlacionados',
      async (result, esperado, status, estado, eventName) => {
        const database = new Database();
        vi.spyOn(database, 'read').mockImplementation(async (query) =>
          query(dbApp),
        );
        const operationId =
          result === 'CLEAR'
            ? '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            : '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const identity = {
          operationId,
          correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          entityType: 'BRAND' as const,
          entityId: '44444444-4444-4444-8444-444444444444',
          version: 0,
        };
        try {
          const service = new DeactivationIntentService(database);
          await expect(service.registrar(identity)).resolves.toBe('REGISTRADA');
          await expect(
            service.finalizar({ ...identity, version: 1, result }),
          ).resolves.toBe('IGNORADA');
          await expect(
            service.finalizar({ ...identity, result }),
          ).resolves.toBe(esperado);
          await expect(
            service.finalizar({ ...identity, result }),
          ).resolves.toBe('IGNORADA');
          const row = await admin.query(
            `SELECT o.status, b.estado FROM taxonomy.master_deactivation_operations o
          JOIN taxonomy.brands b ON b.id = o.entity_id WHERE o.operation_id = $1`,
            [operationId],
          );
          expect(row.rows).toEqual([{ status, estado }]);
          const events = await admin.query(
            'SELECT event_name, kind, payload FROM taxonomy.outbox WHERE operation_id = $1 AND event_name = $2',
            [operationId, eventName],
          );
          expect(events.rows).toHaveLength(1);
          expect(events.rows[0]).toMatchObject({
            event_name: eventName,
            kind: result === 'CLEAR' ? 'event' : 'result',
            payload: {
              operation_id: operationId,
              correlation_id: identity.correlationId,
              data: {
                entity_type: 'BRAND',
                entity_id: identity.entityId,
                version: 0,
                ...(result === 'IN_USE' ? { reason: 'IN_USE' } : {}),
              },
            },
          });
        } finally {
          await admin.query(
            "UPDATE taxonomy.brands SET estado = 'ACTIVO', taxonomy_version = 0 WHERE id = $1",
            [identity.entityId],
          );
          vi.restoreAllMocks();
        }
      },
    );

    it('revierte la recuperación ante fallo del outbox y permite reintentarla', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const operationId = '66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const entityId = '44444444-4444-4444-8444-444444444444';
      try {
        const service = new DeactivationIntentService(database);
        await expect(
          service.registrar({
            operationId,
            correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            entityType: 'BRAND',
            entityId,
            version: 0,
          }),
        ).resolves.toBe('REGISTRADA');
        await admin.query(
          "UPDATE taxonomy.master_deactivation_operations SET created_at = statement_timestamp() - interval '61 seconds' WHERE operation_id = $1",
          [operationId],
        );
        await admin.query(`REVOKE INSERT ON taxonomy.outbox FROM ${ROL_APP}`);
        await expect(service.recuperarVencidas()).rejects.toThrow();
        const unchanged = await admin.query(
          `SELECT o.status, b.estado FROM taxonomy.master_deactivation_operations o
          JOIN taxonomy.brands b ON b.id = o.entity_id WHERE o.operation_id = $1`,
          [operationId],
        );
        expect(unchanged.rows).toEqual([
          { status: 'IN_PROGRESS', estado: 'PENDING_DEACTIVATION' },
        ]);
        expect(
          (
            await admin.query(
              "SELECT id FROM taxonomy.outbox WHERE operation_id = $1 AND event_name = 'taxonomy.master.deactivation.rejected'",
              [operationId],
            )
          ).rows,
        ).toHaveLength(0);
        await admin.query(`GRANT INSERT ON taxonomy.outbox TO ${ROL_APP}`);
        await expect(service.recuperarVencidas()).resolves.toBe(1);
        expect(
          (
            await admin.query(
              'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toEqual([{ status: 'FAILED' }]);
      } finally {
        await admin.query(`GRANT INSERT ON taxonomy.outbox TO ${ROL_APP}`);
        await admin.query(
          "UPDATE taxonomy.brands SET estado = 'ACTIVO' WHERE id = $1",
          [entityId],
        );
        vi.restoreAllMocks();
      }
    });

    describe('repositorio de runtime (PostgresTaxonomyRepository)', () => {
      let poolRuntime: Pool;
      let repoRuntime: PostgresTaxonomyRepository;

      beforeAll(() => {
        poolRuntime = new Pool({ connectionString: urlApp });
        repoRuntime = new PostgresTaxonomyRepository(
          adaptadorRuntime(poolRuntime),
        );
      });

      afterAll(async () => {
        try {
          await poolRuntime?.end();
        } catch {
          /* cierre defensivo */
        }
      });

      it('ejecuta consultas reales y devuelve solo filas ACTIVO', async () => {
        const categorias = await repoRuntime.findCategoriasActivas();
        expect(categorias.map((c) => c.nombre)).toEqual(
          expect.arrayContaining(['Calzado', 'Zapatillas']),
        );
        expect(categorias.every((c) => c.estado === 'ACTIVO')).toBe(true);

        const marcasActivas = await repoRuntime.findMarcasActivas();
        const nombresMarcas = marcasActivas.map((m) => m.nombre);
        expect(nombresMarcas).toContain('Marathon');
        expect(nombresMarcas).not.toContain('Retirada');
        expect(marcasActivas.every((m) => m.estado === 'ACTIVO')).toBe(true);
      });

      it('readiness es verdadero contra la base viva', async () => {
        await expect(repoRuntime.readiness()).resolves.toBe(true);
        await expect(repoRuntime.verificarReadiness()).resolves.toBeUndefined();
      });

      it('traduce permisos denegados a 503 vía HTTP y se recupera', async () => {
        const moduleFixture = await Test.createTestingModule({
          imports: [TaxonomySvcModule],
        })
          .overrideProvider(TAXONOMY_REPOSITORY)
          .useValue(repoRuntime)
          .compile();
        const appRuntime: INestApplication<App> =
          moduleFixture.createNestApplication();
        await appRuntime.init();

        try {
          await request(appRuntime.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.OK);

          await admin.query(`REVOKE SELECT ON taxonomy.brands FROM ${ROL_APP}`);
          try {
            await request(appRuntime.getHttpServer())
              .get('/health/readiness')
              .expect(HttpStatus.SERVICE_UNAVAILABLE);
          } finally {
            await admin.query(`GRANT SELECT ON taxonomy.brands TO ${ROL_APP}`);
          }

          await request(appRuntime.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.OK);
        } finally {
          await appRuntime.close();
        }
      });

      it('responde 503 cuando falta SELECT en categories.orden y falla la lectura comercial que ordena por esa columna', async () => {
        const moduleFixture = await Test.createTestingModule({
          imports: [TaxonomySvcModule],
        })
          .overrideProvider(TAXONOMY_REPOSITORY)
          .useValue(repoRuntime)
          .compile();
        const appRuntime: INestApplication<App> =
          moduleFixture.createNestApplication();
        await appRuntime.init();

        await admin.query(
          `REVOKE SELECT ON taxonomy.categories FROM ${ROL_APP}`,
        );
        await admin.query(
          `GRANT SELECT (id, nombre, categoria_padre_id, estado) ON taxonomy.categories TO ${ROL_APP}`,
        );
        try {
          await expect(repoRuntime.findCategoriasActivas()).rejects.toThrow();
          await request(appRuntime.getHttpServer())
            .get('/health/readiness')
            .expect(HttpStatus.SERVICE_UNAVAILABLE);
        } finally {
          await admin.query(
            `REVOKE SELECT (id, nombre, categoria_padre_id, estado) ON taxonomy.categories FROM ${ROL_APP}`,
          );
          await admin.query(
            `GRANT SELECT ON taxonomy.categories TO ${ROL_APP}`,
          );
          await appRuntime.close();
        }
      });
    });
  },
);
