import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DisponibilidadService } from './disponibilidad.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';

import { DrizzleStockBalanceRepository } from '../repositories/drizzle/drizzle-stock-balance.repository.js';
import { DrizzleCommercialRoutesRepository } from '../repositories/drizzle/drizzle-commercial-routes.repository.js';

describe('DisponibilidadService — Consultas de Stock y D-INV-01', () => {
  let disponibilidadService: DisponibilidadService;
  let mockDb: InMemoryDatabaseMock;
  let dbService: DatabaseService;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const locMiraflores = 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485';

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    dbService = new DatabaseService();
    dbService.setCustomService(mockDb);

    const stockBalanceRepo = new DrizzleStockBalanceRepository(dbService);
    const commercialRoutesRepo = new DrizzleCommercialRoutesRepository(
      dbService,
    );
    disponibilidadService = new DisponibilidadService(
      stockBalanceRepo,
      commercialRoutesRepo,
    );
  });

  describe('Consulta autoritativa detallada (GET /api/v1/inventario/disponibilidad)', () => {
    it('debe calcular available y clasificar estados de stock correctamente', async () => {
      // NIK-REV7-NEG-41 tiene 18 en Lurín y 4 en Miraflores
      // Configuramos un saldo con 0 para probar AGOTADO
      mockDb.stockBalance.push({
        sku_id: 'SKU-ZERO',
        location_id: locLurin,
        on_hand: 5,
        reserved: 5,
        blocked: 0,
        available: 0,
        stock_version: 1,
      });

      // Configuramos un saldo con stock bajo (3 unidades con umbral 5)
      mockDb.stockBalance.push({
        sku_id: 'SKU-LOW',
        location_id: locLurin,
        on_hand: 3,
        reserved: 0,
        blocked: 0,
        available: 3,
        stock_version: 1,
      });

      const res = await disponibilidadService.consultarDisponibilidad(
        ['NIK-REV7-NEG-41', 'SKU-ZERO', 'SKU-LOW'],
        locLurin,
      );

      expect(res.items).toBeDefined();
      expect(res.items.length).toBeGreaterThanOrEqual(3);

      const itemZero = res.items.find((i) => i.sku === 'SKU-ZERO')!;
      expect(itemZero.available).toBe(0);
      expect(itemZero.status).toBe('AGOTADO');

      const itemLow = res.items.find((i) => i.sku === 'SKU-LOW')!;
      expect(itemLow.available).toBe(3);
      expect(itemLow.status).toBe('STOCK_BAJO');

      const itemLurin = res.items.find(
        (i) => i.sku === 'NIK-REV7-NEG-41' && i.location_id === locLurin,
      )!;
      expect(itemLurin.available).toBe(18);
      expect(itemLurin.status).toBe('DISPONIBLE');
    });

    it('debe filtrar por location_id cuando se especifica', async () => {
      const res = await disponibilidadService.consultarDisponibilidad(
        ['NIK-REV7-NEG-41'],
        locMiraflores,
      );

      expect(res.items).toHaveLength(1);
      expect(res.items[0].location_id).toBe(locMiraflores);
      expect(res.items[0].on_hand).toBe(4);
    });
  });

  describe('Verificación comercial de cantidades D-INV-01 (POST /comercial/verificar)', () => {
    it('debe responder INDETERMINADO si no existe ruta unívoca de cumplimiento', async () => {
      // Sin rutas comerciales configuradas
      const res = await disponibilidadService.verificarCantidadComercial({
        channel_id: 'MARKETPLACE',
        fulfillment: {
          mode: 'ENVIO_DOMICILIO',
          fulfillment_ref: 'REF-SIN-RUTA',
        },
        lines: [{ sku: 'NIK-REV7-NEG-41', quantity: 2 }],
      });

      expect(res.binding).toBe(false);
      expect(res.items).toHaveLength(1);
      expect(res.items[0].result).toBe('INDETERMINADO');
      expect(res.items[0].reason_code).toBe('RUTA_CUMPLIMIENTO_NO_RESUELTA');
    });

    it('debe responder SUFICIENTE o INSUFICIENTE cuando la ruta está unívocamente resuelta', async () => {
      // Configuramos una ruta activa hacia el almacén de Lurín
      mockDb.commercialRoutes.push({
        id: 'route-1',
        channel_id: 'MARKETPLACE',
        mode: 'ENVIO_DOMICILIO',
        fulfillment_ref: 'LIMA_METROPOLITANA',
        location_id: locLurin,
        active: true,
      });

      // Lurín tiene 18 de NIK-REV7-NEG-41 y 2 de PUM-LIMIT-01
      const res = await disponibilidadService.verificarCantidadComercial({
        channel_id: 'MARKETPLACE',
        fulfillment: {
          mode: 'ENVIO_DOMICILIO',
          fulfillment_ref: 'LIMA_METROPOLITANA',
        },
        lines: [
          { sku: 'NIK-REV7-NEG-41', quantity: 5 }, // Suficiente (18 >= 5)
          { sku: 'PUM-LIMIT-01', quantity: 10 }, // Insuficiente (2 < 10)
        ],
      });

      expect(res.items).toHaveLength(2);

      const item1 = res.items.find((i) => i.sku === 'NIK-REV7-NEG-41')!;
      expect(item1.result).toBe('SUFICIENTE');
      expect(item1.reason_code).toBeNull();

      const item2 = res.items.find((i) => i.sku === 'PUM-LIMIT-01')!;
      expect(item2.result).toBe('INSUFICIENTE');
      expect(item2.reason_code).toBe('STOCK_INSUFICIENTE');
    });
  });

  describe('Disponibilidad comercial informativa (GET /disponibilidad/comercial)', () => {
    it('responde INDETERMINADO cuando no existe ruta única de cumplimiento', async () => {
      const res = await disponibilidadService.consultarDisponibilidadComercial(
        ['NIK-REV7-NEG-41'],
        'MARKETPLACE',
      );

      expect(res.items).toEqual([
        { sku: 'NIK-REV7-NEG-41', status: 'INDETERMINADO' },
      ]);
    });

    it('proyecta únicamente sku y status desde la ubicación resuelta', async () => {
      mockDb.commercialRoutes.push({
        id: 'route-comercial',
        channel_id: 'MARKETPLACE',
        mode: 'ENVIO_DOMICILIO',
        fulfillment_ref: 'LIMA_METROPOLITANA',
        location_id: locLurin,
        active: true,
      });

      const res = await disponibilidadService.consultarDisponibilidadComercial(
        ['NIK-REV7-NEG-41', 'PUM-LIMIT-01', 'SKU-INEXISTENTE'],
        'MARKETPLACE',
      );

      // Sin saldo registrado no se puede afirmar que un SKU exista y esté agotado (CA-46).
      expect(res.items).toEqual([
        { sku: 'NIK-REV7-NEG-41', status: 'DISPONIBLE' },
        { sku: 'PUM-LIMIT-01', status: 'STOCK_BAJO' },
        { sku: 'SKU-INEXISTENTE', status: 'INDETERMINADO' },
      ]);
      for (const item of res.items) {
        expect(Object.keys(item).sort()).toEqual(['sku', 'status']);
      }
    });

    it('deduplica SKUs y respeta overrides de umbral por SKU', async () => {
      mockDb.commercialRoutes.push({
        id: 'route-comercial',
        channel_id: 'MARKETPLACE',
        mode: 'ENVIO_DOMICILIO',
        fulfillment_ref: 'LIMA_METROPOLITANA',
        location_id: locLurin,
        active: true,
      });
      mockDb.thresholdOverrides.push({
        id: 'th-nik',
        sku_id: 'NIK-REV7-NEG-41',
        location_id: null,
        umbral_efectivo: 20,
      });

      const res = await disponibilidadService.consultarDisponibilidadComercial(
        ['NIK-REV7-NEG-41', 'NIK-REV7-NEG-41'],
        'MARKETPLACE',
      );

      expect(res.items).toEqual([
        { sku: 'NIK-REV7-NEG-41', status: 'STOCK_BAJO' },
      ]);
    });

    it('rechaza canales fuera del enum comercial', async () => {
      await expect(
        disponibilidadService.consultarDisponibilidadComercial(
          ['NIK-REV7-NEG-41'],
          'VENTAS' as never,
        ),
      ).rejects.toMatchObject({ problem: { code: 'VALIDACION' } });
    });

    it('rechaza listas vacías y mayores a 100 SKUs', async () => {
      await expect(
        disponibilidadService.consultarDisponibilidadComercial(
          [],
          'MARKETPLACE',
        ),
      ).rejects.toThrow();

      await expect(
        disponibilidadService.consultarDisponibilidadComercial(
          Array.from({ length: 101 }, (_, i) => `SKU-${i}`),
          'MARKETPLACE',
        ),
      ).rejects.toThrow();
    });
  });

  describe('Regresiones de la política D-INV-01 (#25)', () => {
    const sku = 'NIK-REV7-NEG-41';
    const request = (
      mode = 'ENVIO_DOMICILIO',
      ref: string | null = 'LIMA',
    ) => ({
      channel_id: 'MARKETPLACE' as const,
      fulfillment: { mode, fulfillment_ref: ref },
      lines: [{ sku, quantity: 2 }],
    });

    beforeEach(() => {
      mockDb.commercialRoutes.push({
        id: 'route-lurin',
        channel_id: 'MARKETPLACE',
        mode: 'ENVIO_DOMICILIO',
        fulfillment_ref: 'LIMA',
        location_id: locLurin,
        active: true,
      });
    });

    it('no usa la ruta de otra modalidad cuando falta la referencia', async () => {
      const res = await disponibilidadService.verificarCantidadComercial(
        request('RETIRO_TIENDA', null),
      );
      expect(res.items[0].result).toBe('INDETERMINADO');
    });

    it('sin referencia resuelve únicamente la modalidad solicitada', async () => {
      mockDb.commercialRoutes.push({
        id: 'route-retiro',
        channel_id: 'MARKETPLACE',
        mode: 'RETIRO_TIENDA',
        fulfillment_ref: 'TIENDA',
        location_id: locMiraflores,
        active: true,
      });
      const res = await disponibilidadService.verificarCantidadComercial(
        request('ENVIO_DOMICILIO', null),
      );
      expect(res.items[0].result).toBe('SUFICIENTE');
    });

    it('no sustituye una referencia desconocida por la única ruta del canal', async () => {
      const res = await disponibilidadService.verificarCantidadComercial(
        request('ENVIO_DOMICILIO', 'OTRA'),
      );
      expect(res.items[0].result).toBe('INDETERMINADO');
    });

    it('no suma ubicaciones ni elige una arbitraria ante un mapeo ambiguo', async () => {
      mockDb.commercialRoutes.push({
        ...mockDb.commercialRoutes[0],
        id: 'route-ambigua',
        location_id: locMiraflores,
      });
      const get = await disponibilidadService.consultarDisponibilidadComercial(
        [sku],
        'MARKETPLACE',
      );
      const post =
        await disponibilidadService.verificarCantidadComercial(request());
      expect(get.items[0].status).toBe('INDETERMINADO');
      expect(post.items[0].result).toBe('INDETERMINADO');
    });

    it('descarta rutas inactivas y ubicaciones deshabilitadas', async () => {
      mockDb.commercialRoutes[0].active = false;
      expect(
        (await disponibilidadService.verificarCantidadComercial(request()))
          .items[0].result,
      ).toBe('INDETERMINADO');
      mockDb.commercialRoutes[0].active = true;
      mockDb.locations.find((location) => location.id === locLurin)!.active =
        false;
      expect(
        (await disponibilidadService.verificarCantidadComercial(request()))
          .items[0].result,
      ).toBe('INDETERMINADO');
      expect(
        (
          await disponibilidadService.consultarDisponibilidadComercial(
            [sku],
            'MARKETPLACE',
          )
        ).items[0].status,
      ).toBe('INDETERMINADO');
    });

    it('distingue un saldo cero de la ausencia de información sobre el SKU', async () => {
      mockDb.stockBalance.find(
        (balance) => balance.sku_id === sku && balance.location_id === locLurin,
      )!.reserved = 18;
      expect(
        (
          await disponibilidadService.consultarDisponibilidadComercial(
            [sku, 'DESCONOCIDO'],
            'MARKETPLACE',
          )
        ).items,
      ).toEqual([
        { sku, status: 'AGOTADO' },
        { sku: 'DESCONOCIDO', status: 'INDETERMINADO' },
      ]);
      const input = request();
      input.lines = [{ sku: 'DESCONOCIDO', quantity: 1 }];
      expect(
        (await disponibilidadService.verificarCantidadComercial(input)).items[0]
          .result,
      ).toBe('INDETERMINADO');
    });

    it('evalúa la demanda completa de un SKU repetido sin reservar unidades', async () => {
      const input = request();
      input.lines = [
        { sku, quantity: 10 },
        { sku, quantity: 10 },
      ];
      const res = await disponibilidadService.verificarCantidadComercial(input);
      expect(res.items.map((item) => item.result)).toEqual([
        'INSUFICIENTE',
        'INSUFICIENTE',
      ]);
    });

    it('GET y POST no modifican saldos, reservas, operaciones, Kardex ni Outbox', async () => {
      const state = () =>
        structuredClone({
          stock: mockDb.stockBalance,
          reservations: mockDb.reservations,
          operations: mockDb.operations,
          kardex: mockDb.kardex,
          outbox: mockDb.outbox,
        });
      const before = state();
      const transaction = vi.spyOn(mockDb, 'transaction');
      const res =
        await disponibilidadService.verificarCantidadComercial(request());
      await disponibilidadService.consultarDisponibilidadComercial(
        [sku],
        'MARKETPLACE',
      );
      expect(res.binding).toBe(false);
      expect(Object.keys(res.items[0]).sort()).toEqual(
        ['sku', 'requested_quantity', 'result', 'reason_code'].sort(),
      );
      expect(transaction).not.toHaveBeenCalled();
      expect(state()).toEqual(before);
    });

    it.each([
      null,
      {},
      { sku },
      { sku, quantity: 0 },
      { sku, quantity: 1.5 },
      { sku, quantity: '2' },
      { sku, quantity: 2, location_id: locLurin },
    ])('rechaza líneas malformadas con 400 VALIDACION: %j', async (line) => {
      const input = { ...request(), lines: [line] };
      await expect(
        disponibilidadService.verificarCantidadComercial(input as never),
      ).rejects.toMatchObject({ problem: { status: 400, code: 'VALIDACION' } });
    });
  });
});
