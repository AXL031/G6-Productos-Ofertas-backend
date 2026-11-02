import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_CAPABILITY_KEY } from './auth.constants.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  UserTokenPayload,
  verifyUserBearerToken,
} from './user-token-verification.js';

/**
 * Guard de operador humano (`userBearer`). Valida la firma criptográfica
 * (RS256) con el material de confianza de G7, `exp` y `aud`, y —cuando el
 * endpoint declara `x-required-local-capability`— comprueba la capacidad en los
 * claims del token. No exige `tipo=servicio`.
 */
@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredCapability = this.reflector.getAllAndOverride<
      string | undefined
    >(REQUIRED_CAPABILITY_KEY, [context.getHandler(), context.getClass()]);

    const request = context.switchToHttp().getRequest();
    const correlationId =
      request.headers['x-correlation-id'] || request.headers['correlation-id'];

    const authHeader = request.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') {
      throw ProblemDetailsException.tokenInvalido(
        'Encabezado Authorization requerido con formato Bearer <token>',
        correlationId,
      );
    }
    if (!authHeader.startsWith('Bearer ')) {
      throw ProblemDetailsException.tokenInvalido(
        'Formato de autorización inválido. Debe ser Bearer <token>',
        correlationId,
      );
    }

    const rawToken = authHeader.substring(7).trim();
    if (!rawToken) {
      throw ProblemDetailsException.tokenInvalido(
        'Token Bearer ausente o vacío',
        correlationId,
      );
    }

    const payload: UserTokenPayload = verifyUserBearerToken(
      rawToken,
      correlationId,
    );

    if (
      !Array.isArray(payload.roles) ||
      !payload.roles.includes('GESTOR_COMERCIAL')
    ) {
      throw ProblemDetailsException.scopeInsuficiente(
        'La operación requiere el rol GESTOR_COMERCIAL',
        correlationId,
      );
    }

    if (requiredCapability) {
      const granted = this.collectCapabilities(payload);
      if (!granted.has(requiredCapability)) {
        throw ProblemDetailsException.scopeInsuficiente(
          `Capacidad insuficiente. Se requiere '${requiredCapability}'`,
          correlationId,
        );
      }
    }

    request.user = payload;
    request.userId = payload.sub;
    return true;
  }

  private collectCapabilities(payload: UserTokenPayload): Set<string> {
    const granted = new Set<string>();
    const addAll = (value: unknown): void => {
      if (Array.isArray(value)) {
        value
          .filter((v): v is string => typeof v === 'string')
          .forEach((v) => granted.add(v));
      }
    };
    addAll(payload.capabilities);
    addAll(payload.roles);
    if (typeof payload.scope === 'string') {
      payload.scope
        .split(' ')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((s) => granted.add(s));
    }
    addAll(payload.scopes);
    return granted;
  }
}
