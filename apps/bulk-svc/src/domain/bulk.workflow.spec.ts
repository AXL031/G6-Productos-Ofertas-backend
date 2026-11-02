import { describe, expect, it } from 'vitest';
import { BulkDomainError } from './bulk.errors.js';
import {
  assertRowCompletion,
  assertStepTransition,
  isBatchComplete,
  isInventoryStepComplete,
  nextDomains,
} from './bulk.workflow.js';

describe('bulk workflow rules', () => {
  it('blocks dependent work until Catalog confirms and never re-applies confirmed domains', () => {
    expect(
      nextDomains({
        required: ['CATALOGO', 'PRICING', 'INVENTARIO'],
        confirmed: [],
      }),
    ).toEqual(['CATALOGO']);
    expect(
      nextDomains({
        required: ['CATALOGO', 'PRICING', 'INVENTARIO'],
        confirmed: ['CATALOGO', 'PRICING'],
      }),
    ).toEqual(['INVENTARIO']);
    expect(
      nextDomains({
        required: ['CATALOGO', 'PRICING'],
        confirmed: [],
        failed: 'CATALOGO',
      }),
    ).toEqual([]);
  });

  it('preserves confirmed domain and row completion invariants', () => {
    expect(() => assertStepTransition('COMPLETED', 'PENDING')).toThrow(
      BulkDomainError,
    );
    expect(() =>
      assertRowCompletion(['CATALOGO', 'INVENTARIO'], ['CATALOGO']),
    ).toThrow(BulkDomainError);
    expect(() => assertRowCompletion(['CATALOGO'], ['CATALOGO'])).not.toThrow();
    expect(() =>
      assertRowCompletion(
        ['CATALOGO', 'PRICING', 'INVENTARIO'],
        ['CATALOGO', 'INVENTARIO'],
      ),
    ).toThrow(BulkDomainError);
  });

  it('allows a completed batch to include failed rows once all rows are terminal', () => {
    expect(
      isBatchComplete([{ status: 'COMPLETED' }, { status: 'FAILED' }]),
    ).toBe(true);
    expect(isBatchComplete([{ status: 'FAILED' }, { status: 'PENDING' }])).toBe(
      false,
    );
  });

  it('waits for every vendible SKU and required stock adjustment before completing Inventory', () => {
    expect(
      isInventoryStepComplete({
        vendibleSkuCount: 2,
        confirmedSkuInitializations: 1,
        stockAdjustmentRequired: false,
        stockAdjustmentConfirmed: false,
      }),
    ).toBe(false);
    expect(
      isInventoryStepComplete({
        vendibleSkuCount: 2,
        confirmedSkuInitializations: 2,
        stockAdjustmentRequired: true,
        stockAdjustmentConfirmed: false,
      }),
    ).toBe(false);
    expect(
      isInventoryStepComplete({
        vendibleSkuCount: 2,
        confirmedSkuInitializations: 2,
        stockAdjustmentRequired: true,
        stockAdjustmentConfirmed: true,
      }),
    ).toBe(true);
  });
});
