import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { InventorySvcController } from './inventory-svc.controller.js';
import { InventorySvcService } from './inventory-svc.service.js';
import { DatabaseService } from './database/database.service.js';

async function createController(
  healthy: boolean,
): Promise<InventorySvcController> {
  const app: TestingModule = await Test.createTestingModule({
    controllers: [InventorySvcController],
    providers: [
      InventorySvcService,
      {
        provide: DatabaseService,
        useValue: {
          isHealthy: async () => ({ healthy, latencyMs: 5 }),
        },
      },
    ],
  }).compile();

  return app.get<InventorySvcController>(InventorySvcController);
}

function createResMock(): Response {
  const res = {
    statusCode: undefined as number | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return res as unknown as Response;
}

describe('InventorySvcController', () => {
  describe('health', () => {
    it('should return health status for inventory-svc', async () => {
      const controller = await createController(true);

      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'inventory-svc',
      });
    });
  });

  describe('readiness', () => {
    it('devuelve ready sin modificar el estado HTTP cuando la base responde', async () => {
      const controller = await createController(true);
      const res = createResMock();

      const body = await controller.getReadiness(res);

      expect(body).toEqual({ status: 'ready', service: 'inventory-svc' });
      expect((res as any).statusCode).toBeUndefined();
    });

    it('devuelve not_ready con 503 cuando la base no responde', async () => {
      const controller = await createController(false);
      const res = createResMock();

      const body = await controller.getReadiness(res);

      expect(body).toEqual({ status: 'not_ready', service: 'inventory-svc' });
      expect((res as any).statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });
  });
});
