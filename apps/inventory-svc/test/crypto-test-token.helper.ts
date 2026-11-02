import crypto from 'node:crypto';
import {
  EXPECTED_AUDIENCE,
  EXPECTED_TOKEN_TYPE,
  EXPECTED_ALGORITHM,
} from '../src/auth/auth.constants.js';

export const TEST_ISSUER = 'https://g7.integration.test/api/v1/auth';

// Generar par de claves RSA 2048-bit para pruebas criptográficas
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export const TEST_PUBLIC_KEY = publicKey;
export const TEST_PRIVATE_KEY = privateKey;

export interface CreateCryptographicTokenOptions {
  clientId?: string;
  sub?: string;
  aud?: string | string[];
  iss?: string;
  tipo?: string;
  scope?: string;
  scopes?: string[];
  roles?: string[];
  capabilities?: string[];
  exp?: number;
  iat?: number;
  alg?: string;
  omitSignature?: boolean;
  tamperSignature?: boolean;
  privateKey?: string;
}

export function createCryptographicJwt(
  options: CreateCryptographicTokenOptions = {},
): string {
  const alg = options.alg ?? EXPECTED_ALGORITHM;
  const header = {
    alg,
    typ: 'JWT',
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = options.exp !== undefined ? options.exp : nowSec + 3600;

  const payload: Record<string, unknown> = {
    iss: options.iss ?? TEST_ISSUER,
    aud: options.aud !== undefined ? options.aud : EXPECTED_AUDIENCE,
    tipo: options.tipo ?? EXPECTED_TOKEN_TYPE,
    sub: options.sub ?? options.clientId ?? 'modulo-ventas',
    client_id: options.clientId ?? options.sub ?? 'modulo-ventas',
    scope:
      options.scope !== undefined
        ? options.scope
        : 'inventario:reservar inventario:consumir inventario:liberar inventario:operaciones:leer inventario:disponibilidad:leer',
    exp,
    iat: options.iat ?? nowSec,
  };

  if (options.scopes) {
    payload.scopes = options.scopes;
  }
  if (options.roles) payload.roles = options.roles;
  if (options.capabilities) payload.capabilities = options.capabilities;

  const toBase64Url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const encodedHeader = toBase64Url(header);
  const encodedPayload = toBase64Url(payload);
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  if (options.omitSignature) {
    return `${unsignedToken}.`;
  }

  // Firmar con RS256 usando la clave privada RSA
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  let signature = signer
    .sign(options.privateKey ?? TEST_PRIVATE_KEY)
    .toString('base64url');

  if (options.tamperSignature) {
    // Corromper la firma alterando los últimos bytes
    const reversed = signature.slice(-4).split('').reverse().join('');
    signature =
      signature.slice(0, -4) +
      (reversed === signature.slice(-4) ? 'ZZZZ' : reversed);
  }

  return `${unsignedToken}.${signature}`;
}
