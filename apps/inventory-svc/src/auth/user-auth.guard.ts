import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { trustedJwksPublicKey, JwksUnavailable } from './trusted-jwks.js';
import { isPhase1PublicRead } from '../phase1-public-reads.js';
import {
  INVENTORY_CAPABILITIES,
  REQUIRED_CAPABILITY_KEY,
} from './auth.constants.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  UserTokenPayload,
  verifyUserBearerToken,
} from './user-token-verification.js';

/**
 * Guard de operador humano (`userBearer`). Valida la firma criptográfica
 * (RS256) con el material de confianza configurado, `exp` y `tipo=acceso`, y —cuando el
 * endpoint declara `x-required-local-capability`— comprueba la capacidad en los
 * claims del token. No exige `tipo=servicio`.
 */
@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(
    context: ExecutionContext,
    trust?: { publicKey: string; issuer: string },
  ): boolean | Promise<boolean> {
    const phase1Request = context.switchToHttp().getRequest();
    const publicOperations = (process.env.INVENTORY_PUBLIC_OPERATION_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (
      isPhase1PublicRead(
        phase1Request,
        process.env.G6_SECURITY_MODE,
        publicOperations,
      )
    )
      return true;
    const simulated = process.env.G6_SECURITY_MODE === 'SIMULATED_AUTH';
    if (!trust && (simulated || process.env.G7_JWT_JWKS_URL !== undefined)) {
      const authorization = phase1Request.headers.authorization;
      const bearer =
        typeof authorization === 'string' &&
        /^Bearer ([^ ]+)$/.exec(authorization);
      const issuer = simulated
        ? process.env.SIMULATED_AUTH_ISSUER
        : process.env.G7_JWT_ISSUER;
      if (
        !bearer ||
        !issuer ||
        (simulated && issuer === process.env.G7_JWT_ISSUER)
      )
        throw ProblemDetailsException.tokenInvalido();
      return trustedJwksPublicKey(
        bearer[1],
        simulated
          ? process.env.SIMULATED_AUTH_JWKS_URL
          : process.env.G7_JWT_JWKS_URL,
        process.env.NODE_ENV,
      )
        .then((publicKey) => this.authorize(context, { publicKey, issuer }))
        .catch((error: unknown) => {
          if (error instanceof ProblemDetailsException) throw error;
          if (error instanceof JwksUnavailable)
            throw new ProblemDetailsException({
              type: '/errores/servicio-no-disponible',
              title: 'Servicio no disponible',
              status: 503,
              code: 'SERVICIO_NO_DISPONIBLE',
            });
          throw ProblemDetailsException.tokenInvalido();
        });
    }
    return this.authorize(context, trust);
  }

  private authorize(
    context: ExecutionContext,
    trust?: { publicKey: string; issuer: string },
  ): boolean {
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
      trust,
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
      const granted =
        (process.env.G6_SECURITY_MODE ?? 'G7_AUTHENTICATED') ===
        'SIMULATED_AUTH'
          ? this.collectCapabilities(payload)
          : this.localTransferCapabilities(payload.sub ?? '', correlationId);
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

  private localTransferCapabilities(
    subject: string,
    correlationId?: string,
  ): Set<string> {
    const raw = process.env.INVENTORY_G7_TRANSFER_GRANTS;
    if (!raw?.trim()) return new Set();
    const allowed = new Set<string>(Object.values(INVENTORY_CAPABILITIES));
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error();
      const grants = new Map<string, Set<string>>();
      for (const [id, entries] of Object.entries(parsed)) {
        const key = id.toLowerCase();
        if (
          !uuid.test(id) ||
          grants.has(key) ||
          !Array.isArray(entries) ||
          !entries.every(
            (value: unknown) => typeof value === 'string' && allowed.has(value),
          )
        )
          throw new Error();
        grants.set(key, new Set(entries));
      }
      return grants.get(subject.toLowerCase()) ?? new Set();
    } catch {
      throw new ProblemDetailsException({
        type: '/errores/servicio-no-disponible',
        title: 'Servicio no disponible',
        status: 503,
        code: 'SERVICIO_NO_DISPONIBLE',
        correlationId,
      });
    }
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
