import { PricingReadController } from './pricing-read.controller.js';
import { PricingReads } from './pricing-reads.js';
import { CommercialPrices } from './commercial-prices.js';
import { PricingHttpError } from './pricing-http.error.js';
import type { Response } from 'express';

describe('Read-only persisted Pricing import report', () => {
  const id = '10000000-0000-4000-8000-000000000001';
  function response() {
    return {
      type() {
        return this;
      },
      setHeader() {
        return this;
      },
      status() {
        return this;
      },
      send(value: string) {
        return value;
      },
    } as unknown as Response;
  }
  it('returns CSV with quoted persisted results and never exposes private storage metadata', async () => {
    const reads = {
      imported: vi.fn(async () => ({
        rows: [
          {
            row_id: 1,
            sku: 'A,"B"',
            status: 'FAILED',
            code: 'VALIDACION',
            report_uri: 'DO_NOT_LEAK',
          },
        ],
      })),
    };
    const controller = new PricingReadController(
      reads as unknown as PricingReads,
      {} as CommercialPrices,
    );
    const result = await controller.importReport(id, {}, response());
    expect(result).toBe(
      'row_id,sku,status,code\r\n"1","A,""B""","FAILED","VALIDACION"\r\n',
    );
    expect(String(result)).not.toContain('DO_NOT_LEAK');
    expect(reads.imported).toHaveBeenCalledExactlyOnceWith(id);
  });
  it('validates the identifier and query before querying persisted data', async () => {
    const reads = { imported: vi.fn() };
    const controller = new PricingReadController(
      reads as unknown as PricingReads,
      {} as CommercialPrices,
    );
    await expect(
      controller.importReport('invalid', {}, response()),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.importReport(id, { unexpected: 'true' }, response()),
    ).rejects.toMatchObject({ status: 400 });
    expect(reads.imported).not.toHaveBeenCalled();
  });
  it('preserves the contractual absent-import error without inventing a report', async () => {
    const reads = {
      imported: vi.fn(async () => {
        throw new PricingHttpError(404, 'LOTE_NO_ENCONTRADO');
      }),
    };
    const controller = new PricingReadController(
      reads as unknown as PricingReads,
      {} as CommercialPrices,
    );
    await expect(
      controller.importReport(id, {}, response()),
    ).rejects.toMatchObject({ status: 404, code: 'LOTE_NO_ENCONTRADO' });
  });
});
