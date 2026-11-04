import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createVerify } from 'node:crypto';
import {
  REQUIRED_SCOPE_KEY,
  ALLOWED_CLIENTS_KEY,
  EXPECTED_AUDIENCE,
  getConfiguredIssuer,
  EXPECTED_ALGORITHM,
  EXPECTED_TOKEN_TYPE,
  ALLOW_USER_BEARER_KEY,
} from './auth.constants.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import { UserAuthGuard } from './user-auth.guard.js';
import { authorizeCommercialDemo } from './commercial-demo.js';

export interface DecodedTokenPayload {
  sub?: string;
  client_id?: string;
  aud?: string | string[];
  scope?: string;
  scopes?: string[];
  exp?: number;
  iat?: number;
  iss?: string;
  tipo?: string;
  [key: string]: unknown;
}

@Injectable()
export class InventoryAuthGuard implements CanActivate {
  private static trustedPublicKey: string | null = null;

  constructor(private readonly reflector: Reflector) {}

  /**
   * Permite configurar o sobrescribir el material de confianza público para verificación criptográfica (ej. tests o configuración)
   */
  static setTrustedPublicKey(key: string | null): void {
    InventoryAuthGuard.trustedPublicKey = key;
  }

  static getTrustedPublicKey(): string | null {
    return (
      InventoryAuthGuard.trustedPublicKey ||
      process.env.G7_JWT_PUBLIC_KEY ||
      process.env.JWT_PUBLIC_KEY ||
      null
    );
  }

  canActivate(context: ExecutionContext): boolean {
    if (authorizeCommercialDemo(context, this.reflector)) return true;
    const requiredScope = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    const allowedClients = this.reflector.getAllAndOverride<
      string[] | undefined
    >(ALLOWED_CLIENTS_KEY, [context.getHandler(), context.getClass()]);

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

    // Verificación criptográfica con material de confianza de G7
    const payload = this.verifyAndDecodeToken(rawToken, correlationId);

    const allowUserBearer = this.reflector.getAllAndOverride<boolean>(
      ALLOW_USER_BEARER_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowUserBearer && payload.tipo !== EXPECTED_TOKEN_TYPE) {
      // El guard global permanece activo; la vía humana valida firma, issuer,
      // expiración, audience, identidad y rol antes de autorizar la lectura.
      return new UserAuthGuard(this.reflector).canActivate(context);
    }

    // 1. Verificación de expiración (exp)
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      throw ProblemDetailsException.tokenInvalido(
        'Token JWT no contiene claim exp válido',
        correlationId,
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= payload.exp) {
      throw ProblemDetailsException.tokenInvalido(
        'Token JWT expirado',
        correlationId,
      );
    }

    // 2. Comparar el issuer exacto publicado por el discovery de G7.
    const expectedIssuer = getConfiguredIssuer();
    if (!expectedIssuer) {
      throw ProblemDetailsException.tokenInvalido(
        'Issuer de G7 no configurado; se rechazan tokens hasta provisionar el discovery oficial',
        correlationId,
      );
    }
    if (payload.iss !== expectedIssuer) {
      throw ProblemDetailsException.tokenInvalido(
        `Issuer de token inválido. Se requiere el issuer configurado de G7`,
        correlationId,
      );
    }

    // 3. Verificación de tipo de token (tipo: 'servicio')
    if (payload.tipo !== EXPECTED_TOKEN_TYPE) {
      throw ProblemDetailsException.tokenInvalido(
        `Tipo de token inválido. Se requiere '${EXPECTED_TOKEN_TYPE}'`,
        correlationId,
      );
    }

    // 4. Verificación de audiencia (aud: 'api-productos')
    const audMatches =
      payload.aud === EXPECTED_AUDIENCE ||
      (Array.isArray(payload.aud) && payload.aud.includes(EXPECTED_AUDIENCE));

    if (!audMatches) {
      throw ProblemDetailsException.tokenInvalido(
        `Audiencia de token inválida. Se requiere '${EXPECTED_AUDIENCE}'`,
        correlationId,
      );
    }

    // 5. Verificación de clientes permitidos (client_id / sub)
    const clientId = payload.client_id || payload.sub;
    if (allowedClients && allowedClients.length > 0) {
      if (!clientId || !allowedClients.includes(clientId)) {
        throw ProblemDetailsException.scopeInsuficiente(
          `El cliente '${clientId || 'desconocido'}' no está autorizado para esta operación`,
          correlationId,
        );
      }
    }

    // 6. Verificación de scope
    if (requiredScope) {
      const scopes = new Set<string>();
      if (typeof payload.scope === 'string') {
        payload.scope
          .split(' ')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((s) => scopes.add(s));
      }
      if (Array.isArray(payload.scopes)) {
        payload.scopes.forEach((s) => scopes.add(s));
      }

      if (!scopes.has(requiredScope)) {
        throw ProblemDetailsException.scopeInsuficiente(
          `Scope insuficiente. Se requiere '${requiredScope}'`,
          correlationId,
        );
      }
    }

    // Inyectar en el contexto de la solicitud
    request.user = payload;
    request.clientId = clientId;

    return true;
  }

  private verifyAndDecodeToken(
    rawToken: string,
    correlationId?: string,
  ): DecodedTokenPayload {
    const parts = rawToken.split('.');
    if (parts.length !== 3) {
      throw ProblemDetailsException.tokenInvalido(
        'Formato de token JWT malformado (debe contener header, payload y firma)',
        correlationId,
      );
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    if (!signatureB64 || signatureB64.trim().length === 0) {
      throw ProblemDetailsException.tokenInvalido(
        'Firma de token JWT ausente',
        correlationId,
      );
    }

    // Decodificar header
    let header: { alg?: string; typ?: string };
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      if (!header || typeof header !== 'object' || Array.isArray(header))
        throw new Error('header inválido');
    } catch {
      throw ProblemDetailsException.tokenInvalido(
        'Header de token JWT inválido',
        correlationId,
      );
    }

    if (header.alg !== EXPECTED_ALGORITHM) {
      throw ProblemDetailsException.tokenInvalido(
        `Algoritmo de token no permitido (${header.alg ?? 'desconocido'}). Se requiere '${EXPECTED_ALGORITHM}'`,
        correlationId,
      );
    }

    // Obtener clave pública de confianza
    const publicKey = InventoryAuthGuard.getTrustedPublicKey();
    if (!publicKey) {
      throw ProblemDetailsException.tokenInvalido(
        'Material de confianza de G7 no disponible para verificación criptográfica',
        correlationId,
      );
    }

    // Verificar firma criptográfica RSA-SHA256
    try {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${headerB64}.${payloadB64}`);
      const signatureBuffer = Buffer.from(signatureB64, 'base64url');
      const isValid = verifier.verify(publicKey, signatureBuffer);
      if (!isValid) {
        throw ProblemDetailsException.tokenInvalido(
          'Firma criptográfica de token JWT inválida o alterada',
          correlationId,
        );
      }
    } catch (verifyErr) {
      if (verifyErr instanceof ProblemDetailsException) {
        throw verifyErr;
      }
      throw ProblemDetailsException.tokenInvalido(
        'Error durante la verificación criptográfica del token',
        correlationId,
      );
    }

    // Decodificar payload
    try {
      const payload: unknown = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf8'),
      );
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('payload inválido');
      return payload as DecodedTokenPayload;
    } catch {
      throw ProblemDetailsException.tokenInvalido(
        'No se pudo decodificar el payload del token JWT',
        correlationId,
      );
    }
  }
}
