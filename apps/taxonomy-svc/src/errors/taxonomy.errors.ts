import { HttpException, HttpStatus } from '@nestjs/common';

export interface ProblemDetailsBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  correlationId?: string;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function esUuid(valor: unknown): boolean {
  return typeof valor === 'string' && UUID_REGEX.test(valor);
}

export class ProblemDetailsException extends HttpException {
  public readonly problem: ProblemDetailsBody;

  constructor(problem: ProblemDetailsBody) {
    super(problem, problem.status);
    this.problem = problem;
  }

  static validacion(detalle?: string): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/validacion',
      title: 'Datos de entrada inválidos',
      status: HttpStatus.BAD_REQUEST,
      code: 'VALIDACION',
      detail: detalle,
    });
  }

  static noDisponible(detalle?: string): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/servicio-no-disponible',
      title: 'Servicio temporalmente no disponible',
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'SERVICIO_NO_DISPONIBLE',
      detail: detalle,
    });
  }

  static funcional(
    code: string,
    status: number,
    detalle: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: `/errores/${code.toLowerCase().replaceAll('_', '-')}`,
      title: 'Solicitud de taxonomía rechazada',
      status,
      code,
      detail: detalle,
    });
  }
}
