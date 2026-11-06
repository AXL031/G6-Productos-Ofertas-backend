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
  TaxonomyUserGuard,
  TaxonomyTokenVerifier,
  TAXONOMY_SECURITY_CONFIG,
} from '../src/taxonomy-auth.js';
import { TaxonomyAdminQueryController } from '../src/taxonomy-admin-query.controller.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { vi } from 'vitest';
import { Database } from '../src/database.js';
import {
  bloquearFuenteBaja,
  transicionarFuenteBaja,
} from '../src/persistence/deactivation-source.js';
import { DeactivationCheckService } from '../src/domain/deactivation-check.service.js';
import { DeactivationIntentService } from '../src/domain/deactivation-intent.service.js';
import { BrandReactivationService } from '../src/domain/brand-reactivation.service.js';
import { CategoryReactivationService } from '../src/domain/category-reactivation.service.js';
import { CategoryCreateService } from '../src/domain/category-create.service.js';
import { CategoryUpdateService } from '../src/domain/category-update.service.js';
import { CharacteristicValueService } from '../src/domain/characteristic-value.service.js';
import { ProductTypeService } from '../src/domain/product-type.service.js';
import { ProductTypeCharacteristicService } from '../src/domain/product-type-characteristic.service.js';
import {
  TaxonomyMessageStore,
  parseChecked,
} from '../src/persistence/taxonomy-message.store.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import { TaxonomyAmqpRuntime } from '../src/domain/taxonomy-amqp.runtime.js';
import { RabbitTaxonomyDesechable } from './rabbitmq-desechable.js';
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
  caracteristicas,
  valoresCaracteristica,
  tiposProducto,
  asociacionesTipoCaracteristica,
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
      await admin.query(
        readFileSync(
          resolve(
            'apps/taxonomy-svc/migrations/0005_configurable_list_values.sql',
          ),
          'utf8',
        ),
      );
      for (const sentencia of construirSentenciasSemilla()) {
        await admin.query(sentencia);
      }
      app = new Pool({ connectionString: urlApp });
      dbApp = drizzle(app, { schema: esquemaTaxonomia });
      repo = crearRepositorioDrizzle(urlApp);
    });

    it.each([
      'PRODUCT_TYPE',
      'CHARACTERISTIC_VALUE',
      'PRODUCT_TYPE_CHARACTERISTIC',
    ] as const)(
      'admite %s, rechaza IN_USE y completa CLEAR en una transacción aislada',
      async (entityType) => {
        const nombre = `baja-${randomUUID()}`;
        try {
          await expect(
            drizzle(admin, { schema: esquemaTaxonomia }).transaction(
              async (tx) => {
                await tx.execute(
                  sql.raw(
                    readFileSync(
                      resolve(
                        'apps/taxonomy-svc/migrations/0002_deactivation_source_version.sql',
                      ),
                      'utf8',
                    ),
                  ),
                );
                await tx.execute(
                  sql.raw(
                    readFileSync(
                      resolve(
                        'apps/taxonomy-svc/migrations/0004_product_type_pending_version.sql',
                      ),
                      'utf8',
                    ),
                  ),
                );
                const [tipo] = await tx
                  .insert(tiposProducto)
                  .values({ nombre })
                  .returning();
                const [caracteristica] = await tx
                  .insert(caracteristicas)
                  .values({ nombre, tipo: 'LISTA' })
                  .returning();
                if (!tipo || !caracteristica) throw new Error('DATOS_AUSENTES');
                const [valor] = await tx
                  .insert(valoresCaracteristica)
                  .values({ caracteristicaId: caracteristica.id, nombre })
                  .returning();
                const [asociacion] = await tx
                  .insert(asociacionesTipoCaracteristica)
                  .values({
                    tipoProductoId: tipo.id,
                    caracteristicaId: caracteristica.id,
                  })
                  .returning();
                if (!valor || !asociacion) throw new Error('DATOS_AUSENTES');
                const database = new Database();
                vi.spyOn(database, 'read').mockImplementation(async (query) =>
                  query(tx as unknown as NodePgDatabase),
                );
                const servicio = new DeactivationIntentService(database);
                const entidadId =
                  entityType === 'PRODUCT_TYPE'
                    ? tipo.id
                    : entityType === 'CHARACTERISTIC_VALUE'
                      ? valor.id
                      : asociacion.id;
                const identidad = {
                  operationId: randomUUID(),
                  correlationId: randomUUID(),
                  entityType,
                  entityId: entidadId,
                  version: entityType === 'PRODUCT_TYPE_CHARACTERISTIC' ? 2 : 0,
                  ...(entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
                    ? {
                        tipoProductoId: tipo.id,
                        caracteristicaId: caracteristica.id,
                      }
                    : {}),
                };
                await expect(servicio.registrar(identidad)).resolves.toBe(
                  'REGISTRADA',
                );
                await expect(servicio.registrar(identidad)).resolves.toBe(
                  'REINTENTO',
                );
                const store = new TaxonomyMessageStore(database, servicio);
                const solicitud = await tx.execute(
                  sql`SELECT message_id FROM taxonomy.outbox WHERE operation_id = ${identidad.operationId}::uuid AND event_name = 'taxonomy.master.deactivation.check.requested'`,
                );
                const causationId = String(solicitud.rows[0]?.message_id);
                const respuesta = (
                  operationId: string,
                  messageId: string,
                  causation: string,
                  result: 'CLEAR' | 'IN_USE',
                  version: number,
                ) =>
                  parseChecked({
                    message_id: messageId,
                    operation_id: operationId,
                    correlation_id: identidad.correlationId,
                    causation_id: causation,
                    schema_version: 1,
                    occurred_at: new Date().toISOString(),
                    producer: 'catalog-svc',
                    kind: 'result',
                    name: 'catalog.master.deactivation.checked',
                    data: {
                      entity_type: entityType,
                      entity_id: entidadId,
                      version,
                      result,
                      ...(entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
                        ? {
                            tipo_producto_id: tipo.id,
                            caracteristica_id: caracteristica.id,
                          }
                        : {}),
                    },
                  });
                if (entityType === 'PRODUCT_TYPE_CHARACTERISTIC') {
                  await expect(
                    servicio.registrar({
                      ...identidad,
                      caracteristicaId: randomUUID(),
                    }),
                  ).resolves.toBe('CONFLICTO');
                }
                const obsoleta = respuesta(
                  identidad.operationId,
                  randomUUID(),
                  causationId,
                  'CLEAR',
                  identidad.version + 1,
                );
                await store.consumir(obsoleta);
                const sinUso = await tx.execute(
                  sql`SELECT result FROM taxonomy.inbox WHERE message_id = ${obsoleta.message_id}::uuid`,
                );
                expect(sinUso.rows).toEqual([{ result: 'IGNORED' }]);
                const enUso = respuesta(
                  identidad.operationId,
                  randomUUID(),
                  causationId,
                  'IN_USE',
                  identidad.version,
                );
                await store.consumir(enUso);
                await store.consumir(enUso);
                const rechazo = await tx.execute(
                  sql`SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id = ${identidad.operationId}::uuid`,
                );
                expect(rechazo.rows).toEqual([{ status: 'REJECTED' }]);
                const segunda = { ...identidad, operationId: randomUUID() };
                await expect(servicio.registrar(segunda)).resolves.toBe(
                  'REGISTRADA',
                );
                await tx.execute(
                  sql`UPDATE taxonomy.master_deactivation_operations SET created_at = statement_timestamp() - interval '61 seconds' WHERE operation_id = ${segunda.operationId}::uuid`,
                );
                await expect(servicio.recuperarVencidas()).resolves.toBe(1);
                const vencida = await tx.execute(
                  sql`SELECT status, reason FROM taxonomy.master_deactivation_operations WHERE operation_id = ${segunda.operationId}::uuid`,
                );
                expect(vencida.rows).toEqual([
                  { status: 'FAILED', reason: 'TECHNICAL_FAILURE' },
                ]);
                const tercera = { ...identidad, operationId: randomUUID() };
                await expect(servicio.registrar(tercera)).resolves.toBe(
                  'REGISTRADA',
                );
                const solicitudTercera = await tx.execute(
                  sql`SELECT message_id FROM taxonomy.outbox WHERE operation_id = ${tercera.operationId}::uuid AND event_name = 'taxonomy.master.deactivation.check.requested'`,
                );
                const clear = respuesta(
                  tercera.operationId,
                  randomUUID(),
                  String(solicitudTercera.rows[0]?.message_id),
                  'CLEAR',
                  identidad.version,
                );
                await store.consumir(clear);
                await store.consumir(clear);
                const completada = await tx.execute(
                  sql`SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id = ${tercera.operationId}::uuid`,
                );
                expect(completada.rows).toEqual([{ status: 'COMPLETED' }]);
                const inbox = await tx.execute(
                  sql`SELECT count(*)::int AS total FROM taxonomy.inbox WHERE message_id = ${clear.message_id}::uuid AND result = 'PROCESSED'`,
                );
                expect(inbox.rows).toEqual([{ total: 1 }]);
                const eventos = await tx.execute(
                  sql`SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id=${tercera.operationId}::uuid AND event_name='taxonomy.master.deactivated'`,
                );
                expect(eventos.rows).toEqual([{ n: 1 }]);
                if (entityType === 'PRODUCT_TYPE_CHARACTERISTIC') {
                  const terminal = await tx.execute(
                    sql`SELECT payload->'data' AS data FROM taxonomy.outbox WHERE operation_id=${tercera.operationId}::uuid AND event_name='taxonomy.master.deactivated'`,
                  );
                  expect(terminal.rows).toEqual([
                    {
                      data: expect.objectContaining({
                        version: 2,
                        schema_version_resultante: 3,
                      }),
                    },
                  ]);
                  const cambio = await tx.execute(
                    sql`SELECT payload->'data' AS data FROM taxonomy.outbox WHERE operation_id=${tercera.operationId}::uuid AND event_name='taxonomy.product-type-schema.changed'`,
                  );
                  expect(cambio.rows).toEqual([
                    {
                      data: expect.objectContaining({
                        tipo_producto_id: tipo.id,
                        caracteristica_id: caracteristica.id,
                        schema_version: 3,
                        change_type: 'CHARACTERISTIC_DISASSOCIATED',
                      }),
                    },
                  ]);
                }
                throw new Error('ROLLBACK_BAJA');
              },
            ),
          ).rejects.toThrow('ROLLBACK_BAJA');
        } finally {
          vi.restoreAllMocks();
        }
      },
    );

    it('crea y consulta valores y asociaciones con la versión del tipo', async () => {
      const nombre = `maestros-${randomUUID()}`;
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const caracteristica = (
        await admin.query(
          "INSERT INTO taxonomy.characteristics (nombre, tipo) VALUES ($1, 'LISTA') RETURNING id",
          [nombre],
        )
      ).rows[0].id as string;
      const tipo = (
        await admin.query(
          'INSERT INTO taxonomy.product_types (nombre) VALUES ($1) RETURNING id',
          [nombre],
        )
      ).rows[0].id as string;
      try {
        const valores = new CharacteristicValueService(database);
        const creado = await valores.crear(caracteristica, 'Rojo');
        expect(creado).toMatchObject({
          estado: 'OK',
          valor: { nombre: 'Rojo', estado: 'ACTIVO', version: 0 },
        });
        if (creado.estado !== 'OK') throw new Error('Valor ausente');
        await admin.query(`REVOKE INSERT ON taxonomy.outbox FROM ${ROL_APP}`);
        try {
          await expect(
            valores.actualizar(caracteristica, creado.valor.valorId, 'Azul', 0),
          ).rejects.toThrow();
          expect(
            (
              await admin.query(
                'SELECT nombre, taxonomy_version FROM taxonomy.characteristic_values WHERE id=$1',
                [creado.valor.valorId],
              )
            ).rows,
          ).toEqual([{ nombre: 'Rojo', taxonomy_version: '0' }]);
        } finally {
          await admin.query(`GRANT INSERT ON taxonomy.outbox TO ${ROL_APP}`);
        }
        expect(
          await valores.actualizar(
            caracteristica,
            creado.valor.valorId,
            'Azul',
            0,
          ),
        ).toMatchObject({
          estado: 'OK',
          valor: { nombre: 'Azul', version: 1 },
        });
        expect(
          (
            await admin.query(
              "SELECT payload->'data' AS data FROM taxonomy.outbox WHERE event_name='taxonomy.characteristic-value.updated' AND payload->'data'->>'valor_id'=$1",
              [creado.valor.valorId],
            )
          ).rows,
        ).toEqual([
          {
            data: expect.objectContaining({
              caracteristica_id: caracteristica,
              valor_id: creado.valor.valorId,
              nombre: 'Azul',
              change_type: 'RENAMED',
            }),
          },
        ]);
        expect(await valores.listar(caracteristica)).toHaveLength(1);
        const asociaciones = new ProductTypeCharacteristicService(database);
        expect(await asociaciones.crear(tipo, caracteristica, true, 0)).toEqual(
          { estado: 'VERSION_CONFLICT' },
        );
        expect(await asociaciones.crear(tipo, caracteristica, true, 1)).toEqual(
          {
            estado: 'OK',
            asociacion: {
              caracteristicaId: caracteristica,
              obligatoria: true,
              estado: 'ACTIVO',
              schemaVersion: 2,
            },
          },
        );
        expect(await asociaciones.listar(tipo)).toHaveLength(1);
        expect(
          await new ProductTypeService(database).obtenerEsquema(tipo),
        ).toMatchObject({
          schemaVersion: 2,
          caracteristicas: [
            {
              caracteristicaId: caracteristica,
              schemaVersion: 2,
              caracteristica: {
                caracteristicaId: caracteristica,
                tipo: 'LISTA',
                estado: 'ACTIVO',
                valores: [{ valorId: creado.valor.valorId, nombre: 'Azul' }],
              },
            },
          ],
        });
        expect(
          (
            await admin.query(
              "SELECT payload->'data' AS data FROM taxonomy.outbox WHERE event_name='taxonomy.product-type-schema.changed' AND payload->'data'->>'tipo_producto_id'=$1",
              [tipo],
            )
          ).rows,
        ).toEqual([
          {
            data: expect.objectContaining({
              tipo_producto_id: tipo,
              caracteristica_id: caracteristica,
              schema_version: 2,
              change_type: 'CHARACTERISTIC_ASSOCIATED',
            }),
          },
        ]);
        expect(
          await asociaciones.actualizar(tipo, caracteristica, false, 1),
        ).toEqual({ estado: 'VERSION_CONFLICT' });
        await admin.query(`REVOKE INSERT ON taxonomy.outbox FROM ${ROL_APP}`);
        try {
          await expect(
            asociaciones.actualizar(tipo, caracteristica, false, 2),
          ).rejects.toThrow();
          expect(
            (
              await admin.query(
                'SELECT a.obligatoria,t.schema_version FROM taxonomy.product_type_characteristics a JOIN taxonomy.product_types t ON t.id=a.tipo_producto_id WHERE a.tipo_producto_id=$1 AND a.caracteristica_id=$2',
                [tipo, caracteristica],
              )
            ).rows,
          ).toEqual([{ obligatoria: true, schema_version: '2' }]);
        } finally {
          await admin.query(`GRANT INSERT ON taxonomy.outbox TO ${ROL_APP}`);
        }
        expect(
          await asociaciones.actualizar(tipo, caracteristica, false, 2),
        ).toMatchObject({
          estado: 'OK',
          asociacion: { obligatoria: false, schemaVersion: 3 },
        });
        expect(
          (
            await admin.query(
              "SELECT payload->'data' AS data FROM taxonomy.outbox WHERE event_name='taxonomy.product-type-schema.changed' AND payload->'data'->>'tipo_producto_id'=$1 AND payload->'data'->>'change_type'='REQUIRED_CHANGED'",
              [tipo],
            )
          ).rows,
        ).toEqual([
          {
            data: expect.objectContaining({
              tipo_producto_id: tipo,
              caracteristica_id: caracteristica,
              schema_version: 3,
            }),
          },
        ]);
        const simultaneas = await Promise.all([
          asociaciones.actualizar(tipo, caracteristica, true, 3),
          asociaciones.actualizar(tipo, caracteristica, true, 3),
        ]);
        expect(simultaneas.map((r) => r.estado).sort()).toEqual([
          'OK',
          'VERSION_CONFLICT',
        ]);
      } finally {
        await admin.query(`GRANT INSERT ON taxonomy.outbox TO ${ROL_APP}`);
        await admin.query(
          "DELETE FROM taxonomy.outbox WHERE event_name='taxonomy.characteristic-value.updated' AND payload->'data'->>'caracteristica_id'=$1",
          [caracteristica],
        );
        await admin.query(
          "DELETE FROM taxonomy.outbox WHERE event_name='taxonomy.product-type-schema.changed' AND payload->'data'->>'tipo_producto_id'=$1",
          [tipo],
        );
        await admin.query(
          'DELETE FROM taxonomy.product_type_characteristics WHERE tipo_producto_id = $1',
          [tipo],
        );
        await admin.query(
          'DELETE FROM taxonomy.characteristic_values WHERE caracteristica_id = $1',
          [caracteristica],
        );
        await admin.query('DELETE FROM taxonomy.product_types WHERE id = $1', [
          tipo,
        ]);
        await admin.query(
          'DELETE FROM taxonomy.characteristics WHERE id = $1',
          [caracteristica],
        );
        vi.restoreAllMocks();
      }
    });

    it('aplica el límite configurable en servicio y trigger físico', async () => {
      const nombre = `limite-config-${randomUUID()}`;
      const caracteristica = (
        await admin.query(
          "INSERT INTO taxonomy.characteristics (nombre, tipo) VALUES ($1, 'LISTA') RETURNING id",
          [nombre],
        )
      ).rows[0].id;
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      try {
        await admin.query(
          "UPDATE taxonomy.runtime_settings SET valor_integer=1 WHERE clave='MAX_ACTIVE_LIST_VALUES'",
        );
        const service = new CharacteristicValueService(database);
        expect(await service.crear(caracteristica, 'Primero')).toMatchObject({
          estado: 'OK',
        });
        expect(await service.crear(caracteristica, 'Segundo')).toEqual({
          estado: 'LIMITE',
        });
        await expect(
          admin.query(
            "INSERT INTO taxonomy.characteristic_values (caracteristica_id,nombre) VALUES ($1,'Directo')",
            [caracteristica],
          ),
        ).rejects.toThrow(/límite/i);
      } finally {
        await admin.query(
          "UPDATE taxonomy.runtime_settings SET valor_integer=50 WHERE clave='MAX_ACTIVE_LIST_VALUES'",
        );
        await admin.query(
          'DELETE FROM taxonomy.characteristic_values WHERE caracteristica_id=$1',
          [caracteristica],
        );
        await admin.query('DELETE FROM taxonomy.characteristics WHERE id=$1', [
          caracteristica,
        ]);
        vi.restoreAllMocks();
      }
    });

    it('serializa renombrados concurrentes de un valor por versión', async () => {
      const nombre = `concurrencia-valor-${randomUUID()}`;
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const caracteristica = (
        await admin.query(
          "INSERT INTO taxonomy.characteristics (nombre, tipo) VALUES ($1, 'LISTA') RETURNING id",
          [nombre],
        )
      ).rows[0].id;
      const valor = (
        await admin.query(
          "INSERT INTO taxonomy.characteristic_values (caracteristica_id, nombre) VALUES ($1, 'Inicial') RETURNING id",
          [caracteristica],
        )
      ).rows[0].id;
      try {
        const servicio = new CharacteristicValueService(database);
        const resultados = await Promise.all([
          servicio.actualizar(caracteristica, valor, 'Primero', 0),
          servicio.actualizar(caracteristica, valor, 'Segundo', 0),
        ]);
        expect(resultados.map((r) => r.estado).sort()).toEqual([
          'OK',
          'VERSION_CONFLICT',
        ]);
        expect(
          (
            await admin.query(
              'SELECT taxonomy_version FROM taxonomy.characteristic_values WHERE id=$1',
              [valor],
            )
          ).rows[0].taxonomy_version,
        ).toBe('1');
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS total FROM taxonomy.outbox WHERE event_name='taxonomy.characteristic-value.updated' AND payload->'data'->>'valor_id'=$1",
              [valor],
            )
          ).rows[0].total,
        ).toBe(1);
      } finally {
        await admin.query(
          "DELETE FROM taxonomy.outbox WHERE event_name='taxonomy.characteristic-value.updated' AND payload->'data'->>'valor_id'=$1",
          [valor],
        );
        await admin.query(
          'DELETE FROM taxonomy.characteristic_values WHERE id=$1',
          [valor],
        );
        await admin.query('DELETE FROM taxonomy.characteristics WHERE id=$1', [
          caracteristica,
        ]);
        vi.restoreAllMocks();
      }
    });

    it('mantiene inmutable el tipo de una característica en PostgreSQL', async () => {
      const nombre = `inmutable-${randomUUID()}`;
      const creado = await admin.query(
        "INSERT INTO taxonomy.characteristics (nombre, tipo) VALUES ($1, 'LISTA') RETURNING id",
        [nombre],
      );
      try {
        await expect(
          admin.query(
            "UPDATE taxonomy.characteristics SET tipo = 'TEXTO' WHERE id = $1",
            [creado.rows[0].id],
          ),
        ).rejects.toThrow(/inmutable/i);
        const actual = await admin.query(
          'SELECT tipo FROM taxonomy.characteristics WHERE id = $1',
          [creado.rows[0].id],
        );
        expect(actual.rows[0].tipo).toBe('LISTA');
      } finally {
        await admin.query(
          'DELETE FROM taxonomy.characteristics WHERE id = $1',
          [creado.rows[0].id],
        );
      }
    });

    it('evidencia el incremento histórico de schema_version al admitir una baja de asociación', async () => {
      const nombre = `trigger-${randomUUID()}`;
      await expect(
        drizzle(admin, { schema: esquemaTaxonomia }).transaction(async (tx) => {
          const [caracteristica] = await tx
            .insert(caracteristicas)
            .values({ nombre, tipo: 'LISTA' })
            .returning();
          const [tipo] = await tx
            .insert(tiposProducto)
            .values({ nombre })
            .returning();
          if (!caracteristica || !tipo) throw new Error('Datos ausentes');
          const [asociacion] = await tx
            .insert(asociacionesTipoCaracteristica)
            .values({
              tipoProductoId: tipo.id,
              caracteristicaId: caracteristica.id,
            })
            .returning();
          if (!asociacion) throw new Error('Asociación ausente');
          const antes = await tx.execute(
            sql`SELECT schema_version FROM taxonomy.product_types WHERE id = ${tipo.id}::uuid`,
          );
          await tx.execute(
            sql`UPDATE taxonomy.product_type_characteristics SET estado = 'PENDING_DEACTIVATION' WHERE id = ${asociacion.id}::uuid`,
          );
          const despues = await tx.execute(
            sql`SELECT schema_version FROM taxonomy.product_types WHERE id = ${tipo.id}::uuid`,
          );
          expect(Number(despues.rows[0]?.schema_version)).toBe(
            Number(antes.rows[0]?.schema_version) + 1,
          );
          await tx.execute(
            sql.raw(
              readFileSync(
                resolve(
                  'apps/taxonomy-svc/migrations/0004_product_type_pending_version.sql',
                ),
                'utf8',
              ),
            ),
          );
          const version = Number(despues.rows[0]?.schema_version);
          expect(
            await transicionarFuenteBaja(
              tx,
              'PRODUCT_TYPE_CHARACTERISTIC',
              asociacion.id,
              version - 1,
              'PENDING_DEACTIVATION',
              'ACTIVO',
            ),
          ).toBe(false);
          expect(
            await transicionarFuenteBaja(
              tx,
              'PRODUCT_TYPE_CHARACTERISTIC',
              asociacion.id,
              version,
              'PENDING_DEACTIVATION',
              'ACTIVO',
            ),
          ).toBe(true);
          expect(
            await transicionarFuenteBaja(
              tx,
              'PRODUCT_TYPE_CHARACTERISTIC',
              asociacion.id,
              version,
              'ACTIVO',
              'PENDING_DEACTIVATION',
            ),
          ).toBe(true);
          const admitida = await tx.execute(
            sql`SELECT schema_version FROM taxonomy.product_types WHERE id = ${tipo.id}::uuid`,
          );
          expect(Number(admitida.rows[0]?.schema_version)).toBe(
            Number(despues.rows[0]?.schema_version),
          );
          expect(
            await transicionarFuenteBaja(
              tx,
              'PRODUCT_TYPE_CHARACTERISTIC',
              asociacion.id,
              version,
              'PENDING_DEACTIVATION',
              'INACTIVO',
            ),
          ).toBe(true);
          const confirmada = await tx.execute(
            sql`SELECT schema_version FROM taxonomy.product_types WHERE id = ${tipo.id}::uuid`,
          );
          expect(Number(confirmada.rows[0]?.schema_version)).toBe(
            Number(admitida.rows[0]?.schema_version) + 1,
          );
          await tx.execute(
            sql`UPDATE taxonomy.product_type_characteristics SET obligatoria = true WHERE id = ${asociacion.id}::uuid`,
          );
          const editada = await tx.execute(
            sql`SELECT schema_version FROM taxonomy.product_types WHERE id = ${tipo.id}::uuid`,
          );
          expect(Number(editada.rows[0]?.schema_version)).toBe(
            Number(confirmada.rows[0]?.schema_version) + 1,
          );
          throw new Error('ROLLBACK_TRIGGER');
        }),
      ).rejects.toThrow('ROLLBACK_TRIGGER');
    });

    it('mapea las tres entidades y revierte sus escrituras en PostgreSQL aislado', async () => {
      const nombre = `test-${randomUUID()}`;
      await expect(
        dbApp.transaction(async (tx) => {
          const [caracteristica] = await tx
            .insert(caracteristicas)
            .values({ nombre, tipo: 'LISTA' })
            .returning();
          if (!caracteristica) throw new Error('Característica ausente');
          const [tipo] = await tx
            .insert(tiposProducto)
            .values({ nombre })
            .returning();
          if (!tipo) throw new Error('Tipo ausente');
          const [valor] = await tx
            .insert(valoresCaracteristica)
            .values({ nombre, caracteristicaId: caracteristica.id })
            .returning();
          const [asociacion] = await tx
            .insert(asociacionesTipoCaracteristica)
            .values({
              tipoProductoId: tipo.id,
              caracteristicaId: caracteristica.id,
            })
            .returning();
          expect(valor?.taxonomyVersion).toBe(0);
          expect(tipo.schemaVersion).toBe(1);
          expect(asociacion?.estado).toBe('ACTIVO');
          if (!valor || !asociacion) throw new Error('Entidades ausentes');
          expect(
            await bloquearFuenteBaja(tx, 'PRODUCT_TYPE', tipo.id),
          ).toMatchObject({ id: tipo.id, version: 0, estado: 'ACTIVO' });
          expect(
            await bloquearFuenteBaja(tx, 'CHARACTERISTIC_VALUE', valor.id),
          ).toMatchObject({ id: valor.id, version: 0, estado: 'ACTIVO' });
          expect(
            await bloquearFuenteBaja(
              tx,
              'PRODUCT_TYPE_CHARACTERISTIC',
              asociacion.id,
            ),
          ).toMatchObject({
            id: asociacion.id,
            version: 2,
            estado: 'ACTIVO',
            tipoProductoId: tipo.id,
            caracteristicaId: caracteristica.id,
          });
          throw new Error('ROLLBACK_AISLADO');
        }),
      ).rejects.toThrow('ROLLBACK_AISLADO');
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS n FROM taxonomy.product_types WHERE nombre = $1',
            [nombre],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS n FROM taxonomy.characteristics WHERE nombre = $1',
            [nombre],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    });

    it('aplica los límites oficiales de valores y asociaciones en PostgreSQL', async () => {
      const nombre = `limites-${randomUUID()}`;
      await expect(
        dbApp.transaction(async (tx) => {
          const [caracteristica] = await tx
            .insert(caracteristicas)
            .values({ nombre, tipo: 'LISTA' })
            .returning();
          if (!caracteristica) throw new Error('Característica ausente');
          await tx.execute(sql`INSERT INTO taxonomy.characteristic_values (caracteristica_id, nombre)
            SELECT ${caracteristica.id}::uuid, 'valor-' || n FROM generate_series(1, 50) n`);
          await tx.insert(valoresCaracteristica).values({
            caracteristicaId: caracteristica.id,
            nombre: 'valor-excedente',
          });
        }),
      ).rejects.toThrow();
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS n FROM taxonomy.characteristics WHERE nombre = $1',
            [nombre],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);

      await expect(
        dbApp.transaction(async (tx) => {
          const [tipo] = await tx
            .insert(tiposProducto)
            .values({ nombre })
            .returning();
          if (!tipo) throw new Error('Tipo ausente');
          await tx.execute(sql`INSERT INTO taxonomy.characteristics (nombre, tipo)
            SELECT ${nombre} || '-' || n, 'LISTA' FROM generate_series(1, 21) n`);
          await tx.execute(sql`INSERT INTO taxonomy.product_type_characteristics (tipo_producto_id, caracteristica_id)
            SELECT ${tipo.id}::uuid, id FROM taxonomy.characteristics WHERE nombre LIKE ${nombre + '-%'} ORDER BY nombre LIMIT 20`);
          const [extra] = await tx
            .execute(
              sql`SELECT id FROM taxonomy.characteristics
            WHERE nombre LIKE ${nombre + '-%'} AND id NOT IN (SELECT caracteristica_id FROM taxonomy.product_type_characteristics WHERE tipo_producto_id = ${tipo.id}::uuid)`,
            )
            .then((result) => result.rows);
          if (!extra || typeof extra.id !== 'string')
            throw new Error('Característica adicional ausente');
          await tx
            .insert(asociacionesTipoCaracteristica)
            .values({ tipoProductoId: tipo.id, caracteristicaId: extra.id });
        }),
      ).rejects.toThrow();
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS n FROM taxonomy.product_types WHERE nombre = $1',
            [nombre],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
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

    // contract-test: 'listarCategorias'
    // contract-test: 'listarMarcas'
    // contract-test: 'obtenerCategoriaAdmin'
    // contract-test: 'crearCategoria'
    // contract-test: 'actualizarCategoria'
    // contract-test: 'reactivarCategoria'
    // contract-test: 'crearMarca'
    // contract-test: 'actualizarMarca'
    // contract-test: 'reactivarMarca'
    // contract-test: 'listarTiposProducto'
    // contract-test: 'crearTipoProducto'
    // contract-test: 'obtenerTipoProducto'
    // contract-test: 'listarValoresCaracteristica'
    // contract-test: 'crearValorCaracteristica'
    // contract-test: 'actualizarValorCaracteristica'
    // contract-test: 'obtenerEsquemaTipoProducto'
    // contract-test: 'asociarCaracteristicaTipoProducto'
    // contract-test: 'actualizarAsociacionTipoCaracteristica'
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
      const token = (
        scope: string,
        humano = false,
        roles = ['GESTOR_COMERCIAL'],
        cliente = 'modulo-productos',
        audience: string | null = 'api-productos',
        invalidSignature = false,
      ) => {
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(
          JSON.stringify({ alg: 'RS256', kid: 'test' }),
        ).toString('base64url');
        const payload = Buffer.from(
          JSON.stringify({
            iss: issuer,
            sub: humano ? randomUUID() : cliente,
            tipo: humano ? 'acceso' : 'servicio',
            ...(humano ? { roles } : {}),
            ...(audience === null ? {} : { aud: audience }),
            scope,
            iat: now,
            exp: now + 60,
            jti: randomUUID(),
          }),
        ).toString('base64url');
        const input = `${header}.${payload}`;
        const signingKey = invalidSignature
          ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
          : keys.privateKey;
        return `${input}.${sign('RSA-SHA256', Buffer.from(input), signingKey).toString('base64url')}`;
      };
      let nest: INestApplication<App> | undefined;
      const brandId = randomUUID();
      let nuevaMarca: string | undefined;
      let marcaConUrl: string | undefined;
      let categoryCreated: string | undefined;
      let categoriaAdminId: string | undefined;
      let tipoCreado: string | undefined;
      let caracteristicaCreada: string | undefined;
      let caracteristicaHttpCreada: string | undefined;
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
        const categoriaAdminToken = token('catalogo:leer');
        const guardContext = {
          switchToHttp: () => ({
            getRequest: () => ({
              method: 'GET',
              headers: { authorization: `Bearer ${categoriaAdminToken}` },
            }),
          }),
          getHandler: () =>
            TaxonomyAdminQueryController.prototype.obtenerCategoriaAdmin,
        } as unknown as import('@nestjs/common').ExecutionContext;
        await expect(
          nest.get(TaxonomyTokenVerifier).verify(categoriaAdminToken),
        ).resolves.toMatchObject({
          kind: 'service',
          subject: 'modulo-productos',
          scopes: ['catalogo:leer'],
          audiences: ['api-productos'],
        });
        await expect(
          nest.get(TaxonomyUserGuard).canActivate(guardContext),
        ).resolves.toBe(true);
        categoriaAdminId = randomUUID();
        await admin.query(
          "INSERT INTO taxonomy.categories (id, nombre, descripcion, nivel, orden, imagen_url, estado, taxonomy_version) VALUES ($1, 'Categoria HTTP Admin', 'Persistida', 1, 4, 'https://cdn.example.test/categoria.webp', 'ACTIVO', 9)",
          [categoriaAdminId],
        );
        await admin.query(
          'INSERT INTO taxonomy.category_seo (categoria_id, slug) VALUES ($1, $2)',
          [categoriaAdminId, `categoria-http-${categoriaAdminId}`],
        );
        const adminCategoriaResponse = await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${categoriaAdminId}`)
          .set('Authorization', `Bearer ${token('catalogo:leer')}`)
          .set('X-Correlation-Id', randomUUID());
        if (adminCategoriaResponse.status !== 200)
          throw new Error(
            `obtenerCategoriaAdmin status=${adminCategoriaResponse.status} body=${JSON.stringify(adminCategoriaResponse.body)}`,
          );
        const adminCategoria = adminCategoriaResponse;
        expect(adminCategoria.body).toEqual({
          categoriaId: categoriaAdminId,
          nombre: 'Categoria HTTP Admin',
          descripcion: 'Persistida',
          categoriaPadreId: null,
          orden: 4,
          imagenUrl: 'https://cdn.example.test/categoria.webp',
          estado: 'ACTIVO',
          version: 9,
          slug: `categoria-http-${categoriaAdminId}`,
        });
        await admin.query(
          "UPDATE taxonomy.categories SET estado = 'PENDING_DEACTIVATION' WHERE id = $1",
          [categoriaAdminId],
        );
        const pendiente = await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${categoriaAdminId}`)
          .set('Authorization', `Bearer ${token('catalogo:leer')}`)
          .expect(503);
        expect(pendiente.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(pendiente.body.code).toBe('SERVICIO_NO_DISPONIBLE');
        expect(JSON.stringify(pendiente.body)).not.toContain(
          'PENDING_DEACTIVATION',
        );
        expect(JSON.stringify(pendiente.body)).not.toContain('taxonomy.');
        await admin.query(
          "UPDATE taxonomy.categories SET estado = 'ACTIVO' WHERE id = $1",
          [categoriaAdminId],
        );
        const categoriaAusente = await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${randomUUID()}`)
          .set('Authorization', `Bearer ${token('catalogo:leer')}`)
          .expect(404);
        expect(categoriaAusente.body.code).toBe('CATEGORIA_NO_ENCONTRADA');
        await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${categoriaAdminId}`)
          .expect(401);
        await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${categoriaAdminId}`)
          .set(
            'Authorization',
            `Bearer ${token('catalogo:leer', false, [], 'modulo-productos', 'api-productos', true)}`,
          )
          .expect(401);
        await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${categoriaAdminId}`)
          .set(
            'Authorization',
            `Bearer ${token('catalogo:leer', false, [], 'modulo-productos', 'audiencia-incorrecta')}`,
          )
          .expect(401);
        await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${categoriaAdminId}`)
          .set('Authorization', `Bearer ${token('otro:leer')}`)
          .expect(403);
        await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${categoriaAdminId}`)
          .set(
            'Authorization',
            `Bearer ${token('catalogo:leer', false, [], 'otro-cliente')}`,
          )
          .expect(403);
        await request(nest.getHttpServer())
          .get('/api/v1/categorias')
          .set('Authorization', `Bearer ${token('catalogo:leer')}`)
          .expect(403);
        await request(nest.getHttpServer())
          .post('/api/v1/categorias')
          .set('Authorization', `Bearer ${token('catalogo:leer')}`)
          .send({ nombre: 'No autorizada' })
          .expect(403);
        await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${categoriaAdminId}`)
          .set('Authorization', `Bearer ${token('', true, [])}`)
          .expect(403);
        await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${categoriaAdminId}`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        await request(nest.getHttpServer())
          .get('/api/v1/categorias/no-uuid')
          .set('Authorization', `Bearer ${token('catalogo:leer')}`)
          .expect(400);

        const writeRoutes = [
          { method: 'patch', path: `/api/v1/categorias/${categoriaAdminId}` },
          { method: 'post', path: '/api/v1/marcas' },
          { method: 'patch', path: `/api/v1/marcas/${brandId}` },
          { method: 'post', path: '/api/v1/categorias' },
          { method: 'post', path: `/api/v1/marcas/${brandId}/reactivar` },
          {
            method: 'post',
            path: `/api/v1/categorias/${categoriaAdminId}/reactivar`,
          },
        ] as const;
        for (const route of writeRoutes) {
          await request(nest.getHttpServer())
            [route.method](route.path)
            .set('Authorization', `Bearer ${token('', true, [])}`)
            .expect(403);
          await request(nest.getHttpServer())
            [route.method](route.path)
            .set('Authorization', `Bearer ${token('catalogo:leer')}`)
            .expect(403);
          await request(nest.getHttpServer())
            [route.method](route.path)
            .set(
              'Authorization',
              `Bearer ${token('', true, ['GESTOR_COMERCIAL'], 'modulo-productos', 'audiencia-incorrecta', true)}`,
            )
            .expect(401);
          await request(nest.getHttpServer())
            [route.method](route.path)
            .expect(401);
        }
        await request(nest.getHttpServer())
          .get('/api/v1/tipos-producto')
          .set('Authorization', `Bearer ${token('catalogo:leer')}`)
          .expect(200);
        await request(nest.getHttpServer())
          .get('/api/v1/tipos-producto')
          .set(
            'Authorization',
            `Bearer ${token('catalogo:leer', false, [], 'modulo-productos', null)}`,
          )
          .expect(401);
        await request(nest.getHttpServer())
          .get('/api/v1/tipos-producto')
          .set('Authorization', `Bearer ${token('otro')}`)
          .expect(403);
        await request(nest.getHttpServer())
          .post('/api/v1/tipos-producto')
          .set('Authorization', `Bearer ${token('', true, [])}`)
          .send({ nombre: 'Sin rol' })
          .expect(403);
        await request(nest.getHttpServer())
          .post('/api/v1/tipos-producto')
          .send({ nombre: 'Sin token' })
          .expect(401);
        await request(nest.getHttpServer())
          .post('/api/v1/tipos-producto')
          .set('Authorization', `Bearer ${token('catalogo:leer')}`)
          .send({ nombre: 'Token de servicio' })
          .expect(403);
        const tipoHttp = await request(nest.getHttpServer())
          .post('/api/v1/tipos-producto')
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({ nombre: `Tipo HTTP ${brandId}` })
          .expect(201);
        tipoCreado = tipoHttp.body.tipoProductoId as string;
        const tiposProductoHumano = await request(nest.getHttpServer())
          .get('/api/v1/tipos-producto')
          .set(
            'Authorization',
            `Bearer ${token('', true, ['GESTOR_COMERCIAL'], 'unused', null)}`,
          )
          .expect(200);
        expect(tiposProductoHumano.body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ tipoProductoId: tipoCreado }),
          ]),
        );
        await request(nest.getHttpServer())
          .get(`/api/v1/tipos-producto/${tipoCreado}`)
          .set('Authorization', `Bearer ${token('catalogo:leer')}`)
          .expect(200);
        await request(nest.getHttpServer())
          .get(`/api/v1/tipos-producto/${tipoCreado}`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        caracteristicaCreada = (
          await admin.query(
            "INSERT INTO taxonomy.characteristics (nombre, tipo) VALUES ($1, 'LISTA') RETURNING id",
            [`Característica HTTP ${brandId}`],
          )
        ).rows[0].id as string;
        const valorCreado = await request(nest.getHttpServer())
          .post(`/api/v1/caracteristicas/${caracteristicaCreada}/valores`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({ nombre: 'Rojo' })
          .expect(201);
        await request(nest.getHttpServer())
          .get(`/api/v1/caracteristicas/${caracteristicaCreada}/valores`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        const valorEditado = await request(nest.getHttpServer())
          .patch(
            `/api/v1/caracteristicas/${caracteristicaCreada}/valores/${valorCreado.body.valorId}`,
          )
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({ nombre: 'Rojo oscuro', version: 0 })
          .expect(200);
        expect(valorEditado.body).toMatchObject({
          nombre: 'Rojo oscuro',
          version: 1,
        });
        await request(nest.getHttpServer())
          .post(`/api/v1/tipos-producto/${tipoCreado}/caracteristicas`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({
            caracteristicaId: caracteristicaCreada,
            obligatoria: true,
            schemaVersion: 1,
          })
          .expect(201);
        const esquemaHttp = await request(nest.getHttpServer())
          .get(`/api/v1/tipos-producto/${tipoCreado}/caracteristicas`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        expect(esquemaHttp.body).toMatchObject({
          schemaVersion: 2,
          caracteristicas: [{ caracteristicaId: caracteristicaCreada }],
        });
        const asociacionEditada = await request(nest.getHttpServer())
          .patch(
            `/api/v1/tipos-producto/${tipoCreado}/caracteristicas/${caracteristicaCreada}`,
          )
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({ obligatoria: false, schemaVersion: 2 })
          .expect(200);
        expect(asociacionEditada.body).toMatchObject({
          obligatoria: false,
          schemaVersion: 3,
        });
        await request(nest.getHttpServer())
          .get(`/api/v1/tipos-producto/${tipoCreado}/caracteristicas`)
          .set('Authorization', `Bearer ${token('catalogo:leer')}`)
          .expect(200);
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
            .set(
              'Authorization',
              `Bearer ${token('catalogo:leer', false, [], 'modulo-marketplace')}`,
            )
            .expect(200);
          await request(nest.getHttpServer())
            .get(`/api/v1/${path}`)
            .set('Authorization', `Bearer ${token('catalogo:leer')}`)
            .expect(403);
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
        await admin.query(
          "UPDATE taxonomy.categories SET estado='INACTIVO' WHERE id=$1",
          [categoriaAdminId],
        );
        const categoriaReactivada = await request(nest.getHttpServer())
          .post(`/api/v1/categorias/${categoriaAdminId}/reactivar`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        expect(categoriaReactivada.body.estado).toBe('ACTIVO');
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

        // contract-test: 'obtenerArbolCategoriasAdmin'
        await request(nest.getHttpServer())
          .get('/api/v1/categorias/arbol')
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        // contract-test: 'listarCategoriasAdmin'
        await request(nest.getHttpServer())
          .get('/api/v1/categorias/administracion?pagina=1&tamanio=10')
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        // contract-test: 'listarMarcasAdmin'
        await request(nest.getHttpServer())
          .get('/api/v1/marcas/administracion?pagina=1&tamanio=10')
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        // contract-test: 'obtenerMarcaAdmin'
        await request(nest.getHttpServer())
          .get(`/api/v1/marcas/${brandId}`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        // contract-test: 'crearCaracteristica'
        const caracteristicaHttp = await request(nest.getHttpServer())
          .post('/api/v1/caracteristicas')
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({
            nombre: `Característica HTTP nueva ${brandId}`,
            tipo: 'LISTA',
          })
          .expect(201);
        caracteristicaHttpCreada = caracteristicaHttp.body.caracteristicaId;
        const valoresHttp = await Promise.all(
          ['Rojo', 'Azul', 'Verde'].map(async (nombre) => {
            const response = await request(nest.getHttpServer())
              .post(
                `/api/v1/caracteristicas/${caracteristicaHttpCreada}/valores`,
              )
              .set('Authorization', `Bearer ${token('', true)}`)
              .send({ nombre })
              .expect(201);
            return response.body.valorId as string;
          }),
        );
        await admin.query(
          "UPDATE taxonomy.characteristic_values SET estado='INACTIVO' WHERE id=$1",
          [valoresHttp[1]],
        );
        await admin.query(
          "UPDATE taxonomy.characteristic_values SET estado='PENDING_DEACTIVATION' WHERE id=$1",
          [valoresHttp[2]],
        );
        // contract-test: 'obtenerCaracteristica'
        await request(nest.getHttpServer())
          .get(`/api/v1/caracteristicas/${caracteristicaHttpCreada}`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        // contract-test: 'listarCaracteristicas'
        const caracteristicasHttp = await request(nest.getHttpServer())
          .get('/api/v1/caracteristicas?pagina=1&tamanio=20&tipo=LISTA')
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        expect(
          caracteristicasHttp.body.items.some(
            (item: { caracteristicaId: string }) =>
              item.caracteristicaId === caracteristicaHttpCreada,
          ),
        ).toBe(true);
        // contract-test: 'actualizarCaracteristica'
        const caracteristicaEditada = await request(nest.getHttpServer())
          .patch(`/api/v1/caracteristicas/${caracteristicaHttpCreada}`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({
            nombre: `Característica HTTP editada ${brandId}`,
            version: 0,
          })
          .expect(200);
        expect(caracteristicaEditada.body.version).toBe(1);
        expect(caracteristicaEditada.body.valores).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              valorId: valoresHttp[0],
              estado: 'ACTIVO',
            }),
            expect.objectContaining({
              valorId: valoresHttp[1],
              estado: 'INACTIVO',
            }),
          ]),
        );
        expect(caracteristicaEditada.body.valores).toHaveLength(2);
        expect(
          caracteristicaEditada.body.valores.every(
            (valor: { estado: string }) =>
              valor.estado === 'ACTIVO' || valor.estado === 'INACTIVO',
          ),
        ).toBe(true);
        const caracteristicaConsultada = await request(nest.getHttpServer())
          .get(`/api/v1/caracteristicas/${caracteristicaHttpCreada}`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        expect(caracteristicaConsultada.body.valores).toHaveLength(2);
        const listaCaracteristicas = await request(nest.getHttpServer())
          .get('/api/v1/caracteristicas?pagina=1&tamanio=20&tipo=LISTA')
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        const itemCaracteristica = listaCaracteristicas.body.items.find(
          (item: { caracteristicaId: string }) =>
            item.caracteristicaId === caracteristicaHttpCreada,
        );
        expect(itemCaracteristica.valores).toHaveLength(2);
        expect(
          itemCaracteristica.valores.every(
            (valor: { estado: string }) =>
              valor.estado === 'ACTIVO' || valor.estado === 'INACTIVO',
          ),
        ).toBe(true);
        const tipoInmutable = await request(nest.getHttpServer())
          .patch(`/api/v1/caracteristicas/${caracteristicaHttpCreada}`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({ tipo: 'TEXTO', version: 1 })
          .expect(409);
        expect(tipoInmutable.body.code).toBe('TIPO_CARACTERISTICA_INMUTABLE');
        // contract-test: 'desactivarCaracteristica'
        await request(nest.getHttpServer())
          .post(
            `/api/v1/caracteristicas/${caracteristicaHttpCreada}/desactivar`,
          )
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        // contract-test: 'reactivarCaracteristica'
        const caracteristicaReactivada = await request(nest.getHttpServer())
          .post(`/api/v1/caracteristicas/${caracteristicaHttpCreada}/reactivar`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        expect(caracteristicaReactivada.body.estado).toBe('ACTIVO');

        await admin.query(
          "UPDATE taxonomy.characteristic_values SET estado='INACTIVO' WHERE caracteristica_id=$1 AND nombre='Rojo oscuro'",
          [caracteristicaCreada],
        );
        // contract-test: 'reactivarValorCaracteristica'
        const valorReactivado = await request(nest.getHttpServer())
          .post(
            `/api/v1/caracteristicas/${caracteristicaCreada}/valores/${(await admin.query("SELECT id FROM taxonomy.characteristic_values WHERE caracteristica_id=$1 AND nombre='Rojo oscuro'", [caracteristicaCreada])).rows[0].id}/reactivar`,
          )
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        expect(valorReactivado.body.estado).toBe('ACTIVO');

        await admin.query(
          "UPDATE taxonomy.product_types SET estado='INACTIVO' WHERE id=$1",
          [tipoCreado],
        );
        // contract-test: 'reactivarTipoProducto'
        const tipoReactivado = await request(nest.getHttpServer())
          .post(`/api/v1/tipos-producto/${tipoCreado}/reactivar`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        expect(tipoReactivado.body.estado).toBe('ACTIVO');

        // contract-test: 'resolverSlugCategoriaCreacion'
        const propuesta = await request(nest.getHttpServer())
          .post('/api/v1/seo/categorias/slug/resolver')
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({ nombre: `Categoría SEO ${brandId}` })
          .expect(200);
        expect(propuesta.body).toEqual({
          slug: `categoria-seo-${brandId}`,
          colisionResuelta: false,
        });
        const slugOriginal = `http-${brandId}`;
        // contract-test: 'obtenerSeoPorSlug'
        await request(nest.getHttpServer())
          .get(`/api/v1/seo/${slugOriginal}`)
          .expect(200);
        // contract-test: 'actualizarSeoCategoria'
        const seoActualizado = await request(nest.getHttpServer())
          .patch(`/api/v1/categorias/${categoryCreated}/seo`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({
            slug: `categoria-seo-${brandId}`,
            metaTitulo: 'Título SEO',
            metaDescripcion: 'Descripción SEO',
          })
          .expect(200);
        expect(seoActualizado.body).toMatchObject({
          categoriaId: categoryCreated,
          slug: `categoria-seo-${brandId}`,
          metaTitulo: 'Título SEO',
        });
        const slugHistoricoRechazado = await request(nest.getHttpServer())
          .patch(`/api/v1/categorias/${categoryCreated}/seo`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({ slug: slugOriginal })
          .expect(409);
        expect(slugHistoricoRechazado.body.code).toBe('SLUG_DUPLICADO');
        const slugCreacionRechazado = await request(nest.getHttpServer())
          .post('/api/v1/categorias')
          .set('Authorization', `Bearer ${token('', true)}`)
          .send({
            nombre: `No reutilizar slug ${brandId}`,
            slugConfirmado: slugOriginal,
          })
          .expect(409);
        expect(slugCreacionRechazado.body.code).toBe('SLUG_DUPLICADO');
        // contract-test: 'obtenerSeoCategoriaAdmin'
        await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${categoryCreated}/seo`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        // contract-test: 'listarHistorialSlugCategoria'
        const historialSeo = await request(nest.getHttpServer())
          .get(`/api/v1/categorias/${categoryCreated}/seo/historial`)
          .set('Authorization', `Bearer ${token('', true)}`)
          .expect(200);
        expect(historialSeo.body).toContainEqual(
          expect.objectContaining({
            oldSlug: slugOriginal,
            newSlug: `categoria-seo-${brandId}`,
          }),
        );
        // contract-test: 'resolverSlugAnterior'
        const redireccion = await request(nest.getHttpServer())
          .get(`/api/v1/seo/resoluciones/${slugOriginal}`)
          .expect(200);
        expect(redireccion.body).toEqual({
          old_slug: slugOriginal,
          new_slug: `categoria-seo-${brandId}`,
          resolution: 'PERMANENT',
        });
        // contract-test: 'obtenerSeoPorSlug'
        await request(nest.getHttpServer())
          .get(`/api/v1/seo/categoria-seo-${brandId}`)
          .expect(200);
      } finally {
        await nest?.close();
        if (tipoCreado) {
          await admin.query(
            "DELETE FROM taxonomy.outbox WHERE event_name = 'taxonomy.product-type-schema.changed' AND payload->'data'->>'tipo_producto_id' = $1",
            [tipoCreado],
          );
          await admin.query(
            'DELETE FROM taxonomy.product_type_characteristics WHERE tipo_producto_id = $1',
            [tipoCreado],
          );
          await admin.query(
            'DELETE FROM taxonomy.product_types WHERE id = $1',
            [tipoCreado],
          );
        }
        if (caracteristicaCreada) {
          await admin.query(
            "DELETE FROM taxonomy.outbox WHERE event_name='taxonomy.characteristic-value.updated' AND payload->'data'->>'caracteristica_id'=$1",
            [caracteristicaCreada],
          );
          await admin.query(
            'DELETE FROM taxonomy.characteristic_values WHERE caracteristica_id = $1',
            [caracteristicaCreada],
          );
          await admin.query(
            'DELETE FROM taxonomy.characteristics WHERE id = $1',
            [caracteristicaCreada],
          );
        }
        if (caracteristicaHttpCreada) {
          await admin.query(
            'DELETE FROM taxonomy.characteristic_values WHERE caracteristica_id = $1',
            [caracteristicaHttpCreada],
          );
          await admin.query(
            'DELETE FROM taxonomy.characteristics WHERE id = $1',
            [caracteristicaHttpCreada],
          );
        }
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
            'DELETE FROM taxonomy.slug_history WHERE categoria_id = $1',
            [categoryCreated],
          );
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
        if (categoriaAdminId) {
          await admin.query(
            "DELETE FROM taxonomy.outbox WHERE event_name='taxonomy.category.updated' AND payload->'data'->>'categoria_id'=$1",
            [categoriaAdminId],
          );
          await admin.query(
            'DELETE FROM taxonomy.category_seo WHERE categoria_id=$1',
            [categoriaAdminId],
          );
          await admin.query('DELETE FROM taxonomy.categories WHERE id=$1', [
            categoriaAdminId,
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
        ).resolves.toBe('CONFLICTO');
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

    // contract-test: 'obtenerOperacionMaestra'
    it('consulta operaciones de baja desde HTTP sobre el esquema local migrado', async () => {
      const operationId = randomUUID();
      const entityId = randomUUID();
      await admin.query(
        "INSERT INTO taxonomy.master_deactivation_operations (operation_id, entity_type, entity_id, source_version, status, correlation_id) VALUES ($1, 'BRAND', $2, 7, 'REQUESTED', $3)",
        [operationId, entityId, randomUUID()],
      );
      const moduleFixture = await Test.createTestingModule({
        imports: [TaxonomySvcModule.forRoot({ databaseUrl: urlApp })],
      })
        .overrideProvider(Database)
        .useValue({
          read: (callback: (db: NodePgDatabase) => Promise<unknown>) =>
            callback(dbApp),
        })
        .overrideProvider(TaxonomyTokenVerifier)
        .useValue({
          verify: async (token: string) => ({
            kind: 'user',
            subject: randomUUID(),
            roles: token === 'gestor' ? ['GESTOR_COMERCIAL'] : [],
            audiences: ['api-productos'],
          }),
        })
        .compile();
      const appHttp = moduleFixture.createNestApplication();
      try {
        await appHttp.init();
        await request(appHttp.getHttpServer())
          .get(`/api/v1/taxonomia/operaciones/${operationId}`)
          .set('Authorization', 'Bearer usuario')
          .expect(403);
        await request(appHttp.getHttpServer())
          .get(`/api/v1/taxonomia/operaciones/${operationId}`)
          .set('Authorization', 'Bearer gestor')
          .expect(200)
          .expect(({ body }) => {
            expect(body).toMatchObject({
              operation_id: operationId,
              entity_type: 'BRAND',
              entity_id: entityId,
              version: 7,
              status: 'PENDING_DEACTIVATION',
              result: null,
              code: null,
            });
          });
      } finally {
        await appHttp.close();
        await admin.query(
          'DELETE FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
          [operationId],
        );
      }
    });

    // contract-test: 'solicitarDesactivacionCategoria'
    // contract-test: 'solicitarDesactivacionMarca'
    // contract-test: 'solicitarDesactivacionTipoProducto'
    // contract-test: 'solicitarDesactivacionValorCaracteristica'
    // contract-test: 'solicitarDesasociacionTipoCaracteristica'
    it('admite las cinco clases de baja segura HTTP y deduplica por correlación', async () => {
      const categoryId = randomUUID();
      const brandId = randomUUID();
      const typeId = randomUUID();
      const characteristicId = randomUUID();
      const valueId = randomUUID();
      const operationIds: string[] = [];
      await admin.query(
        readFileSync(
          resolve(
            'apps/taxonomy-svc/migrations/0004_product_type_pending_version.sql',
          ),
          'utf8',
        ),
      );
      const moduleFixture = await Test.createTestingModule({
        imports: [TaxonomySvcModule.forRoot({ databaseUrl: urlApp })],
      })
        .overrideProvider(Database)
        .useValue({
          read: (callback: (db: NodePgDatabase) => Promise<unknown>) =>
            callback(dbApp),
        })
        .overrideProvider(TaxonomyTokenVerifier)
        .useValue({
          verify: async () => ({
            kind: 'user',
            subject: randomUUID(),
            roles: ['GESTOR_COMERCIAL'],
            audiences: ['api-productos'],
          }),
        })
        .compile();
      const appHttp = moduleFixture.createNestApplication();
      try {
        await admin.query(
          'INSERT INTO taxonomy.categories (id, nombre) VALUES ($1, $2)',
          [categoryId, `Baja HTTP ${categoryId}`],
        );
        await admin.query(
          'INSERT INTO taxonomy.brands (id, nombre) VALUES ($1, $2)',
          [brandId, `Baja HTTP ${brandId}`],
        );
        await admin.query(
          'INSERT INTO taxonomy.product_types (id, nombre) VALUES ($1, $2)',
          [typeId, `Baja HTTP ${typeId}`],
        );
        await admin.query(
          "INSERT INTO taxonomy.characteristics (id, nombre, tipo) VALUES ($1, $2, 'LISTA')",
          [characteristicId, `Baja HTTP ${characteristicId}`],
        );
        await admin.query(
          'INSERT INTO taxonomy.characteristic_values (id, caracteristica_id, nombre) VALUES ($1, $2, $3)',
          [valueId, characteristicId, 'Opción'],
        );
        await admin.query(
          'INSERT INTO taxonomy.product_type_characteristics (tipo_producto_id, caracteristica_id) VALUES ($1, $2)',
          [typeId, characteristicId],
        );
        await appHttp.init();
        const token = 'Bearer gestor';
        const solicitar = async (
          path: string,
          correlationId = randomUUID(),
        ) => {
          const response = await request(appHttp.getHttpServer())
            .post(path)
            .set('Authorization', token)
            .set('X-Correlation-Id', correlationId);
          if (response.status !== 202)
            throw new Error(
              `${path} status=${response.status} body=${JSON.stringify(response.body)}`,
            );
          operationIds.push(response.body.operation_id as string);
          expect(response.body).toMatchObject({
            correlation_id: correlationId,
            status: 'ACCEPTED',
          });
          return response.body.operation_id as string;
        };
        const correlationId = randomUUID();
        const categoryOperation = await solicitar(
          `/api/v1/categorias/${categoryId}/desactivar`,
          correlationId,
        );
        await expect(
          solicitar(
            `/api/v1/categorias/${categoryId}/desactivar`,
            correlationId,
          ),
        ).resolves.toBe(categoryOperation);
        await solicitar(`/api/v1/marcas/${brandId}/desactivar`);
        await solicitar(`/api/v1/tipos-producto/${typeId}/desactivar`);
        await solicitar(
          `/api/v1/caracteristicas/${characteristicId}/valores/${valueId}/desactivar`,
        );
        await solicitar(
          `/api/v1/tipos-producto/${typeId}/caracteristicas/${characteristicId}/desasociar`,
        );
        expect(operationIds).toHaveLength(6);
        expect(new Set(operationIds).size).toBe(5);
        const states = await admin.query(
          'SELECT entity_type, status FROM taxonomy.master_deactivation_operations WHERE operation_id = ANY($1::uuid[]) ORDER BY entity_type',
          [operationIds],
        );
        expect(states.rows).toHaveLength(5);
        expect(states.rows.every((row) => row.status === 'IN_PROGRESS')).toBe(
          true,
        );
      } finally {
        await appHttp.close();
        await admin.query(
          "DELETE FROM taxonomy.outbox WHERE event_name='taxonomy.product-type-schema.changed' AND payload->'data'->>'tipo_producto_id'=$1",
          [typeId],
        );
        if (operationIds.length) {
          await admin.query(
            'DELETE FROM taxonomy.outbox WHERE operation_id = ANY($1::uuid[])',
            [operationIds],
          );
          await admin.query(
            'DELETE FROM taxonomy.master_deactivation_operations WHERE operation_id = ANY($1::uuid[])',
            [operationIds],
          );
        }
        await admin.query(
          'DELETE FROM taxonomy.product_type_characteristics WHERE tipo_producto_id=$1 AND caracteristica_id=$2',
          [typeId, characteristicId],
        );
        await admin.query(
          'DELETE FROM taxonomy.characteristic_values WHERE id=$1',
          [valueId],
        );
        await admin.query('DELETE FROM taxonomy.characteristics WHERE id=$1', [
          characteristicId,
        ]);
        await admin.query('DELETE FROM taxonomy.product_types WHERE id=$1', [
          typeId,
        ]);
        await admin.query('DELETE FROM taxonomy.categories WHERE id=$1', [
          categoryId,
        ]);
        await admin.query('DELETE FROM taxonomy.brands WHERE id=$1', [brandId]);
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

    it('publica outbox tras confirmación y procesa checked con Inbox transaccional e idempotente', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const intentos = new DeactivationIntentService(database);
      const store = new TaxonomyMessageStore(database, intentos);
      const operationId = '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const entityId = '44444444-4444-4444-8444-444444444444';
      const correlationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const messageId = '77777777-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      try {
        await expect(
          intentos.registrar({
            operationId,
            correlationId,
            entityType: 'BRAND',
            entityId,
            version: 0,
          }),
        ).resolves.toBe('REGISTRADA');
        const solicitud = (
          await admin.query(
            'SELECT message_id FROM taxonomy.outbox WHERE operation_id = $1',
            [operationId],
          )
        ).rows[0].message_id as string;
        await expect(
          store.publicarUno(async () => {
            throw new Error('fallo');
          }),
        ).resolves.toBe('PENDIENTE');
        expect(
          (
            await admin.query(
              'SELECT published_at, attempts FROM taxonomy.outbox WHERE message_id = $1',
              [solicitud],
            )
          ).rows,
        ).toEqual([{ published_at: null, attempts: 1 }]);
        await expect(store.publicarUno(async () => undefined)).resolves.toBe(
          'VACIO',
        );
        const enviados: unknown[] = [];
        await expect(
          store.publicarUno(async (row) => {
            enviados.push(row.message_id);
          }),
        ).resolves.toBe('PUBLICADO');
        expect(enviados).toEqual([solicitud]);
        const checked = parseChecked({
          message_id: messageId,
          correlation_id: correlationId,
          operation_id: operationId,
          causation_id: solicitud,
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          producer: 'catalog-svc',
          kind: 'result',
          name: 'catalog.master.deactivation.checked',
          data: {
            entity_type: 'BRAND',
            entity_id: entityId,
            version: 0,
            result: 'CLEAR',
          },
        });
        await admin.query(`REVOKE INSERT ON taxonomy.outbox FROM ${ROL_APP}`);
        try {
          await expect(store.consumir(checked)).rejects.toThrow();
          expect(
            (
              await admin.query(
                'SELECT id FROM taxonomy.inbox WHERE message_id = $1',
                [messageId],
              )
            ).rows,
          ).toHaveLength(0);
          expect(
            (
              await admin.query(
                'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
                [operationId],
              )
            ).rows,
          ).toEqual([{ status: 'IN_PROGRESS' }]);
        } finally {
          await admin.query(`GRANT INSERT ON taxonomy.outbox TO ${ROL_APP}`);
        }
        await store.consumir(checked);
        await store.consumir(checked);
        expect(
          (
            await admin.query(
              'SELECT result FROM taxonomy.inbox WHERE message_id = $1',
              [messageId],
            )
          ).rows,
        ).toEqual([{ result: 'PROCESSED' }]);
        expect(
          (
            await admin.query(
              'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
              [operationId],
            )
          ).rows,
        ).toEqual([{ status: 'COMPLETED' }]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id = $1 AND event_name = 'taxonomy.master.deactivated'",
              [operationId],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
        await expect(
          store.consumir({
            ...checked,
            data: { ...checked.data, result: 'IN_USE' },
          }),
        ).rejects.toThrow();
      } finally {
        await admin.query('DELETE FROM taxonomy.inbox WHERE message_id = $1', [
          messageId,
        ]);
        await admin.query(
          'DELETE FROM taxonomy.outbox WHERE operation_id = $1',
          [operationId],
        );
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

    it('ignora correlation_id distinto del original aunque el resto del mensaje coincida', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const intentos = new DeactivationIntentService(database);
      const store = new TaxonomyMessageStore(database, intentos);
      const operationId = '77777777-cccc-4ccc-8ccc-cccccccccccc';
      const entityId = '44444444-4444-4444-8444-444444444444';
      const correlationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      // Ni siquiera operation_id sustituye al correlation_id original.
      const wrongCorrelation = operationId;
      const messageId = '77777777-dddd-4ddd-8ddd-dddddddddddd';
      try {
        await expect(
          intentos.registrar({
            operationId,
            correlationId,
            entityType: 'BRAND',
            entityId,
            version: 0,
          }),
        ).resolves.toBe('REGISTRADA');
        const causation = (
          await admin.query(
            'SELECT message_id FROM taxonomy.outbox WHERE operation_id=$1',
            [operationId],
          )
        ).rows[0].message_id;
        const checked = parseChecked({
          message_id: messageId,
          correlation_id: wrongCorrelation,
          operation_id: operationId,
          causation_id: causation,
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          producer: 'catalog-svc',
          kind: 'result',
          name: 'catalog.master.deactivation.checked',
          data: {
            entity_type: 'BRAND',
            entity_id: entityId,
            version: 0,
            result: 'CLEAR',
          },
        });
        await store.consumir(checked);
        await expect(
          intentos.finalizar({
            operationId,
            correlationId: wrongCorrelation,
            entityType: 'BRAND',
            entityId,
            version: 0,
            result: 'CLEAR',
          }),
        ).resolves.toBe('IGNORADA');
        expect(
          (
            await admin.query(
              'SELECT status,correlation_id FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
              [operationId],
            )
          ).rows,
        ).toEqual([{ status: 'IN_PROGRESS', correlation_id: correlationId }]);
        expect(
          (
            await admin.query(
              'SELECT estado,taxonomy_version FROM taxonomy.brands WHERE id=$1',
              [entityId],
            )
          ).rows,
        ).toEqual([{ estado: 'PENDING_DEACTIVATION', taxonomy_version: '0' }]);
        expect(
          (
            await admin.query(
              'SELECT result FROM taxonomy.inbox WHERE message_id=$1',
              [messageId],
            )
          ).rows,
        ).toEqual([{ result: 'IGNORED' }]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id=$1 AND event_name IN ('taxonomy.master.deactivated','taxonomy.master.deactivation.rejected')",
              [operationId],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
      } finally {
        await admin.query('DELETE FROM taxonomy.inbox WHERE message_id=$1', [
          messageId,
        ]);
        await admin.query('DELETE FROM taxonomy.outbox WHERE operation_id=$1', [
          operationId,
        ]);
        await admin.query(
          'DELETE FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
          [operationId],
        );
        await admin.query(
          "UPDATE taxonomy.brands SET estado='ACTIVO', taxonomy_version=0 WHERE id=$1",
          [entityId],
        );
        vi.restoreAllMocks();
      }
    });

    it('rota fallos de Outbox sin adelantar el resultado de la misma operación', async () => {
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const store = new TaxonomyMessageStore(
        database,
        new DeactivationIntentService(database),
      );
      const opA = 'eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const opB = 'eeeeeeee-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const correlation = 'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc';
      try {
        await admin.query(
          `INSERT INTO taxonomy.outbox (id, message_id, event_name, kind, correlation_id, operation_id, occurred_at, payload)
          VALUES ('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', gen_random_uuid(), 'taxonomy.master.deactivation.check.requested', 'command', $1, $2, '2020-01-01 00:00:01+00', '{}'),
          ('22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa', gen_random_uuid(), 'taxonomy.master.deactivation.check.requested', 'command', $1, $3, '2020-01-01 00:00:02+00', '{}'),
          ('33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', gen_random_uuid(), 'taxonomy.master.deactivation.rejected', 'result', $1, $2, '2020-01-01 00:00:03+00', '{}')`,
          [correlation, opA, opB],
        );
        const enviados: string[] = [];
        const enviar = async (row: Record<string, unknown>) => {
          enviados.push(String(row.id));
        };
        await expect(
          store.publicarUno(async () => {
            throw new Error('fallo permanente');
          }),
        ).resolves.toBe('PENDIENTE');
        await expect(store.publicarUno(enviar)).resolves.toBe('PUBLICADO');
        expect(enviados).toEqual(['22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
        await expect(store.publicarUno(enviar)).resolves.toBe('VACIO');
        expect(
          (
            await admin.query(
              "SELECT published_at FROM taxonomy.outbox WHERE id = '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
            )
          ).rows,
        ).toEqual([{ published_at: null }]);
        await expect(store.publicarUno(enviar)).resolves.toBe('PUBLICADO');
        await expect(store.publicarUno(enviar)).resolves.toBe('PUBLICADO');
        expect(enviados).toEqual([
          '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ]);
      } finally {
        await admin.query(
          'DELETE FROM taxonomy.outbox WHERE correlation_id = $1',
          [correlation],
        );
        vi.restoreAllMocks();
      }
    });

    it.each([null, undefined])(
      'procesa IN_USE con causation_id %s bajo el contrato publicado',
      async (causation) => {
        const database = new Database();
        vi.spyOn(database, 'read').mockImplementation(async (query) =>
          query(dbApp),
        );
        const intentos = new DeactivationIntentService(database);
        const store = new TaxonomyMessageStore(database, intentos);
        const operationId = 'eeeeeeee-dddd-4ddd-8ddd-dddddddddddd';
        const messageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        const entityId = '44444444-4444-4444-8444-444444444444';
        const correlationId = 'eeeeeeee-ffff-4fff-8fff-ffffffffffff';
        try {
          await expect(
            intentos.registrar({
              operationId,
              correlationId,
              entityType: 'BRAND',
              entityId,
              version: 0,
            }),
          ).resolves.toBe('REGISTRADA');
          const checked = parseChecked({
            message_id: messageId,
            operation_id: operationId,
            correlation_id: correlationId,
            ...(causation === undefined ? {} : { causation_id: causation }),
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            producer: 'catalog-svc',
            kind: 'result',
            name: 'catalog.master.deactivation.checked',
            data: {
              entity_type: 'BRAND',
              entity_id: entityId,
              version: 0,
              result: 'IN_USE',
            },
          });
          await store.consumir(checked);
          await store.consumir(checked);
          expect(
            (
              await admin.query(
                'SELECT status, reason FROM taxonomy.master_deactivation_operations WHERE operation_id = $1',
                [operationId],
              )
            ).rows,
          ).toEqual([{ status: 'REJECTED', reason: 'IN_USE' }]);
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
                "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id = $1 AND event_name = 'taxonomy.master.deactivation.rejected'",
                [operationId],
              )
            ).rows,
          ).toEqual([{ n: 1 }]);
        } finally {
          await admin.query(
            'DELETE FROM taxonomy.inbox WHERE message_id = $1',
            [messageId],
          );
          await admin.query(
            'DELETE FROM taxonomy.outbox WHERE operation_id = $1',
            [operationId],
          );
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
      },
    );

    it('procesa los tres maestros por RabbitMQ real sin duplicar Inbox ni Outbox', async () => {
      const rabbit = new RabbitTaxonomyDesechable();
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const intentos = new DeactivationIntentService(database);
      const store = new TaxonomyMessageStore(database, intentos);
      const procesar = vi.spyOn(store, 'consumir');
      const nombre = `rabbit-maestros-${randomUUID()}`;
      const operaciones: string[] = [];
      const mensajes: string[] = [];
      let tipo: string | undefined;
      let otroTipo: string | undefined;
      let caracteristica: string | undefined;
      let valor: string | undefined;
      let asociacion: string | undefined;
      let broker: ChannelModel | undefined;
      let catalog: ChannelModel | undefined;
      let runtime: TaxonomyAmqpRuntime | undefined;
      const original = (
        await admin.query(
          "SELECT pg_get_functiondef('taxonomy.fn_bump_product_type_schema_version()'::regprocedure) AS definition",
        )
      ).rows[0].definition as string;
      const esperar = async (condicion: () => Promise<boolean> | boolean) => {
        for (let i = 0; i < 200; i++) {
          if (await condicion()) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('Tiempo de espera agotado para maestros RabbitMQ');
      };
      try {
        await admin.query(
          readFileSync(
            resolve(
              'apps/taxonomy-svc/migrations/0004_product_type_pending_version.sql',
            ),
            'utf8',
          ),
        );
        tipo = (
          await admin.query(
            'INSERT INTO taxonomy.product_types (nombre) VALUES ($1) RETURNING id',
            [nombre],
          )
        ).rows[0].id as string;
        otroTipo = (
          await admin.query(
            'INSERT INTO taxonomy.product_types (nombre) VALUES ($1) RETURNING id',
            [nombre + '-esquema'],
          )
        ).rows[0].id as string;
        caracteristica = (
          await admin.query(
            "INSERT INTO taxonomy.characteristics (nombre, tipo) VALUES ($1, 'LISTA') RETURNING id",
            [nombre],
          )
        ).rows[0].id as string;
        valor = (
          await admin.query(
            'INSERT INTO taxonomy.characteristic_values (caracteristica_id, nombre) VALUES ($1, $2) RETURNING id',
            [caracteristica, nombre],
          )
        ).rows[0].id as string;
        asociacion = (
          await admin.query(
            'INSERT INTO taxonomy.product_type_characteristics (tipo_producto_id, caracteristica_id) VALUES ($1, $2) RETURNING id',
            [otroTipo, caracteristica],
          )
        ).rows[0].id as string;
        const urls = await rabbit.iniciar();
        broker = await connect(urls.taxonomyUrl);
        const canal = await broker.createChannel();
        for (const exchange of [
          'po.comandos.x',
          'po.eventos.x',
          'po.resultados.x',
        ])
          await canal.assertExchange(exchange, 'topic', { durable: true });
        for (const queue of [
          'po.taxonomia.q',
          'prueba.solicitudes.q',
          'prueba.terminal.q',
          'prueba.esquema.q',
        ])
          await canal.assertQueue(queue, { durable: true });
        await canal.bindQueue(
          'po.taxonomia.q',
          'po.resultados.x',
          'catalog.master.deactivation.checked',
        );
        await canal.bindQueue(
          'prueba.solicitudes.q',
          'po.comandos.x',
          'taxonomy.master.deactivation.check.requested',
        );
        await canal.bindQueue(
          'prueba.terminal.q',
          'po.eventos.x',
          'taxonomy.master.deactivated',
        );
        await canal.bindQueue(
          'prueba.esquema.q',
          'po.eventos.x',
          'taxonomy.product-type-schema.changed',
        );
        catalog = await connect(urls.catalogUrl);
        const productor = await catalog.createConfirmChannel();
        runtime = new TaxonomyAmqpRuntime(store);
        runtime.configurar({
          RABBITMQ_URL: urls.taxonomyUrl,
          TAXONOMY_CATALOG_AMQP_USER: 'catalog_test',
        });
        runtime.iniciar();
        await esperar(() => runtime!.disponible());
        for (const [entityType, entityId, version] of [
          ['PRODUCT_TYPE', tipo, 0],
          ['CHARACTERISTIC_VALUE', valor, 0],
          ['PRODUCT_TYPE_CHARACTERISTIC', asociacion, 2],
        ] as const) {
          const operationId = randomUUID();
          const correlationId = randomUUID();
          const messageId = randomUUID();
          operaciones.push(operationId);
          mensajes.push(messageId);
          const datosAsociacion =
            entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
              ? { tipoProductoId: otroTipo, caracteristicaId: caracteristica }
              : {};
          expect(
            await intentos.registrar({
              operationId,
              correlationId,
              entityType,
              entityId,
              version,
              ...datosAsociacion,
            }),
          ).toBe('REGISTRADA');
          await esperar(
            async () =>
              (await canal.checkQueue('prueba.solicitudes.q')).messageCount ===
              1,
          );
          const solicitud = await canal.get('prueba.solicitudes.q', {
            noAck: true,
          });
          if (!solicitud) throw new Error('Solicitud no publicada');
          const causa = JSON.parse(solicitud.content.toString())
            .message_id as string;
          const respuesta = {
            message_id: messageId,
            correlation_id: correlationId,
            operation_id: operationId,
            causation_id: causa,
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            producer: 'catalog-svc',
            kind: 'result',
            name: 'catalog.master.deactivation.checked',
            data: {
              entity_type: entityType,
              entity_id: entityId,
              version,
              result: 'CLEAR',
              ...(entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
                ? {
                    tipo_producto_id: otroTipo,
                    caracteristica_id: caracteristica,
                  }
                : {}),
            },
          };
          const enviar = () =>
            new Promise<void>((resolve, reject) =>
              productor.publish(
                'po.resultados.x',
                respuesta.name,
                Buffer.from(JSON.stringify(respuesta)),
                {
                  persistent: true,
                  contentType: 'application/json',
                  userId: 'catalog_test',
                  messageId,
                  correlationId,
                },
                (error) => (error ? reject(error) : resolve()),
              ),
            );
          await enviar();
          await esperar(
            async () =>
              (
                await admin.query(
                  'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
                  [operationId],
                )
              ).rows[0]?.status === 'COMPLETED',
          );
          await esperar(
            async () =>
              (await canal.checkQueue('prueba.terminal.q')).messageCount === 1,
          );
          const terminal = await canal.get('prueba.terminal.q', {
            noAck: true,
          });
          if (!terminal) throw new Error('Resultado terminal no publicado');
          expect(JSON.parse(terminal.content.toString())).toMatchObject({
            operation_id: operationId,
            data: { entity_type: entityType, entity_id: entityId },
          });
          const antes = procesar.mock.calls.length;
          await enviar();
          await esperar(() => procesar.mock.calls.length > antes);
          await procesar.mock.results[antes].value;
          expect(
            (
              await admin.query(
                'SELECT count(*)::int AS n FROM taxonomy.inbox WHERE message_id=$1 AND result=$2',
                [messageId, 'PROCESSED'],
              )
            ).rows,
          ).toEqual([{ n: 1 }]);
          expect(
            (
              await admin.query(
                "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id=$1 AND event_name='taxonomy.master.deactivated'",
                [operationId],
              )
            ).rows,
          ).toEqual([{ n: 1 }]);
          expect(runtime.disponible()).toBe(true);
        }
      } finally {
        await runtime?.onModuleDestroy();
        await catalog?.close().catch(() => undefined);
        await broker?.close().catch(() => undefined);
        rabbit.cerrar();
        if (mensajes.length)
          await admin.query(
            'DELETE FROM taxonomy.inbox WHERE message_id = ANY($1::uuid[])',
            [mensajes],
          );
        if (operaciones.length) {
          await admin.query(
            'DELETE FROM taxonomy.outbox WHERE operation_id = ANY($1::uuid[])',
            [operaciones],
          );
          await admin.query(
            'DELETE FROM taxonomy.master_deactivation_operations WHERE operation_id = ANY($1::uuid[])',
            [operaciones],
          );
        }
        if (asociacion)
          await admin.query(
            'DELETE FROM taxonomy.product_type_characteristics WHERE id=$1',
            [asociacion],
          );
        if (valor)
          await admin.query(
            'DELETE FROM taxonomy.characteristic_values WHERE id=$1',
            [valor],
          );
        if (tipo)
          await admin.query('DELETE FROM taxonomy.product_types WHERE id=$1', [
            tipo,
          ]);
        if (otroTipo)
          await admin.query('DELETE FROM taxonomy.product_types WHERE id=$1', [
            otroTipo,
          ]);
        if (caracteristica)
          await admin.query(
            'DELETE FROM taxonomy.characteristics WHERE id=$1',
            [caracteristica],
          );
        await admin.query(original);
        vi.restoreAllMocks();
      }
    }, 90_000);

    it('recupera una entrega sin ACK al reiniciar, sin duplicar efectos, con RabbitMQ real aislado', async () => {
      const rabbit = new RabbitTaxonomyDesechable();
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (query) =>
        query(dbApp),
      );
      const intentos = new DeactivationIntentService(database);
      const store = new TaxonomyMessageStore(database, intentos);
      const procesar = vi.spyOn(store, 'consumir');
      const correlationId = 'ffffffff-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const operationId = 'ffffffff-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const messageId = 'ffffffff-cccc-4ccc-8ccc-cccccccccccc';
      const mensajeAjeno = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      const entityId = '44444444-4444-4444-8444-444444444444';
      const opInUse = 'ffffffff-dddd-4ddd-8ddd-dddddddddddd';
      const messageInUse = 'ffffffff-eeee-4eee-8eee-eeeeeeeeeeee';
      const entityInUse = '55555555-5555-4555-8555-555555555555';
      const operacionCategoria = randomUUID();
      const mensajeCategoria = randomUUID();
      let broker: ChannelModel | undefined;
      let catalog: ChannelModel | undefined;
      let runtime: TaxonomyAmqpRuntime | undefined;
      let categoriaPublicada: string | undefined;
      const esperar = async (condicion: () => Promise<boolean> | boolean) => {
        for (let i = 0; i < 150; i++) {
          if (await condicion()) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(
          'Tiempo de espera agotado en la prueba RabbitMQ aislada',
        );
      };
      try {
        const urls = await rabbit.iniciar();
        broker = await connect(urls.taxonomyUrl);
        const canal = await broker.createChannel();
        for (const exchange of [
          'po.comandos.x',
          'po.eventos.x',
          'po.resultados.x',
        ])
          await canal.assertExchange(exchange, 'topic', { durable: true });
        await canal.assertQueue('po.taxonomia.q', { durable: true });
        await canal.assertQueue('po.catalogo.q', { durable: true });
        await canal.bindQueue(
          'po.taxonomia.q',
          'po.resultados.x',
          'catalog.master.deactivation.checked',
        );
        await canal.bindQueue(
          'po.catalogo.q',
          'po.comandos.x',
          'taxonomy.master.deactivation.check.requested',
        );
        await canal.assertQueue('prueba.categorias.q', { durable: true });
        await canal.bindQueue(
          'prueba.categorias.q',
          'po.eventos.x',
          'taxonomy.category.updated',
        );
        await canal.assertQueue('prueba.bajas.q', { durable: true });
        await canal.bindQueue(
          'prueba.bajas.q',
          'po.eventos.x',
          'taxonomy.master.deactivated',
        );
        const categoria = await new CategoryCreateService(database).crear({
          nombre: `Categoria evento ${randomUUID()}`,
          descripcion: null,
          categoriaPadreId: null,
          orden: 0,
          imagenUrl: null,
          slugConfirmado: `evento-${randomUUID()}`,
        });
        if (categoria.estado !== 'CREADA')
          throw new Error('Categoría no creada');
        categoriaPublicada = categoria.categoria.categoriaId;
        catalog = await connect(urls.catalogUrl);
        const productor = await catalog.createConfirmChannel();
        await expect(
          intentos.registrar({
            operationId,
            correlationId,
            entityType: 'BRAND',
            entityId,
            version: 0,
          }),
        ).resolves.toBe('REGISTRADA');
        const requestId = (
          await admin.query(
            'SELECT message_id FROM taxonomy.outbox WHERE operation_id = $1',
            [operationId],
          )
        ).rows[0].message_id as string;
        const crearRuntime = () => {
          const instancia = new TaxonomyAmqpRuntime(store);
          instancia.configurar({
            RABBITMQ_URL: urls.taxonomyUrl,
            TAXONOMY_CATALOG_AMQP_USER: 'catalog_test',
          });
          instancia.iniciar();
          return instancia;
        };
        runtime = crearRuntime();
        await esperar(() => runtime!.disponible());
        await esperar(
          async () =>
            (await canal.checkQueue('prueba.categorias.q')).messageCount === 1,
        );
        const eventoCategoria = await canal.get('prueba.categorias.q', {
          noAck: true,
        });
        if (!eventoCategoria) throw new Error('Falta evento de categoría');
        expect(eventoCategoria.fields.routingKey).toBe(
          'taxonomy.category.updated',
        );
        expect(JSON.parse(eventoCategoria.content.toString())).toMatchObject({
          producer: 'taxonomy-svc',
          kind: 'event',
          name: 'taxonomy.category.updated',
          data: { categoria_id: categoriaPublicada, version: 0 },
        });
        await esperar(
          async () =>
            (
              await admin.query(
                "SELECT published_at IS NOT NULL AS publicado FROM taxonomy.outbox WHERE payload->'data'->>'categoria_id' = $1",
                [categoriaPublicada],
              )
            ).rows[0]?.publicado === true,
        );
        await esperar(
          async () =>
            (await canal.checkQueue('po.catalogo.q')).messageCount === 1,
        );
        const solicitud = await canal.get('po.catalogo.q', { noAck: true });
        expect(
          solicitud && JSON.parse(solicitud.content.toString()).message_id,
        ).toBe(requestId);
        const respuesta = {
          message_id: messageId,
          correlation_id: correlationId,
          operation_id: operationId,
          causation_id: requestId,
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          producer: 'catalog-svc',
          kind: 'result',
          name: 'catalog.master.deactivation.checked',
          data: {
            entity_type: 'BRAND',
            entity_id: entityId,
            version: 0,
            result: 'CLEAR',
          },
        };
        const publicar = () =>
          new Promise<void>((resolve, reject) => {
            productor.publish(
              'po.resultados.x',
              respuesta.name,
              Buffer.from(JSON.stringify(respuesta)),
              {
                persistent: true,
                contentType: 'application/json',
                userId: 'catalog_test',
                messageId,
                correlationId,
              },
              (error) => (error ? reject(error) : resolve()),
            );
          });
        // Cabecera y payload concuerdan entre sí, pero no con la intención guardada.
        const respuestaAjena = {
          ...respuesta,
          message_id: mensajeAjeno,
          correlation_id: operationId,
        };
        await new Promise<void>((resolve, reject) => {
          productor.publish(
            'po.resultados.x',
            respuestaAjena.name,
            Buffer.from(JSON.stringify(respuestaAjena)),
            {
              persistent: true,
              contentType: 'application/json',
              userId: 'catalog_test',
              messageId: mensajeAjeno,
              correlationId: operationId,
            },
            (error) => (error ? reject(error) : resolve()),
          );
        });
        await esperar(
          async () =>
            (
              await admin.query(
                'SELECT result FROM taxonomy.inbox WHERE message_id=$1',
                [mensajeAjeno],
              )
            ).rows[0]?.result === 'IGNORED',
        );
        expect(
          (
            await admin.query(
              'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
              [operationId],
            )
          ).rows,
        ).toEqual([{ status: 'IN_PROGRESS' }]);
        expect(
          (
            await admin.query(
              'SELECT estado,taxonomy_version FROM taxonomy.brands WHERE id=$1',
              [entityId],
            )
          ).rows,
        ).toEqual([{ estado: 'PENDING_DEACTIVATION', taxonomy_version: '0' }]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id=$1 AND event_name='taxonomy.master.deactivated'",
              [operationId],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        await admin.query(`REVOKE INSERT ON taxonomy.inbox FROM ${ROL_APP}`);
        await publicar();
        await esperar(() => !runtime!.disponible());
        expect(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM taxonomy.inbox WHERE message_id = $1',
              [messageId],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        await runtime.onModuleDestroy();
        runtime = undefined;
        await esperar(
          async () =>
            (await canal.checkQueue('po.taxonomia.q')).messageCount === 1,
        );
        await admin.query(`GRANT INSERT ON taxonomy.inbox TO ${ROL_APP}`);
        runtime = crearRuntime();
        await esperar(
          async () =>
            (
              await admin.query(
                'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
                [operationId],
              )
            ).rows[0].status === 'COMPLETED',
        );
        await esperar(
          async () =>
            (await canal.checkQueue('prueba.bajas.q')).messageCount === 1,
        );
        const bajaMarca = await canal.get('prueba.bajas.q', { noAck: true });
        if (!bajaMarca) throw new Error('Falta evento de baja de marca');
        expect(JSON.parse(bajaMarca.content.toString())).toMatchObject({
          name: 'taxonomy.master.deactivated',
          operation_id: operationId,
          data: { entity_type: 'BRAND', entity_id: entityId },
        });
        await esperar(
          async () =>
            (
              await admin.query(
                'SELECT published_at IS NOT NULL AS publicado FROM taxonomy.outbox WHERE message_id = $1',
                [bajaMarca.properties.messageId],
              )
            ).rows[0]?.publicado === true,
        );
        await expect(
          intentos.registrar({
            operationId: operacionCategoria,
            correlationId,
            entityType: 'CATEGORY',
            entityId: categoriaPublicada,
            version: 0,
          }),
        ).resolves.toBe('REGISTRADA');
        await esperar(
          async () =>
            (await canal.checkQueue('po.catalogo.q')).messageCount === 1,
        );
        const solicitudCategoria = await canal.get('po.catalogo.q', {
          noAck: true,
        });
        if (!solicitudCategoria)
          throw new Error('Falta solicitud de categoría');
        const respuestaCategoria = {
          ...respuesta,
          message_id: mensajeCategoria,
          operation_id: operacionCategoria,
          causation_id: JSON.parse(solicitudCategoria.content.toString())
            .message_id,
          data: {
            entity_type: 'CATEGORY',
            entity_id: categoriaPublicada,
            version: 0,
            result: 'CLEAR',
          },
        };
        await new Promise<void>((resolve, reject) => {
          productor.publish(
            'po.resultados.x',
            respuestaCategoria.name,
            Buffer.from(JSON.stringify(respuestaCategoria)),
            {
              persistent: true,
              contentType: 'application/json',
              userId: 'catalog_test',
              messageId: mensajeCategoria,
              correlationId,
            },
            (error) => (error ? reject(error) : resolve()),
          );
        });
        await esperar(
          async () =>
            (await canal.checkQueue('prueba.bajas.q')).messageCount === 1,
        );
        const bajaCategoria = await canal.get('prueba.bajas.q', {
          noAck: true,
        });
        if (!bajaCategoria)
          throw new Error('Falta evento de baja de categoría');
        expect(JSON.parse(bajaCategoria.content.toString())).toMatchObject({
          name: 'taxonomy.master.deactivated',
          operation_id: operacionCategoria,
          data: { entity_type: 'CATEGORY', entity_id: categoriaPublicada },
        });
        await esperar(
          async () =>
            (
              await admin.query(
                'SELECT published_at IS NOT NULL AS publicado FROM taxonomy.outbox WHERE message_id = $1',
                [bajaCategoria.properties.messageId],
              )
            ).rows[0]?.publicado === true,
        );
        await productor.waitForConfirms();
        const procesadasCategoria = procesar.mock.calls.length;
        await new Promise<void>((resolve, reject) => {
          productor.publish(
            'po.resultados.x',
            respuestaCategoria.name,
            Buffer.from(JSON.stringify(respuestaCategoria)),
            {
              persistent: true,
              contentType: 'application/json',
              userId: 'catalog_test',
              messageId: mensajeCategoria,
              correlationId,
            },
            (error) => (error ? reject(error) : resolve()),
          );
        });
        await esperar(() => procesar.mock.calls.length > procesadasCategoria);
        await procesar.mock.results[procesadasCategoria].value;
        expect(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM taxonomy.inbox WHERE message_id=$1',
              [mensajeCategoria],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id=$1 AND event_name='taxonomy.master.deactivated'",
              [operacionCategoria],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
        const canalConsumidor = Reflect.get(runtime, 'consumer') as Channel;
        const ack = vi.spyOn(canalConsumidor, 'ack');
        const recibidasAntes = procesar.mock.calls.length;
        await publicar();
        await esperar(() => procesar.mock.calls.length > recibidasAntes);
        await procesar.mock.results[recibidasAntes].value;
        await esperar(() => ack.mock.calls.length >= 1);
        await admin.query(
          "UPDATE taxonomy.brands SET estado='ACTIVO', taxonomy_version=0 WHERE id=$1",
          [entityInUse],
        );
        await expect(
          intentos.registrar({
            operationId: opInUse,
            correlationId,
            entityType: 'BRAND',
            entityId: entityInUse,
            version: 0,
          }),
        ).resolves.toBe('REGISTRADA');
        await esperar(
          async () =>
            (await canal.checkQueue('po.catalogo.q')).messageCount === 1,
        );
        const solicitudInUse = await canal.get('po.catalogo.q', {
          noAck: true,
        });
        if (!solicitudInUse) throw new Error('Falta solicitud IN_USE');
        const payloadInUse = {
          ...respuesta,
          message_id: messageInUse,
          operation_id: opInUse,
          causation_id: JSON.parse(solicitudInUse.content.toString())
            .message_id,
          data: {
            entity_type: 'BRAND',
            entity_id: entityInUse,
            version: 0,
            result: 'IN_USE',
          },
        };
        await new Promise<void>((resolve, reject) => {
          productor.publish(
            'po.resultados.x',
            payloadInUse.name,
            Buffer.from(JSON.stringify(payloadInUse)),
            {
              persistent: true,
              contentType: 'application/json',
              userId: 'catalog_test',
              messageId: messageInUse,
              correlationId,
            },
            (error) => (error ? reject(error) : resolve()),
          );
        });
        await esperar(
          async () =>
            (
              await admin.query(
                'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
                [opInUse],
              )
            ).rows[0].status === 'REJECTED',
        );
        await esperar(() => ack.mock.calls.length >= 2);
        expect(
          (
            await admin.query(
              'SELECT estado FROM taxonomy.brands WHERE id=$1',
              [entityInUse],
            )
          ).rows,
        ).toEqual([{ estado: 'ACTIVO' }]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id=$1 AND event_name='taxonomy.master.deactivation.rejected'",
              [opInUse],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
        await runtime.onModuleDestroy();
        runtime = undefined;
        expect((await canal.checkQueue('po.taxonomia.q')).messageCount).toBe(0);
        expect(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM taxonomy.inbox WHERE message_id=$1',
              [messageId],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id=$1 AND event_name='taxonomy.master.deactivated'",
              [operationId],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
      } finally {
        await admin.query(`GRANT INSERT ON taxonomy.inbox TO ${ROL_APP}`);
        await runtime?.onModuleDestroy();
        await catalog?.close().catch(() => undefined);
        await broker?.close().catch(() => undefined);
        rabbit.cerrar();
        await admin.query('DELETE FROM taxonomy.inbox WHERE message_id=$1', [
          mensajeCategoria,
        ]);
        await admin.query('DELETE FROM taxonomy.outbox WHERE operation_id=$1', [
          operacionCategoria,
        ]);
        await admin.query(
          'DELETE FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
          [operacionCategoria],
        );
        if (categoriaPublicada) {
          await admin.query(
            "DELETE FROM taxonomy.outbox WHERE payload->'data'->>'categoria_id' = $1",
            [categoriaPublicada],
          );
          await admin.query(
            'DELETE FROM taxonomy.category_seo WHERE categoria_id = $1',
            [categoriaPublicada],
          );
          await admin.query('DELETE FROM taxonomy.categories WHERE id = $1', [
            categoriaPublicada,
          ]);
        }
        await admin.query('DELETE FROM taxonomy.inbox WHERE message_id=$1', [
          mensajeAjeno,
        ]);
        await admin.query('DELETE FROM taxonomy.inbox WHERE message_id=$1', [
          messageInUse,
        ]);
        await admin.query('DELETE FROM taxonomy.outbox WHERE operation_id=$1', [
          opInUse,
        ]);
        await admin.query(
          'DELETE FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
          [opInUse],
        );
        await admin.query(
          "UPDATE taxonomy.brands SET estado='INACTIVO', taxonomy_version=0 WHERE id=$1",
          [entityInUse],
        );
        await admin.query('DELETE FROM taxonomy.inbox WHERE message_id=$1', [
          messageId,
        ]);
        await admin.query('DELETE FROM taxonomy.outbox WHERE operation_id=$1', [
          operationId,
        ]);
        await admin.query(
          'DELETE FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
          [operationId],
        );
        await admin.query(
          "UPDATE taxonomy.brands SET estado='ACTIVO', taxonomy_version=0 WHERE id=$1",
          [entityId],
        );
        vi.restoreAllMocks();
      }
    }, 90_000);

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
        const service = new DeactivationIntentService(database);
        await expect(service.recuperarVencidas()).resolves.toBe(1);
        expect(aviso).toHaveBeenCalledTimes(50);
        expect(aviso).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'taxonomy.deactivation.recovery_discrepancy',
            reason: 'ENTIDAD_AUSENTE',
            muestra_truncada: true,
          }),
        );
        const primeraMuestra = new Set(
          aviso.mock.calls.map(([entrada]) => entrada.operation_id),
        );
        aviso.mockClear();
        const momento = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(momento + 5 * 60 * 1000 + 1);
        await expect(service.recuperarVencidas()).resolves.toBe(0);
        expect(aviso).toHaveBeenCalledTimes(1);
        expect(primeraMuestra.has(aviso.mock.calls[0][0].operation_id)).toBe(
          false,
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
