import { describe, expect, it, vi } from 'vitest';
import { Database } from '../database.js';
import { DeactivationCheckService } from './deactivation-check.service.js';
import type { IdentidadBaja } from './deactivation-check.js';

const solicitud: IdentidadBaja = {
  operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  entityType: 'CATEGORY',
  entityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  version: 2,
};
const fila = {
  operation_id: solicitud.operationId,
  correlation_id: solicitud.correlationId,
  entity_type: solicitud.entityType,
  entity_id: solicitud.entityId,
  source_version: '2',
};

describe('DeactivationCheckService', () => {
  it('evalúa la respuesta usando la versión e identidad persistidas', async () => {
    const db = new Database();
    vi.spyOn(db, 'read').mockResolvedValue(fila);
    const servicio = new DeactivationCheckService(db);
    await expect(
      servicio.evaluar({ ...solicitud, result: 'CLEAR' }),
    ).resolves.toBe('EVALUAR_BAJA');
    await expect(
      servicio.evaluar({ ...solicitud, result: 'IN_USE' }),
    ).resolves.toBe('RECHAZAR_BAJA');
    await expect(
      servicio.evaluar({ ...solicitud, version: 1, result: 'CLEAR' }),
    ).resolves.toBe('IGNORAR');
    await expect(
      servicio.evaluar({
        ...solicitud,
        correlationId: 'otra',
        result: 'CLEAR',
      }),
    ).resolves.toBe('IGNORAR');
  });

  it('ignora operaciones no elegibles o sin versión durable', async () => {
    const db = new Database();
    const read = vi.spyOn(db, 'read');
    const servicio = new DeactivationCheckService(db);
    read
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...fila, source_version: null });
    await expect(
      servicio.evaluar({ ...solicitud, result: 'CLEAR' }),
    ).resolves.toBe('IGNORAR');
    await expect(
      servicio.evaluar({ ...solicitud, result: 'CLEAR' }),
    ).resolves.toBe('IGNORAR');
  });

  it('ignora un identificador de operación inválido antes de consultar', async () => {
    const db = new Database();
    const read = vi.spyOn(db, 'read');
    await expect(
      new DeactivationCheckService(db).evaluar({
        ...solicitud,
        operationId: 'invalido',
        result: 'CLEAR',
      }),
    ).resolves.toBe('IGNORAR');
    expect(read).not.toHaveBeenCalled();
  });
});
