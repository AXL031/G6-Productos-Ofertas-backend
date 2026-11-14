import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { Database } from '../src/database.js';
import { PostgresCatalogRepository } from '../src/postgres-catalog.repository.js';
import type { ProductQuery } from '../src/commercial.types.js';
import {
  variants,
  productImages,
  variantImages,
  productAttributes,
  variantAttributes,
} from '../src/catalog.schema.js';

describe.skipIf(process.env.G6_READONLY_INTEGRATION !== 'catalog')(
  'Catalog real PostgreSQL SELECT (internal candidates)',
  () => {
    let app: INestApplication;
    let db: Database;
    let repo: PostgresCatalogRepository;
    const query: ProductQuery = {
      canal: 'MARKETPLACE',
      pagina: 1,
      tamanio: 100,
      orden: 'NOMBRE_ASC',
    };
    beforeAll(async () => {
      app = (
        await Test.createTestingModule({ imports: [AppModule] }).compile()
      ).createNestApplication();
      await app.init();
      db = app.get(Database);
      repo = app.get(PostgresCatalogRepository);
      await db.verifyIdentity();
    }, 30000);
    afterAll(async () => {
      await app?.close();
    });
    it('reads variant/image/attribute mappings against real own tables even without active products', async () => {
      await db.read(async (d) => {
        await d
          .select({
            id: variants.id,
            sku: variants.sku,
            estado: variants.estado,
          })
          .from(variants)
          .limit(1);
        await d
          .select({ url: productImages.url, position: productImages.posicion })
          .from(productImages)
          .limit(1);
        await d
          .select({ url: variantImages.url, position: variantImages.posicion })
          .from(variantImages)
          .limit(1);
        await d
          .select({
            name: productAttributes.nombre_snapshot,
            value: productAttributes.valor,
          })
          .from(productAttributes)
          .limit(1);
        await d
          .select({
            name: variantAttributes.nombre_snapshot,
            identifying: variantAttributes.es_identificador,
          })
          .from(variantAttributes)
          .limit(1);
      });
    }, 30000);
    it('checks the four demo read grants against the real Catalog schema', async () => {
      await expect(repo.checkReadinessAccess()).resolves.toBeUndefined();
    }, 30000);
    it('executes read-only paged queries, detail and own-schema composition', async () => {
      const page = await repo.listCandidates(query);
      const count = await db.read((d) =>
        d.execute(sql`SELECT count(*)::integer AS n
      FROM catalog.products WHERE estado = ${'ACTIVO'}
      AND (NOT tiene_variantes OR EXISTS (SELECT 1 FROM catalog.variants v
        WHERE v.product_id = catalog.products.id AND v.estado = ${'ACTIVA'}))`),
      );
      expect(page.total === count.rows[0].n).toBe(true);
      const allowed = [
        'product_id',
        'slug',
        'name',
        'description',
        'categoria_id',
        'tipo_producto_id',
        'marca_id',
        'tiene_variantes',
        'sku_base',
        'images',
        'attributes',
      ];
      expect(
        page.items.every((r) =>
          Object.keys(r).every((k) => allowed.includes(k)),
        ),
      ).toBe(true);
      const rows = await db.read((d) =>
        d.execute(sql`SELECT slug FROM catalog.products
      WHERE estado = ${'ACTIVO'} AND (NOT tiene_variantes OR EXISTS (
        SELECT 1 FROM catalog.variants v WHERE v.product_id = catalog.products.id
        AND v.estado = ${'ACTIVA'})) ORDER BY id LIMIT 1`),
      );
      process.stdout.write(
        JSON.stringify({
          evidence: 'catalog-readonly-observation',
          activeProducts: page.total,
          detailExercised: rows.rows.length > 0,
        }) + '\n',
      );
      if (rows.rows.length) {
        const detail = await repo.findCandidateBySlug(
          String(rows.rows[0].slug),
        );
        expect(detail !== null).toBe(true);
        expect(
          detail?.variants.every((v) => !('estado' in v) && !('status' in v)),
        ).toBe(true);
      }
      expect(
        (await repo.findCandidateBySlug('missing-' + randomUUID())) === null,
      ).toBe(true);
    }, 30000);
    it('parameterizes search/filter input and applies eligibility before total/paging', async () => {
      const noMatches = await repo.listCandidates({
        ...query,
        q: "'; SELECT private --",
      });
      expect(noMatches.total === 0).toBe(true);
      const noCategory = await repo.listCandidates({
        ...query,
        categoriaId: randomUUID(),
        marcaId: randomUUID(),
      });
      expect(noCategory.total === 0).toBe(true);
      const inactive = await repo.listCandidates({
        ...query,
        estado: 'INACTIVO',
      });
      expect(inactive.total).toBeGreaterThanOrEqual(inactive.items.length);
    }, 30000);
    it('keeps real PostgreSQL connectivity distinct from commercial readiness', async () => {
      for (const path of [
        '/api/v1/productos?canal=MARKETPLACE',
        '/api/v1/productos/por-slug/missing?canal=MARKETPLACE',
      ]) {
        const response = await request(app.getHttpServer())
          .get(path)
          .expect(401);
        expect(response.body.code === 'TOKEN_INVALIDO').toBe(true);
      }
      await request(app.getHttpServer()).get('/health').expect(200);
    });
  },
);
