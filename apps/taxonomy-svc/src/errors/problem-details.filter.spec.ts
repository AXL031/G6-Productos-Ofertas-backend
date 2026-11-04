import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { beforeEach, vi } from 'vitest';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { ProblemDetailsException } from './taxonomy.errors.js';
import type { ProblemDetailsBody } from './taxonomy.errors.js';

const CORRELACION = '0c0d092e-6192-47c1-8d18-5ed0e2aa4518';

class RespuestaMock {
  codigo = 0;
  encabezado: string | undefined;
  cuerpo: ProblemDetailsBody | undefined;

  status(codigo: number) {
    this.codigo = codigo;
    return this;
  }

  header(nombre: string, valor: string) {
    this.encabezado = nombre + ': ' + valor;
    return this;
  }

  json(cuerpo: ProblemDetailsBody) {
    this.cuerpo = cuerpo;
    return this;
  }
}

function crearHost(headers: Record<string, unknown> = {}): {
  host: ArgumentsHost;
  respuesta: RespuestaMock;
} {
  const respuesta = new RespuestaMock();
  const solicitud = { headers };
  const host = {
    switchToHttp: () => ({
      getResponse: () => respuesta,
      getRequest: () => solicitud,
      getNext: () => undefined,
    }),
    getArgs: () => [],
    getArguments: () => [],
    getType: () => 'http',
  };
  return { host: host as unknown as ArgumentsHost, respuesta };
}

