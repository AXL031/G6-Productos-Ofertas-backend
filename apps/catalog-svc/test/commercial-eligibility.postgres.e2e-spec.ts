import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { Database } from '../src/database.js';
import { PostgresCatalogRepository } from '../src/postgres-catalog.repository.js';
import {
  CATALOG_READ_DEMO,
  CATALOG_MARKETPLACE_PREVIEW,
} from '../src/catalog-read-demo.js';

describe.skipIf(process.env.G6_READONLY_INTEGRATION !== 'catalog')(
  'Catalog global eligibility on configured PostgreSQL (read only)',
  () => {
    it('reads official tables and preserves authentication without candidate eligibility tables', async () => {
      const app = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CATALOG_READ_DEMO)
        .useValue({ enabled: false })
        .overrideProvider(CATALOG_MARKETPLACE_PREVIEW)
        .useValue(false)
        .compile()
        .then((module) => module.createNestApplication());
      try {
        await app.init();
        await app.get(Database).verifyIdentity();
        const repository = app.get(PostgresCatalogRepository);
        const query = {
          canal: 'MARKETPLACE' as const,
          pagina: 1,
          tamanio: 1,
          orden: 'NOMBRE_ASC' as const,
        };
        const page = await repository.listCandidates(query);
        expect(page.total).toBeGreaterThanOrEqual(page.items.length);
        for (const canal of ['CHATBOT', 'RETAIL', 'VENTAS'] as const) {
          expect(await repository.listCandidates({ ...query, canal })).toEqual(
            page,
          );
        }
        for (const path of [
          '/api/v1/productos?canal=MARKETPLACE',
          '/api/v1/productos/por-slug/integration-probe?canal=MARKETPLACE',
        ]) {
          const response = await request(app.getHttpServer())
            .get(path)
            .expect(401);
          expect(response.body.code).toBe('TOKEN_INVALIDO');
        }
        process.stdout.write(
          JSON.stringify({
            evidence: 'catalog-global-eligibility-postgres',
            outcome: 'official-select-succeeded-unauthenticated-endpoints-401',
            writes: 0,
          }) + '\n',
        );
      } finally {
        await app.close();
      }
    }, 30000);
  },
);
