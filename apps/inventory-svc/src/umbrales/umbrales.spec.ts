import { describe, it, expect, beforeEach } from 'vitest';
import { UmbralesService } from './umbrales.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import { DrizzleThresholdsRepository } from '../repositories/drizzle/drizzle-thresholds.repository.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';

describe('UmbralesService — umbral global y overrides por SKU (SPEC-015/016)', () => {
  let service: UmbralesService;
  let mockDb: InMemoryDatabaseMock;

  const skuExistente = 'NIK-REV7-NEG-41';
  const skuInexistente = 'SKU-QUE-NO-EXISTE';

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    const dbService = new DatabaseService();
    dbService.setCustomService(mockDb);
    service = new UmbralesService(
      dbService,
      new DrizzleThresholdsRepository(dbService),
    );
  });

  it('devuelve el umbral global por defecto y sin overrides al inicio', async () => {
    const res = await service.obtenerUmbrales();
    expect(res.umbralGlobal).toBe(5);
    expect(res.overrides).toEqual([]);
  });

  it('actualiza el umbral global y lo refleja en la consulta', async () => {
    const res = await service.actualizarUmbralGlobal(12);
    expect(res.umbralGlobal).toBe(12);

    const relectura = await service.obtenerUmbrales();
    expect(relectura.umbralGlobal).toBe(12);
    // Persistió una única fila global (sku_id/location_id nulos).
    expect(mockDb.thresholdOverrides).toHaveLength(1);
    expect(mockDb.thresholdOverrides[0].sku_id).toBeNull();
  });

  it('establece y elimina un override por SKU existente', async () => {
    const conOverride = await service.establecerUmbralSku(skuExistente, 3);
    expect(conOverride.overrides).toEqual([{ sku: skuExistente, umbral: 3 }]);

    await service.eliminarUmbralSku(skuExistente);
    const sinOverride = await service.obtenerUmbrales();
    expect(sinOverride.overrides).toEqual([]);
  });

  it('rechaza override para un SKU no registrado con 404 SKU_NO_ENCONTRADO', async () => {
    await expect(
      service.establecerUmbralSku(skuInexistente, 3),
    ).rejects.toMatchObject({
      problem: { status: 404, code: 'SKU_NO_ENCONTRADO' },
    });
  });

  it('rechaza eliminar el override de un SKU no registrado con 404', async () => {
    await expect(
      service.eliminarUmbralSku(skuInexistente),
    ).rejects.toBeInstanceOf(ProblemDetailsException);
  });

  it('rechaza un umbral no entero o negativo con 400 VALIDACION', async () => {
    await expect(service.actualizarUmbralGlobal(-1)).rejects.toMatchObject({
      problem: { status: 400, code: 'VALIDACION' },
    });
    await expect(service.actualizarUmbralGlobal(1.5)).rejects.toMatchObject({
      problem: { status: 400, code: 'VALIDACION' },
    });
  });
});