describe('ProblemDetailsFilter — application/problem+json (#22)', () => {
  const logger = { error: vi.fn() };
  const filtro = new ProblemDetailsFilter();
  filtro.usarLogger(logger);

  beforeEach(() => logger.error.mockClear());

  it('mapea ProblemDetailsException.validacion a 400 VALIDACION', () => {
    const { host, respuesta } = crearHost({ 'x-correlation-id': CORRELACION });

    filtro.catch(
      ProblemDetailsException.validacion('X-Correlation-Id inválido.'),
      host,
    );

    expect(respuesta.codigo).toBe(400);
    expect(respuesta.encabezado).toBe('Content-Type: application/problem+json');
    expect(respuesta.cuerpo).toEqual({
      type: '/errores/validacion',
      title: 'Datos de entrada inválidos',
      status: 400,
      code: 'VALIDACION',
      detail: 'X-Correlation-Id inválido.',
      correlationId: CORRELACION,
    });
  });

  it('mapea ProblemDetailsException.noDisponible a 503 SERVICIO_NO_DISPONIBLE', () => {
    const { host, respuesta } = crearHost();

    filtro.catch(
      ProblemDetailsException.noDisponible('Fuente de datos no configurada'),
      host,
    );

    expect(respuesta.codigo).toBe(503);
    expect(respuesta.encabezado).toBe('Content-Type: application/problem+json');
    expect(respuesta.cuerpo).toEqual({
      type: '/errores/servicio-no-disponible',
      title: 'Servicio temporalmente no disponible',
      status: 503,
      code: 'SERVICIO_NO_DISPONIBLE',
      detail: 'Fuente de datos no configurada',
    });
  });

  it('no propaga un X-Correlation-Id que no tiene formato UUID', () => {
    const { host, respuesta } = crearHost({ 'x-correlation-id': 'no-es-uuid' });

    filtro.catch(ProblemDetailsException.validacion('Entrada inválida'), host);

    expect(respuesta.codigo).toBe(400);
    expect(respuesta.cuerpo?.correlationId).toBeUndefined();
  });

  it('acepta el encabezado alternativo correlation-id como respaldo', () => {
    const { host, respuesta } = crearHost({ 'correlation-id': CORRELACION });

    filtro.catch(ProblemDetailsException.validacion('Entrada inválida'), host);

    expect(respuesta.cuerpo?.correlationId).toBe(CORRELACION);
  });

  it.each([
    ['PostgreSQL', 'error: relation taxonomy.categories does not exist'],
    [
      'contraseña y conexión',
      'postgres://admin:very-secret@db.internal/taxonomy',
    ],
    [
      'token de autorización',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret',
    ],
    ['correo', 'falló el envío a private.person@example.com'],
    ['identificador personal', 'documento 4815162342'],
    ['texto arbitrario', 'una excepción inesperada sin palabras conocidas'],
  ])('no expone detalles inesperados que contienen %s', (_caso, mensaje) => {
    const { host, respuesta } = crearHost({ 'x-correlation-id': CORRELACION });

    filtro.catch(new Error(mensaje), host);

    expect(respuesta.codigo).toBe(500);
    expect(respuesta.encabezado).toBe('Content-Type: application/problem+json');
    expect(respuesta.cuerpo).toMatchObject({
      type: '/errores/error-interno',
      title: 'Error interno',
      status: 500,
      code: 'ERROR_INTERNO',
      correlationId: CORRELACION,
      detail: 'Ha ocurrido un error interno en el servicio',
    });
    expect(JSON.stringify(respuesta.cuerpo)).not.toContain(mensaje);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith({
      event: 'taxonomy.http.unexpected_error',
      service: 'taxonomy-svc',
      code: 'ERROR_INTERNO',
      correlation_id: CORRELACION,
      status: 500,
      category: 'UNEXPECTED_EXCEPTION',
    });
  });

  it.each([
    ['error sin mensaje', new Error()],
    ['valor no Error', { message: 'dato privado arbitrario' }],
  ])('usa detalle genérico para %s', (_caso, error) => {
    const { host, respuesta } = crearHost({ 'x-correlation-id': 'no-es-uuid' });

    filtro.catch(error, host);

    expect(respuesta.codigo).toBe(500);
    expect(respuesta.encabezado).toBe('Content-Type: application/problem+json');
    expect(respuesta.cuerpo?.detail).toBe(
      'Ha ocurrido un error interno en el servicio',
    );
    expect(respuesta.cuerpo?.correlationId).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith({
      event: 'taxonomy.http.unexpected_error',
      service: 'taxonomy-svc',
      code: 'ERROR_INTERNO',
      status: 500,
      category: 'UNEXPECTED_EXCEPTION',
    });
  });

  it('conserva un correlation ID válido y omite uno inválido en errores inesperados', () => {
    const valido = crearHost({ 'x-correlation-id': CORRELACION });
    const invalido = crearHost({ 'x-correlation-id': 'privado-no-uuid' });

    filtro.catch(new Error('mensaje secreto'), valido.host);
    filtro.catch(new Error('otro mensaje secreto'), invalido.host);

    expect(valido.respuesta.cuerpo?.correlationId).toBe(CORRELACION);
    expect(invalido.respuesta.cuerpo?.correlationId).toBeUndefined();
    expect(JSON.stringify(valido.respuesta.cuerpo)).not.toContain(
      'mensaje secreto',
    );
    expect(JSON.stringify(invalido.respuesta.cuerpo)).not.toContain(
      'otro mensaje secreto',
    );
  });

  it('mapea una HttpException de Nest a 400 VALIDACION', () => {
    const { host, respuesta } = crearHost();

    filtro.catch(new BadRequestException('El cuerpo es obligatorio'), host);

    expect(respuesta.codigo).toBe(400);
    expect(respuesta.cuerpo).toMatchObject({
      type: '/errores/validacion',
      status: 400,
      code: 'VALIDACION',
    });
    expect(String(respuesta.cuerpo?.detail)).toContain(
      'El cuerpo es obligatorio',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
  it.each([
    new InternalServerErrorException('private.person@example.com'),
    new InternalServerErrorException('postgres://admin:secret@private/db'),
    new HttpException('Bearer private-token', 500),
  ])(
    'sanitiza HttpException 500 y registra �nicamente diagn�stico seguro',
    (error) => {
      const { host, respuesta } = crearHost({
        'x-correlation-id': CORRELACION,
      });
      filtro.catch(error, host);
      expect(respuesta.codigo).toBe(500);
      expect(respuesta.encabezado).toBe(
        'Content-Type: application/problem+json',
      );
      expect(respuesta.cuerpo).toEqual({
        type: '/errores/error-interno',
        title: 'Error interno',
        status: 500,
        code: 'ERROR_INTERNO',
        detail: 'Ha ocurrido un error interno en el servicio',
        correlationId: CORRELACION,
      });
      expect(logger.error).toHaveBeenCalledExactlyOnceWith({
        event: 'taxonomy.http.unexpected_error',
        service: 'taxonomy-svc',
        code: 'ERROR_INTERNO',
        correlation_id: CORRELACION,
        status: 500,
        category: 'UNEXPECTED_EXCEPTION',
      });
    },
  );

  it.each([{}, { 'x-correlation-id': 'private-invalid-id' }])(
    'omite correlaci�n inv�lida o ausente en HTTP 500',
    (headers) => {
      const { host, respuesta } = crearHost(headers);
      filtro.catch(new InternalServerErrorException('private-token'), host);
      expect(respuesta.cuerpo?.detail).toBe(
        'Ha ocurrido un error interno en el servicio',
      );
      expect(respuesta.cuerpo?.correlationId).toBeUndefined();
      expect(logger.error).toHaveBeenCalledExactlyOnceWith({
        event: 'taxonomy.http.unexpected_error',
        service: 'taxonomy-svc',
        code: 'ERROR_INTERNO',
        status: 500,
        category: 'UNEXPECTED_EXCEPTION',
      });
    },
  );

  it('preserva 503 sin exponer el mensaje de una excepci�n no contractual', () => {
    const { host, respuesta } = crearHost({ 'x-correlation-id': CORRELACION });
    filtro.catch(
      new ServiceUnavailableException('postgres://secret@private/db'),
      host,
    );
    expect(respuesta.codigo).toBe(503);
    expect(respuesta.cuerpo).toMatchObject({
      status: 503,
      code: 'SERVICIO_NO_DISPONIBLE',
      detail: 'Servicio temporalmente no disponible',
      correlationId: CORRELACION,
    });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith({
      event: 'taxonomy.http.unexpected_error',
      service: 'taxonomy-svc',
      code: 'SERVICIO_NO_DISPONIBLE',
      status: 503,
      correlation_id: CORRELACION,
      category: 'UNEXPECTED_EXCEPTION',
    });
  });

  it.each([
    new BadRequestException('Entrada inv�lida'),
    new NotFoundException('Categor�a no encontrada'),
    ProblemDetailsException.noDisponible(
      'Dependencia temporalmente no disponible',
    ),
  ])(
    'preserva errores controlados y contractuales sin log inesperado',
    (error) => {
      const { host, respuesta } = crearHost();
      filtro.catch(error, host);
      expect(respuesta.codigo).toBe(error.getStatus());
      expect(respuesta.cuerpo?.detail).toBe(
        error instanceof ProblemDetailsException
          ? error.problem.detail
          : error.message,
      );
      expect(logger.error).not.toHaveBeenCalled();
    },
  );
});
