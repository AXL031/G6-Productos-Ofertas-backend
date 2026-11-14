import { randomUUID } from 'node:crypto';
import { readPostgresSettings } from '../src/database.js';
import { CatalogGatewayHarness } from './support/catalog-gateway-harness.js';

describe.runIf(process.env.CATALOG_H4_NATIVE_POSTGRES === '1')(
  'H4 Catalog administrative reads with disposable PostgreSQL TLS',
  () => {
    const harness = new CatalogGatewayHarness();
    beforeAll(async () => {
      if (
        process.env.PGDATABASE !== 'h4_catalog_isolated' ||
        process.env.PGHOST !== 'localhost' ||
        process.env.G6_CONNECT_HOST !== '127.0.0.1'
      )
        throw new Error('Expected the H4 isolated loopback database');
      await harness.start(readPostgresSettings(process.env));
    }, 90000);
    afterAll(() => harness.close(), 15000);

    it('creates, lists, reads and updates a draft while isolating it from Marketplace', async () => {
      const sku = 'H4-NATIVE-' + randomUUID();
      const manager = harness.token();
      const created = await harness.call(
        'POST',
        '/productos',
        {
          nombre: 'H4 native fixture',
          descripcion: 'Borrador aislado',
          categoriaId: 'category-fixture',
          tipoProductoId: 'type-fixture',
          marcaId: 'brand-fixture',
          skuBase: sku,
          tieneVariantes: false,
          precioBaseInicial: 20,
          imagenes: [{ url: 'https://example.test/product' }],
          perfilFisico: {
            pesoKg: 1,
            dimensionesCm: { largo: 10, ancho: 20, alto: 30 },
          },
        },
        manager,
      );
      expect(created.status).toBe(201);
      const productId = String(created.body.product_id);
      const adminPath = '/productos/administracion/' + productId;
      const detail = await harness.call('GET', adminPath, undefined, manager);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        productId,
        skuBase: sku,
        estado: 'BORRADOR',
        catalogVersion: created.body.catalog_version,
        perfilFisico: { pesoKg: 1 },
        imagenes: [{ url: 'https://example.test/product' }],
      });
      const list = await harness.call(
        'GET',
        '/productos/administracion?estado=BORRADOR&q=' +
          encodeURIComponent(sku),
        undefined,
        manager,
      );
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({
        items: [{ productId, catalogVersion: detail.body.catalogVersion }],
        meta: { pagina: 1, tamanio: 20, total: 1, totalPaginas: 1 },
      });
      const literal = await harness.call(
        'GET',
        '/productos/administracion?q=_',
        undefined,
        manager,
      );
      expect(literal.status).toBe(200);
      expect(literal.body).toMatchObject({ items: [], meta: { total: 0 } });
      const updated = await harness.call(
        'PATCH',
        '/productos/' + productId,
        {
          descripcion: 'Borrador actualizado',
          catalogVersion: detail.body.catalogVersion,
        },
        manager,
      );
      expect(updated.status).toBe(200);
      const reread = await harness.call('GET', adminPath, undefined, manager);
      expect(reread.body).toMatchObject({
        productId,
        descripcion: 'Borrador actualizado',
        catalogVersion: updated.body.catalog_version,
      });
      const buyer = harness.token({
        tipo: 'servicio',
        sub: 'modulo-marketplace',
        scope: 'catalogo:leer',
        roles: undefined,
      });
      expect(
        (await harness.call('GET', adminPath, undefined, buyer)).status,
      ).toBe(403);
      expect(
        (
          await harness.call(
            'GET',
            '/productos/' + productId + '?canal=MARKETPLACE',
            undefined,
            buyer,
          )
        ).status,
      ).toBe(404);
    });
  },
);
