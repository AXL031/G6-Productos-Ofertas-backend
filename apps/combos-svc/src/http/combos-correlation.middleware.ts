import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function combosCorrelationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header('X-Correlation-Id');
  const correlationId =
    incoming && UUID.test(incoming) ? incoming : randomUUID();
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  if (incoming && !UUID.test(incoming)) {
    res.status(400).type('application/problem+json').json({
      type: '/errores/validacion',
      title: 'Datos de entrada inválidos',
      status: 400,
      code: 'VALIDACION',
      correlationId,
    });
    return;
  }
  next();
}
