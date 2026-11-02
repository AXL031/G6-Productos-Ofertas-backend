import { HttpException, type ArgumentsHost } from '@nestjs/common';
import { CatalogPersistenceError } from './database-errors.js';
import { ProblemFilter } from './problem.filter.js';

describe('ProblemFilter persistence status mapping', () => {
  function responseFor(error: unknown) {
    const response = {
      status: vi.fn(),
      type: vi.fn(),
      set: vi.fn(),
      json: vi.fn(),
      getHeader: vi.fn().mockReturnValue(undefined),
    };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    response.set.mockReturnValue(response);
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: {} }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    new ProblemFilter().catch(error, host);
    return response;
  }

  it.each([
    [409, 'VERSION_CONFLICT'],
    [409, 'SKU_DUPLICADO'],
    [409, 'COMBINACION_DUPLICADA'],
    [409, 'PREPARACION_NO_REINTENTABLE'],
    [422, 'DATOS_INCOMPLETOS'],
    [422, 'PERFIL_FISICO_INVALIDO'],
    [422, 'TIPO_PRODUCTO_INVALIDO'],
  ])('preserves contractual mutation error %s %s', (status, code) => {
    const response = responseFor(
      new HttpException({ code, secret: 'must-not-leak' }, Number(status)),
    );
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ status, code }),
    );
    expect(JSON.stringify(response.json.mock.calls[0])).not.toContain(
      'must-not-leak',
    );
  });

  it.each([
    ['unique', 500, 'ERROR_INTERNO'],
    ['foreign_key', 500, 'ERROR_INTERNO'],
    ['not_null', 500, 'ERROR_INTERNO'],
    ['check', 500, 'ERROR_INTERNO'],
    ['serialization', 500, 'ERROR_INTERNO'],
    ['deadlock', 500, 'ERROR_INTERNO'],
    ['deferred_constraint', 500, 'ERROR_INTERNO'],
    ['connection', 503, 'SERVICIO_NO_DISPONIBLE'],
  ] as const)(
    'maps persistence failure %s to HTTP %s without exposing details',
    (failure, expectedStatus, expectedCode) => {
      const error = new CatalogPersistenceError(
        failure,
        undefined,
        'private_constraint_name',
      );
      Object.assign(error, {
        query: 'INSERT INTO catalog.products VALUES ($1)',
        parameters: ['private-token-value'],
        detail: 'private password value',
        cause: new Error('driver leaked private SQL'),
      });
      const response = responseFor(error);

      expect(error).not.toHaveProperty('getStatus');
      expect(response.status).toHaveBeenCalledWith(expectedStatus);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: expectedStatus, code: expectedCode }),
      );
      expect(JSON.stringify(response.json.mock.calls[0]?.[0])).not.toContain(
        'private_constraint_name',
      );
      const publicResponse = JSON.stringify(response.json.mock.calls[0]?.[0]);
      expect(publicResponse).not.toContain('INSERT INTO');
      expect(publicResponse).not.toContain('private-token-value');
      expect(publicResponse).not.toContain('private password');
      expect(publicResponse).not.toContain('driver leaked');
    },
  );
});
