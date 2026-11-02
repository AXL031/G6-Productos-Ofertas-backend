import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  canonicalPeerIp,
  loadCommercialDemoConfig,
} from '../config/inventory.config.js';

const DEMO_OPERATION = 'inventory_commercial_demo_operation';
const DEMO_REQUEST = Symbol('inventory_commercial_demo_request');
const METHODS = {
  consultarDisponibilidadComercial: 'GET',
  verificarCantidadComercial: 'POST',
} as const;

export interface CommercialRequest extends Request {
  clientId?: string;
  [DEMO_REQUEST]?: true;
}

/** Excepción temporal de #25/#100; no modifica scopes ni identidad productivos. */
export const AllowCommercialDemo = (operation: keyof typeof METHODS) =>
  SetMetadata(DEMO_OPERATION, operation);
export const isCommercialDemoRequest = (request: CommercialRequest): boolean =>
  request[DEMO_REQUEST] === true;

export function authorizeCommercialDemo(
  context: ExecutionContext,
  reflector: Reflector,
): boolean {
  const operation = reflector.get<keyof typeof METHODS | undefined>(
    DEMO_OPERATION,
    context.getHandler(),
  );
  if (!operation || !Object.hasOwn(METHODS, operation)) return false;
  const config = loadCommercialDemoConfig();
  const request = context.switchToHttp().getRequest<CommercialRequest>();
  const peer = canonicalPeerIp(request.socket?.remoteAddress);
  if (
    !config.enabled ||
    request.method !== METHODS[operation] ||
    !peer ||
    !config.gatewayIps.includes(peer)
  )
    return false;
  // Marca interna, imposible de enviar como header. No crear user, sub ni clientId.
  request[DEMO_REQUEST] = true;
  return true;
}
