import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InventoryAuthGuard } from './inventory-auth.guard.js';
import { INVENTORY_SCOPES, KNOWN_CLIENTS } from './auth.constants.js';
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
  });

  function createMockContext(
    authHeader?: string,
    metadata?: { scope?: string; allowedClients?: string[] },
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

  it('1. Caso obligatorio: firma ausente debe ser rechazada con 401 TOKEN_INVALIDO', () => {
    const token = createCryptographicJwt({ omitSignature: true });
    const context = createMockContext(`Bearer ${token}`);

    expect(() => guard.canActivate(context)).toThrow(ProblemDetailsException);
    try {
      guard.canActivate(context);
    } catch (err: any) {
      expect(err.problem.status).toBe(401);
      expect(err.problem.code).toBe('TOKEN_INVALIDO');
      expect(err.problem.detail).toMatch(/firma/i);
    }
  });

  it('2. Caso obligatorio: firma alterada debe ser rechazada con 401 TOKEN_INVALIDO', () => {
    const token = createCryptographicJwt({ tamperSignature: true });
    const context = createMockContext(`Bearer ${token}`);

    expect(() => guard.canActivate(context)).toThrow(ProblemDetailsException);
    try {
      guard.canActivate(context);
    } catch (err: any) {
      expect(err.problem.status).toBe(401);
      expect(err.problem.code).toBe('TOKEN_INVALIDO');
      expect(err.problem.detail).toMatch(/firma criptográfica.*inválida/i);
    }
  });

  it('3. Caso obligatorio: algoritmo no permitido (ej. HS256) debe ser rechazado con 401 TOKEN_INVALIDO', () => {
    const token = createCryptographicJwt({ alg: 'HS256' });
    const context = createMockContext(`Bearer ${token}`);

    expect(() => guard.canActivate(context)).toThrow(ProblemDetailsException);
    try {
      guard.canActivate(context);
    } catch (err: any) {
      expect(err.problem.status).toBe(401);
      expect(err.problem.code).toBe('TOKEN_INVALIDO');
      expect(err.problem.detail).toMatch(/algoritmo de token no permitido/i);
    }
  });

  it('4. Caso obligatorio: issuer incorrecto debe ser rechazado con 401 TOKEN_INVALIDO', () => {
    const token = createCryptographicJwt({ iss: 'auth-ficticio' });
    const context = createMockContext(`Bearer ${token}`);

    expect(() => guard.canActivate(context)).toThrow(ProblemDetailsException);
    try {
      guard.canActivate(context);
    } catch (err: any) {
      expect(err.problem.status).toBe(401);
      expect(err.problem.code).toBe('TOKEN_INVALIDO');
      expect(err.problem.detail).toMatch(/issuer de token inválido/i);
    }
  });

  it('5. Caso obligatorio: audiencia incorrecta debe ser rechazada con 401 TOKEN_INVALIDO', () => {
    const token = createCryptographicJwt({ aud: 'otra-audiencia-g5' });
    const context = createMockContext(`Bearer ${token}`);

    expect(() => guard.canActivate(context)).toThrow(ProblemDetailsException);
    try {
      guard.canActivate(context);
    } catch (err: any) {
      expect(err.problem.status).toBe(401);
      expect(err.problem.code).toBe('TOKEN_INVALIDO');
      expect(err.problem.detail).toMatch(/audiencia de token inválida/i);
    }
  });

  it('6. Caso obligatorio: token vencido (exp) debe ser rechazado con 401 TOKEN_INVALIDO', () => {
    const pastTimestamp = Math.floor(Date.now() / 1000) - 300;
    const token = createCryptographicJwt({ exp: pastTimestamp });
    const context = createMockContext(`Bearer ${token}`);

    expect(() => guard.canActivate(context)).toThrow(ProblemDetailsException);
    try {
      guard.canActivate(context);
    } catch (err: any) {
      expect(err.problem.status).toBe(401);
      expect(err.problem.code).toBe('TOKEN_INVALIDO');
      expect(err.problem.detail).toMatch(/expirado/i);
    }
  });

  it('7. Caso obligatorio: cliente no autorizado en allowlist debe ser rechazado con 403 SCOPE_INSUFICIENTE', () => {
    const token = createCryptographicJwt({ clientId: 'modulo-desconocido' });
    const context = createMockContext(`Bearer ${token}`, {
      allowedClients: [KNOWN_CLIENTS.VENTAS],
    });

    expect(() => guard.canActivate(context)).toThrow(ProblemDetailsException);
    try {
      guard.canActivate(context);
    } catch (err: any) {
      expect(err.problem.status).toBe(403);
      expect(err.problem.code).toBe('SCOPE_INSUFICIENTE');
      expect(err.problem.detail).toMatch(/no está autorizado/i);
    }
  });

  it('8. Caso obligatorio: scope insuficiente debe ser rechazado con 403 SCOPE_INSUFICIENTE', () => {
    const token = createCryptographicJwt({
      scope: 'inventario:disponibilidad:leer',
    });
    const context = createMockContext(`Bearer ${token}`, {
      scope: INVENTORY_SCOPES.RESERVAR,
    });

    expect(() => guard.canActivate(context)).toThrow(ProblemDetailsException);
    try {
      guard.canActivate(context);
    } catch (err: any) {
      expect(err.problem.status).toBe(403);
      expect(err.problem.code).toBe('SCOPE_INSUFICIENTE');
      expect(err.problem.detail).toMatch(/scope insuficiente/i);
    }
  });

  it('permite Postventa en disponibilidad detallada conforme al alcance contractual', () => {
    const token = createCryptographicJwt({
      clientId: KNOWN_CLIENTS.POSTVENTA,
      scope: INVENTORY_SCOPES.DISPONIBILIDAD_LEER,
    });
    const context = createMockContext(`Bearer ${token}`, {
      allowedClients: [KNOWN_CLIENTS.VENTAS, KNOWN_CLIENTS.POSTVENTA],
      scope: INVENTORY_SCOPES.DISPONIBILIDAD_LEER,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('9. Caso obligatorio: token criptográficamente válido debe activar la ruta e inyectar contexto', () => {
    const token = createCryptographicJwt({
      clientId: KNOWN_CLIENTS.VENTAS,
      scope: INVENTORY_SCOPES.RESERVAR,
    });
    const context = createMockContext(`Bearer ${token}`, {
      allowedClients: [KNOWN_CLIENTS.VENTAS],
      scope: INVENTORY_SCOPES.RESERVAR,
    });

    const canActivate = guard.canActivate(context);
    expect(canActivate).toBe(true);

    const req = context.switchToHttp().getRequest() as any;
    expect(req.user).toBeDefined();
    expect(req.clientId).toBe(KNOWN_CLIENTS.VENTAS);
    expect(req.user.iss).toBe(TEST_ISSUER);
    expect(req.user.aud).toBe('api-productos');
  });

  it('debe rechazar con 401 si no hay material de confianza disponible de G7', () => {
    InventoryAuthGuard.setTrustedPublicKey(null);
    const savedEnv = process.env.G7_JWT_PUBLIC_KEY;
    delete process.env.G7_JWT_PUBLIC_KEY;
    delete process.env.JWT_PUBLIC_KEY;

    try {
      const token = createCryptographicJwt();
      const context = createMockContext(`Bearer ${token}`);

      expect(() => guard.canActivate(context)).toThrow(ProblemDetailsException);
      try {
        guard.canActivate(context);
      } catch (err: any) {
        expect(err.problem.status).toBe(401);
        expect(err.problem.code).toBe('TOKEN_INVALIDO');
        expect(err.problem.detail).toMatch(
          /material de confianza de g7 no disponible/i,
        );
      }
    } finally {
      if (savedEnv) process.env.G7_JWT_PUBLIC_KEY = savedEnv;
    }
  });

  it('rechaza con 401 si el issuer oficial de G7 no está configurado', () => {
    delete process.env.G7_JWT_ISSUER;
    const token = createCryptographicJwt();
    const context = createMockContext(`Bearer ${token}`);

    expect(() => guard.canActivate(context)).toThrow(ProblemDetailsException);
    try {
      guard.canActivate(context);
    } catch (err: any) {
      expect(err.problem.status).toBe(401);
      expect(err.problem.code).toBe('TOKEN_INVALIDO');
      expect(err.problem.detail).toMatch(/issuer de g7 no configurado/i);
    }
  });
});
