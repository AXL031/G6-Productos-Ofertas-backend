import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import {
  ProblemDetailsFilter,
  isDatabaseUnavailable,
} from './problem-details.filter.js';
import { ProblemDetailsException } from './inventory.errors.js';

describe('ProblemDetailsFilter — Manejo de errores e indisponibilidad DB (#25 / PR #201)', () => {
  let filter: ProblemDetailsFilter;
  let mockResponse: {
    status: ReturnType<typeof vi.fn>;
    header: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
  let mockRequest: {
    headers: Record<string, string>;
  };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new ProblemDetailsFilter();
    mockResponse = {
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    mockRequest = {
      headers: {
        'x-correlation-id': 'correl-12345',
      },
    };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  describe('isDatabaseUnavailable — Detección de fallos y recursión en cause', () => {
    it.each([
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'EPIPE',
      'ENETUNREACH',
      '08000',
      '08001',
      '08003',
      '08004',
      '08006',
      '08007',
      '08P01',
      '57P01',
      '57P02',
      '57P03',
      '53300',
      '53400',
    ])('reconoce código de indisponibilidad directo: %s', (code) => {
      const err = Object.assign(new Error('driver failure'), { code });
      expect(isDatabaseUnavailable(err)).toBe(true);
    });

    it('reconoce error de conexión anidado en cause (patrón DrizzleQueryError)', () => {
      const pgError = Object.assign(
        new Error('connect ECONNREFUSED 127.0.0.1:5432'),
        {
          code: 'ECONNREFUSED',
        },
      );
      const drizzleError = new Error(
        'Failed query: SELECT * FROM inventory.stock_balance',
        {
          cause: pgError,
        },
      );

      expect(isDatabaseUnavailable(drizzleError)).toBe(true);
    });

    it('reconoce error de shutdown de PostgreSQL (57P01) anidado en segundo nivel de cause', () => {
      const internalPg = Object.assign(
        new Error('terminating connection due to administrator command'),
        {
          code: '57P01',
        },
      );
      const wrapper1 = new Error('Client connection closed', {
        cause: internalPg,
      });
      const drizzleWrapper = new Error('Failed query execution', {
        cause: wrapper1,
      });

      expect(isDatabaseUnavailable(drizzleWrapper)).toBe(true);
    });

    it('reconoce mensajes característicos de desconexión sin código explícito', () => {
      const err = new Error('Connection terminated unexpectedly');
      expect(isDatabaseUnavailable(err)).toBe(true);

      const wrapped = new Error('Drizzle error', {
        cause: new Error('Client was closed and is not queryable'),
      });
      expect(isDatabaseUnavailable(wrapped)).toBe(true);
    });

    it.each([
      ['23505', 'unique_violation'],
      ['23503', 'foreign_key_violation'],
      ['23514', 'check_violation'],
      ['42601', 'syntax_error'],
      ['42P01', 'undefined_table'],
      ['42703', 'undefined_column'],
      ['42501', 'insufficient_privilege'],
    ])(
      'rechaza error SQL de negocio/permisos como indisponibilidad (conserva 500): %s (%s)',
      (code) => {
        const sqlError = Object.assign(new Error('SQL error'), { code });
        const drizzleWrapped = new Error('Failed query', { cause: sqlError });

        expect(isDatabaseUnavailable(sqlError)).toBe(false);
        expect(isDatabaseUnavailable(drizzleWrapped)).toBe(false);
      },
    );
  });

  describe('ProblemDetailsFilter.catch — Mapeo HTTP y sanitización', () => {
    it('responde 503 SERVICIO_NO_DISPONIBLE ante error de conexión directo', () => {
      const err = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
      filter.catch(err, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(503);
      expect(mockResponse.header).toHaveBeenCalledWith(
        'Content-Type',
        'application/problem+json',
      );
      expect(mockResponse.json).toHaveBeenCalledWith({
        type: '/errores/servicio-no-disponible',
        title: 'Servicio no disponible',
        status: 503,
        code: 'SERVICIO_NO_DISPONIBLE',
        detail: 'Una dependencia del servicio no está disponible temporalmente',
        correlationId: 'correl-12345',
      });
    });

    it('responde 503 SERVICIO_NO_DISPONIBLE cuando Drizzle envuelve el fallo en cause', () => {
      const pgOutage = Object.assign(
        new Error('connection failure: server closed'),
        {
          code: '08006',
        },
      );
      const drizzleQueryError = new Error(
        'Failed query: SELECT * FROM secret_table WHERE id = 123',
        {
          cause: pgOutage,
        },
      );

      filter.catch(drizzleQueryError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(503);
      const jsonArg = mockResponse.json.mock.calls[0][0];
      expect(jsonArg.code).toBe('SERVICIO_NO_DISPONIBLE');
      expect(jsonArg.status).toBe(503);
      // Sanitización estricta: nunca se filtra SQL ni detalle del driver
      expect(jsonArg.detail).toBe(
        'Una dependencia del servicio no está disponible temporalmente',
      );
      expect(JSON.stringify(jsonArg)).not.toContain('secret_table');
      expect(JSON.stringify(jsonArg)).not.toContain('08006');
    });

    it('responde 500 ERROR_INTERNO para fallos SQL no relacionados con disponibilidad', () => {
      const syntaxError = Object.assign(
        new Error('syntax error at or near "SELECT"'),
        {
          code: '42601',
        },
      );
      const drizzleError = new Error('Query error', { cause: syntaxError });

      filter.catch(drizzleError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        type: '/errores/error-interno',
        title: 'Error interno del servidor',
        status: 500,
        code: 'ERROR_INTERNO',
        detail: 'Ha ocurrido un error interno en el servicio',
        correlationId: 'correl-12345',
      });
    });

    it('preserva excepciones de dominio ProblemDetailsException intactas', () => {
      const problem = ProblemDetailsException.validation(
        'El SKU es obligatorio',
        'correl-custom',
      );
      filter.catch(problem, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 400,
          code: 'VALIDACION',
          detail: 'El SKU es obligatorio',
          correlationId: 'correl-custom',
        }),
      );
    });

    it('preserva HttpExceptions estándar de NestJS', () => {
      const httpException = new HttpException(
        'Petición incorrecta',
        HttpStatus.BAD_REQUEST,
      );
      filter.catch(httpException, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 400,
          code: 'VALIDACION',
          detail: 'Petición incorrecta',
        }),
      );
    });
  });
});
