import { type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryController } from '../inventory.controller.js';
import { InventoryAuthGuard } from './inventory-auth.guard.js';
import {
  isCommercialDemoRequest,
  type CommercialRequest,
} from './commercial-demo.js';
import {
  canonicalPeerIp,
  loadInventoryConfig,
} from '../config/inventory.config.js';

describe('Excepción comercial demo — límites de #25/#100', () => {
  const guard = new InventoryAuthGuard(new Reflector());
  beforeEach(() => {
    vi.stubEnv('INVENTORY_DEMO_NO_AUTH_ENABLED', 'true');
    vi.stubEnv('INVENTORY_DEMO_GATEWAY_IPS', '192.0.2.10,2001:db8::10');
  });
  afterEach(() => vi.unstubAllEnvs());

  function context(
    handler: ReturnType<ExecutionContext['getHandler']> = InventoryController
      .prototype.consultarDisponibilidadComercial,
    peer: string | undefined = '192.0.2.10',
    method = 'GET',
  ) {
    const req = {
      method,
      socket: { remoteAddress: peer },
      headers: {},
      ip: '192.0.2.10',
    } as CommercialRequest;
    const ctx = {
      getHandler: () => handler,
      getClass: () => InventoryController,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { req, ctx };
  }

  it('solo autoriza los dos handlers aprobados sin fabricar identidad', () => {
    for (const [handler, method] of [
      [InventoryController.prototype.consultarDisponibilidadComercial, 'GET'],
      [InventoryController.prototype.verificarCantidadComercial, 'POST'],
    ] as const) {
      const { req, ctx } = context(handler, '::ffff:192.0.2.10', method);
      expect(guard.canActivate(ctx)).toBe(true);
      expect(isCommercialDemoRequest(req)).toBe(true);
      expect(req.clientId).toBeUndefined();
      expect('user' in req).toBe(false);
    }
  });

  it.each([undefined, 'false'])(
    'sin flag activo mantiene JWT requerido: %s',
    (flag) => {
      vi.stubEnv('INVENTORY_DEMO_NO_AUTH_ENABLED', flag);
      const { req, ctx } = context();
      expect(() => guard.canActivate(ctx)).toThrow();
      expect(isCommercialDemoRequest(req)).toBe(false);
    },
  );

  it.each(['198.51.100.20', undefined, 'host.invalid'])(
    'rechaza un peer no confiable aunque falsifique headers: %s',
    (peer) => {
      const { req, ctx } = context();
      Object.assign(req.socket, { remoteAddress: peer });
      req.headers['x-forwarded-for'] = '192.0.2.10';
      req.headers.forwarded = 'for=192.0.2.10';
      req.headers['x-real-ip'] = '192.0.2.10';
      req.headers['x-inventory-demo'] = 'true';
      expect(() => guard.canActivate(ctx)).toThrow();
      expect(isCommercialDemoRequest(req)).toBe(false);
    },
  );

  it('no autoriza otro método ni otras operaciones aunque el peer sea Gateway', () => {
    for (const handler of [
      InventoryController.prototype.solicitarReserva,
      InventoryController.prototype.confirmarReserva,
      InventoryController.prototype.liberarReserva,
      InventoryController.prototype.reintegrarInventario,
      InventoryController.prototype.consultarDisponibilidad,
      InventoryController.prototype.consultarOperacion,
      InventoryController.prototype.reportarIncidencia,
      InventoryController.prototype.resolverIncidencia,
    ]) {
      expect(() => guard.canActivate(context(handler).ctx)).toThrow();
    }
    expect(() =>
      guard.canActivate(context(undefined, undefined, 'HEAD').ctx),
    ).toThrow();
    expect(() =>
      guard.canActivate(context(undefined, undefined, 'POST').ctx),
    ).toThrow();
  });

  it('normaliza IPv6 equivalentes y admite solo las IP exactas configuradas', () => {
    expect(canonicalPeerIp('2001:0db8:0:0:0:0:0:10')).toBe(
      canonicalPeerIp('2001:db8::10'),
    );
    expect(canonicalPeerIp('192.0.2.10')).toBe(
      canonicalPeerIp('::ffff:c000:20a'),
    );
    expect(
      guard.canActivate(context(undefined, '2001:0db8:0:0:0:0:0:10').ctx),
    ).toBe(true);
  });

  it.each(['true', 'false', undefined])(
    'el flag se valida al cargar toda la configuración: %s',
    (flag) => {
      vi.stubEnv('INVENTORY_DEMO_NO_AUTH_ENABLED', flag);
      expect(loadInventoryConfig().commercialDemo.enabled).toBe(
        flag === 'true',
      );
    },
  );

  it.each(['', 'yes', 'TRUE', '1', 'secreto-sintetico'])(
    'rechaza flags ambiguos sin imprimir su contenido: %j',
    (flag) => {
      vi.stubEnv('INVENTORY_DEMO_NO_AUTH_ENABLED', flag);
      expect(() => loadInventoryConfig()).toThrow(
        'INVENTORY_DEMO_NO_AUTH_ENABLED',
      );
      expect(() => loadInventoryConfig()).not.toThrow('secreto-sintetico');
    },
  );

  it.each([
    undefined,
    '',
    '*',
    '0.0.0.0/0',
    'gateway.local',
    '192.0.2.10,',
    'fe80::1%eth0',
  ])('no inicia demo con allowlist ausente o inválida: %j', (ips) => {
    vi.stubEnv('INVENTORY_DEMO_GATEWAY_IPS', ips);
    expect(() => loadInventoryConfig()).toThrow('INVENTORY_DEMO_GATEWAY_IPS');
  });
});
