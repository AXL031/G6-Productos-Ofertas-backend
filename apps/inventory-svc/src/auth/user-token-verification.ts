import { createVerify } from 'node:crypto';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import { InventoryAuthGuard } from './inventory-auth.guard.js';
import { getConfiguredIssuer, EXPECTED_TOKEN_TYPE } from './auth.constants.js';

export interface UserTokenPayload {
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  iss?: string;
  roles?: string[];
  capabilities?: string[];
  scope?: string;
  scopes?: string[];
  [key: string]: unknown;
}

const EXPECTED_ALGORITHM = 'RS256';
const EXPECTED_AUDIENCE = 'api-productos';

/**
 * Verifica y decodifica un JWT humano (userBearer) emitido por Seguridad y
 * Usuarios (G7). La validación ordinaria es local con material de confianza de
 * G7; no exige `tipo=servicio`. Reutiliza el material público ya cargado por
 * InventoryAuthGuard para no duplicar la gestión de claves.
 */
export function verifyUserBearerToken(
  rawToken: string,
  correlationId?: string,
): UserTokenPayload {
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

  const publicKey = InventoryAuthGuard.getTrustedPublicKey();
  if (!publicKey) {
    throw ProblemDetailsException.tokenInvalido(
      'Material de confianza de G7 no disponible para verificación criptográfica',
      correlationId,
    );
  }

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

  let payload: UserTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('payload inválido');
  } catch {
    throw ProblemDetailsException.tokenInvalido(
      'No se pudo decodificar el payload del token JWT',
      correlationId,
    );
  }

  const expectedIssuer = getConfiguredIssuer();
  if (!expectedIssuer || payload.iss !== expectedIssuer) {
    throw ProblemDetailsException.tokenInvalido(
      'Issuer humano ausente, incorrecto o no configurado en G7',
      correlationId,
    );
  }
  if (
    payload.tipo === EXPECTED_TOKEN_TYPE ||
    typeof payload.sub !== 'string' ||
    !payload.sub.trim()
  ) {
    throw ProblemDetailsException.tokenInvalido(
      'Se requiere identidad humana válida para esta operación',
      correlationId,
    );
  }

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

  const audMatches =
    payload.aud === EXPECTED_AUDIENCE ||
    (Array.isArray(payload.aud) && payload.aud.includes(EXPECTED_AUDIENCE));
  if (!audMatches) {
    throw ProblemDetailsException.tokenInvalido(
      `Audiencia de token inválida. Se requiere '${EXPECTED_AUDIENCE}'`,
      correlationId,
    );
  }

  return payload;
}
