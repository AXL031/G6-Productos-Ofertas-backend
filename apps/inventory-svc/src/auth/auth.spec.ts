import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InventoryAuthGuard } from './inventory-auth.guard.js';
import {
  ALLOW_USER_BEARER_KEY,
  INVENTORY_SCOPES,
  KNOWN_CLIENTS,
} from './auth.constants.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  createCryptographicJwt,
  TEST_ISSUER,
  TEST_PUBLIC_KEY,
} from '../../test/crypto-test-token.helper.js';

describe('InventoryAuthGuard — Verificación Criptográfica JWT RS256 de G7', () => {
  let guard: InventoryAuthGuard;
  let reflector: Reflector;
  let previousIssuer: string | undefined;

  beforeEach(() => {
    previousIssuer = process.env.G7_JWT_ISSUER;
    process.env.G7_JWT_ISSUER = TEST_ISSUER;
    reflector = new Reflector();
    guard = new InventoryAuthGuard(reflector);
    InventoryAuthGuard.setTrustedPublicKey(TEST_PUBLIC_KEY);
  });

  afterEach(() => {
    InventoryAuthGuard.setTrustedPublicKey(null);
    if (previousIssuer === undefined) delete process.env.G7_JWT_ISSUER;
    else process.env.G7_JWT_ISSUER = previousIssuer;
    delete process.env.G6_SECURITY_MODE;
    delete process.env.SIMULATED_AUTH_ISSUER;
    delete process.env.SIMULATED_AUTH_JWKS_URL;
    vi.unstubAllGlobals();
  });

  function createMockContext(
    authHeader?: string,
    metadata?: {
      scope?: string;
      allowedClients?: string[];
      allowUserBearer?: boolean;
    },
  ): ExecutionContext {
    const request = {
      headers: {
        authorization: authHeader,
        'x-correlation-id': 'test-corr-id-123',
      },
      user: undefined,
      clientId: undefined,
    };

    reflector.getAllAndOverride = ((key: string) => {
      if (key === 'required_scope') return metadata?.scope;
      if (key === 'allowed_clients') return metadata?.allowedClients;
      if (key === ALLOW_USER_BEARER_KEY) return metadata?.allowUserBearer;
      return undefined;
    }) as any;

    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  async function guardError(context: ExecutionContext) {
    const error = await guard.canActivate(context).then(
      () => undefined,
      (value: unknown) => value as ProblemDetailsException,
    );
    expect(error).toBeInstanceOf(ProblemDetailsException);
    return error as ProblemDetailsException & {
      problem: { status: number; code: string; detail: string };
    };
  }

  it('1. Caso obligatorio: firma ausente debe ser rechazada con 401 TOKEN_INVALIDO', async () => {
    const token = createCryptographicJwt({ omitSignature: true });
    const context = createMockContext(`Bearer ${token}`);

    const error = await guardError(context);
    expect(error.problem.status).toBe(401);
    expect(error.problem.code).toBe('TOKEN_INVALIDO');
    expect(error.problem.detail).toMatch(/firma/i);
  });

  it('2. Caso obligatorio: firma alterada debe ser rechazada con 401 TOKEN_INVALIDO', async () => {
    const token = createCryptographicJwt({ tamperSignature: true });
    const context = createMockContext(`Bearer ${token}`);

    const error = await guardError(context);
    expect(error.problem.status).toBe(401);
    expect(error.problem.code).toBe('TOKEN_INVALIDO');
    expect(error.problem.detail).toMatch(/firma criptográfica.*inválida/i);
  });

  it('3. Caso obligatorio: algoritmo no permitido (ej. HS256) debe ser rechazado con 401 TOKEN_INVALIDO', async () => {
    const token = createCryptographicJwt({ alg: 'HS256' });
    const context = createMockContext(`Bearer ${token}`);

    const error = await guardError(context);
    expect(error.problem.status).toBe(401);
    expect(error.problem.code).toBe('TOKEN_INVALIDO');
    expect(error.problem.detail).toMatch(/algoritmo de token no permitido/i);
  });

  it('4. Caso obligatorio: issuer incorrecto debe ser rechazado con 401 TOKEN_INVALIDO', async () => {
    const token = createCryptographicJwt({ iss: 'auth-ficticio' });
    const context = createMockContext(`Bearer ${token}`);

    const error = await guardError(context);
    expect(error.problem.status).toBe(401);
    expect(error.problem.code).toBe('TOKEN_INVALIDO');
    expect(error.problem.detail).toMatch(/issuer de token inválido/i);
  });

  it('5. Caso obligatorio: audiencia incorrecta debe ser rechazada con 401 TOKEN_INVALIDO', async () => {
    const token = createCryptographicJwt({ aud: 'otra-audiencia-g5' });
    const context = createMockContext(`Bearer ${token}`);

    const error = await guardError(context);
    expect(error.problem.status).toBe(401);
    expect(error.problem.code).toBe('TOKEN_INVALIDO');
    expect(error.problem.detail).toMatch(/audiencia de token inválida/i);
  });

  it('6. Caso obligatorio: token vencido (exp) debe ser rechazado con 401 TOKEN_INVALIDO', async () => {
    const pastTimestamp = Math.floor(Date.now() / 1000) - 300;
    const token = createCryptographicJwt({ exp: pastTimestamp });
    const context = createMockContext(`Bearer ${token}`);

    const error = await guardError(context);
    expect(error.problem.status).toBe(401);
    expect(error.problem.code).toBe('TOKEN_INVALIDO');
    expect(error.problem.detail).toMatch(/expirado/i);
  });

  it('7. Caso obligatorio: cliente no autorizado en allowlist debe ser rechazado con 403 SCOPE_INSUFICIENTE', async () => {
    const token = createCryptographicJwt({ clientId: 'modulo-desconocido' });
    const context = createMockContext(`Bearer ${token}`, {
      allowedClients: [KNOWN_CLIENTS.VENTAS],
    });

    const error = await guardError(context);
    expect(error.problem.status).toBe(403);
    expect(error.problem.code).toBe('SCOPE_INSUFICIENTE');
    expect(error.problem.detail).toMatch(/no está autorizado/i);
  });

  it('8. Caso obligatorio: scope insuficiente debe ser rechazado con 403 SCOPE_INSUFICIENTE', async () => {
    const token = createCryptographicJwt({
      scope: 'inventario:disponibilidad:leer',
    });
    const context = createMockContext(`Bearer ${token}`, {
      scope: INVENTORY_SCOPES.RESERVAR,
    });

    const error = await guardError(context);
    expect(error.problem.status).toBe(403);
    expect(error.problem.code).toBe('SCOPE_INSUFICIENTE');
    expect(error.problem.detail).toMatch(/scope insuficiente/i);
  });

  it('permite Postventa en disponibilidad detallada conforme al alcance contractual', async () => {
    const token = createCryptographicJwt({
      clientId: KNOWN_CLIENTS.POSTVENTA,
      scope: INVENTORY_SCOPES.DISPONIBILIDAD_LEER,
    });
    const context = createMockContext(`Bearer ${token}`, {
      allowedClients: [KNOWN_CLIENTS.VENTAS, KNOWN_CLIENTS.POSTVENTA],
      scope: INVENTORY_SCOPES.DISPONIBILIDAD_LEER,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('9. Caso obligatorio: token criptográficamente válido debe activar la ruta e inyectar contexto', async () => {
    const token = createCryptographicJwt({
      clientId: KNOWN_CLIENTS.VENTAS,
      scope: INVENTORY_SCOPES.RESERVAR,
    });
    const context = createMockContext(`Bearer ${token}`, {
      allowedClients: [KNOWN_CLIENTS.VENTAS],
      scope: INVENTORY_SCOPES.RESERVAR,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    const req = context.switchToHttp().getRequest() as any;
    expect(req.user).toBeDefined();
    expect(req.clientId).toBe(KNOWN_CLIENTS.VENTAS);
    expect(req.user.iss).toBe(TEST_ISSUER);
    expect(req.user.aud).toBe('api-productos');
  });

  it('debe rechazar con 401 si no hay material de confianza disponible de G7', async () => {
    InventoryAuthGuard.setTrustedPublicKey(null);
    const savedEnv = process.env.G7_JWT_PUBLIC_KEY;
    delete process.env.G7_JWT_PUBLIC_KEY;
    delete process.env.JWT_PUBLIC_KEY;

    try {
      const token = createCryptographicJwt();
      const context = createMockContext(`Bearer ${token}`);

      const error = await guardError(context);
      expect(error.problem.status).toBe(401);
      expect(error.problem.code).toBe('TOKEN_INVALIDO');
      expect(error.problem.detail).toMatch(
        /material de confianza de g7 no disponible/i,
      );
    } finally {
      if (savedEnv) process.env.G7_JWT_PUBLIC_KEY = savedEnv;
    }
  });

  it('rechaza con 401 si el issuer oficial de G7 no está configurado', async () => {
    delete process.env.G7_JWT_ISSUER;
    const token = createCryptographicJwt();
    const context = createMockContext(`Bearer ${token}`);

    const error = await guardError(context);
    expect(error.problem.status).toBe(401);
    expect(error.problem.code).toBe('TOKEN_INVALIDO');
    expect(error.problem.detail).toMatch(/issuer de g7 no configurado/i);
  });

  it('uses a separately signed simulated identity and rejects it after switching to G7 with the same code', async () => {
    const simulatedIssuer = 'https://simulated.integration.test/issuer';
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicJwk = {
      ...(keyPair.publicKey.export({ format: 'jwk' }) as Record<
        string,
        unknown
      >),
      kid: 'simulated-inventory-key',
      alg: 'RS256',
      use: 'sig',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ keys: [publicJwk] }))),
    );
    process.env.G6_SECURITY_MODE = 'SIMULATED_AUTH';
    process.env.SIMULATED_AUTH_ISSUER = simulatedIssuer;
    process.env.SIMULATED_AUTH_JWKS_URL =
      'https://simulated.integration.test/jwks';
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'simulated-inventory-key',
    });
    const claims = encode({
      iss: simulatedIssuer,
      sub: randomUUID(),
      aud: undefined,
      tipo: 'acceso',
      roles: ['GESTOR_COMERCIAL'],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const signed = createSign('RSA-SHA256');
    signed.update(`${header}.${claims}`);
    const token = `${header}.${claims}.${signed.sign(keyPair.privateKey, 'base64url')}`;
    const context = createMockContext(`Bearer ${token}`, {
      allowUserBearer: true,
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);

    process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ProblemDetailsException,
    );
  });
});
