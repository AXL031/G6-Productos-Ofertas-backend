import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { PriceRuleError, type PriceErrorCode } from '../domain/price.js';
import { PricingHttpFilter } from './pricing-http.error.js';

describe('Estados HTTP contractuales de Pricing', () => {
  it.each<[PriceErrorCode, number]>([
    ['PRECIO_INVALIDO', 422],
    ['OFERTA_INVALIDA', 422],
    ['ACCION_OFERTA_INVALIDA', 422],
    ['SCOPE_PRECIO_INVALIDO', 422],
    ['VALIDACION', 400],
    ['MOTIVO_CAMBIO_REQUERIDO', 400],
    ['PRECIO_NO_ENCONTRADO', 404],
    ['VERSION_CONFLICT', 409],
    ['VIGENCIA_SUPERPUESTA', 409],
    ['IDEMPOTENCY_CONFLICT', 409],
  ])('%s devuelve %s conservando Problem Details', (code, status) => {
    const correlation = '74ed2f19-7e70-4915-a6f6-bbc691b82587';
    const response = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      json: vi.fn(),
      getHeader: vi.fn().mockReturnValue(correlation),
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    new PricingHttpFilter().catch(new PriceRuleError(code), host);
    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.type).toHaveBeenCalledWith('application/problem+json');
    expect(response.json).toHaveBeenCalledWith({
      title: code,
      status,
      code,
      correlationId: correlation,
    });
  });
});
