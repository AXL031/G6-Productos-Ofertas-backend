import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { ADMIN_REFERENCES } from '../domain/admin-references.js';
import { PromotionsPersistence } from '../infrastructure/persistence/promotions-persistence.js';
import { PromotionsWriteService } from './write-service.js';

it('rechaza una identidad ajena antes de confirmar la desactivación', async () => {
  const expected = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const promotions = { lock: vi.fn(), update: vi.fn() };
  const queries = {
    promotion: vi
      .fn()
      .mockResolvedValueOnce({ id: expected })
      .mockResolvedValueOnce({ id: other }),
  };
  const commit = vi.fn();
  const transaction = async (
    run: (value: {
      promotions: typeof promotions;
      queries: typeof queries;
    }) => Promise<unknown>,
  ) => {
    const result = await run({ promotions, queries });
    commit();
    return result;
  };
  const module = await Test.createTestingModule({
    providers: [
      PromotionsWriteService,
      { provide: PromotionsPersistence, useValue: { transaction } },
      { provide: ADMIN_REFERENCES, useValue: {} },
    ],
  }).compile();
  try {
    const request = { params: { promocionId: expected } } as Request;
    await expect(
      module
        .get(PromotionsWriteService)
        .execute('desactivarPromocion', request),
    ).rejects.toThrow('INVALID_WRITE_RESPONSE_IDENTITY');
    expect(promotions.update).toHaveBeenCalledWith(expected, {
      state: 'INACTIVO',
    });
    expect(commit).not.toHaveBeenCalled();
  } finally {
    await module.close();
  }
});
