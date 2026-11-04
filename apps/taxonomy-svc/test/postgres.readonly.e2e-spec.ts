import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createServer } from 'node:net';
import { iniciarTaxonomySvc } from '../src/bootstrap.js';
import { TaxonomySvcModule } from '../src/taxonomy-svc.module.js';
import { Database } from '../src/database.js';
import { TAXONOMY_REPOSITORY } from '../src/taxonomy.repository.js';
import { PostgresTaxonomyRepository } from '../src/postgres-taxonomy.repository.js';
import { TaxonomyAuthGuard } from '../src/taxonomy-auth.js';

describe.skipIf(process.env.G6_READONLY_INTEGRATION !== 'taxonomy')(
  'Taxonomy real PostgreSQL SELECT',
  () => {
    let app: INestApplication;
    let db: Database;
    beforeAll(async () => {
      app = (
        await Test.createTestingModule({
          imports: [TaxonomySvcModule],
        })
          .overrideGuard(TaxonomyAuthGuard)
          .useValue({ canActivate: () => true })
          .compile()
      ).createNestApplication();
      await app.init();
      db = app.get(Database);
      await db.verifyIdentity();
    }, 30000);
    afterAll(async () => {
      await app?.close();
    });
    it('Nest → repository → Drizzle → own PostgreSQL; exact active-only projection', async () => {
      const repo = app.get<PostgresTaxonomyRepository>(TAXONOMY_REPOSITORY);
      expect(await repo.readiness()).toBe(true);
      for (const [path, key, table] of [
        ['categorias', 'categories', 'categories'],
        ['marcas', 'brands', 'brands'],
      ]) {
        const response = await request(app.getHttpServer())
          .get('/api/v1/' + path)
          .expect(200);
        const rows: Record<string, unknown>[] = response.body[key];
        const count = await db.read((d) =>
          d.execute(
            sql`SELECT count(*)::integer AS n FROM ${sql.identifier('taxonomy')}.${sql.identifier(table)}
          WHERE estado = ${'ACTIVO'}`,
          ),
        );
        expect(rows.length === count.rows[0].n).toBe(true);
        expect(rows.every((r) => r.status === 'ACTIVA')).toBe(true);
        const allowed =
          path === 'categorias'
            ? ['categoria_id', 'parent_id', 'name', 'status']
            : [
                'marca_id',
                'name',
                'description',
                'logo_url',
                'country_code',
                'status',
              ];
        expect(
          rows.every((r) => Object.keys(r).every((k) => allowed.includes(k))),
        ).toBe(true);
      }
    }, 30000);
    it('returns sanitized validation error with real provider installed', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/categorias?estado=INACTIVO')
        .expect(400);
      expect(response.body.code === 'VALIDACION').toBe(true);
    });
    it('arranca con el entorno explícito y comprueba liveness y readiness real', async () => {
      const server = createServer();
      await new Promise<void>((resolve, reject) =>
        server.once('error', reject).listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Puerto no disponible');
      const port = address.port;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      const env = {
        ...process.env,
        NODE_ENV: 'test',
        TAXONOMY_SVC_PORT: String(port),
      };
      const previous = process.env.G6_CONNECT_HOST;
      const previousHost = process.env.PGHOST;
      const previousUrl = process.env.DATABASE_URL;
      process.env.G6_CONNECT_HOST = '127.0.0.2';
      delete process.env.PGHOST;
      delete process.env.DATABASE_URL;
      try {
        const started = await iniciarTaxonomySvc({ env });
        try {
          await request(started.app.getHttpServer()).get('/health').expect(200);
          await request(started.app.getHttpServer())
            .get('/health/readiness')
            .expect(200);
          await request(started.app.getHttpServer())
            .get('/api/v1/categorias')
            .expect(401);
          await request(started.app.getHttpServer())
            .get('/api/v1/marcas')
            .expect(401);
          await started.app.get(Database).onModuleDestroy();
          await request(started.app.getHttpServer()).get('/health').expect(200);
          await request(started.app.getHttpServer())
            .get('/health/readiness')
            .expect(503);
        } finally {
          await started.app.close();
        }
      } finally {
        if (previous === undefined) delete process.env.G6_CONNECT_HOST;
        else process.env.G6_CONNECT_HOST = previous;
        if (previousHost === undefined) delete process.env.PGHOST;
        else process.env.PGHOST = previousHost;
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
      }
    }, 30000);
  },
);
