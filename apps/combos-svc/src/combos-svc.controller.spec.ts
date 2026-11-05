import { Test, TestingModule } from '@nestjs/testing';
import { CombosSvcController } from './combos-svc.controller.js';
import { CombosSvcService } from './combos-svc.service.js';
import { CombosDatabase } from './persistence/combos.database.js';
import { CombosRepository } from './persistence/combos.repository.js';
import { CombosEventConsumer } from './messaging/combos-event-consumer.js';
import {
  ComboTokenVerifier,
  CombosAuthGuard,
  SimulatedComboTokenVerifier,
} from './http/combos-auth.js';
import type { Response } from 'express';

describe('CombosSvcController', () => {
  let controller: CombosSvcController;
  let amqpStatus: 'disabled' | 'ready' | 'not_ready';

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [CombosSvcController],
      providers: [
        CombosSvcService,
        ComboTokenVerifier,
        SimulatedComboTokenVerifier,
        CombosAuthGuard,
        { provide: CombosDatabase, useValue: { ready: async () => true } },
        { provide: CombosRepository, useValue: {} },
        {
          provide: CombosEventConsumer,
          useValue: { readinessStatus: () => amqpStatus },
        },
      ],
    }).compile();

    amqpStatus = 'disabled';
    controller = app.get<CombosSvcController>(CombosSvcController);
  });

  describe('health', () => {
    it('should return health status for combos-svc', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'combos-svc',
      });
    });
  });

  describe('readiness', () => {
    async function responseForReadiness() {
      const response = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };
      await controller.ready(response as unknown as Response);
      return response;
    }

    it('preserves HTTP readiness when AMQP is explicitly disabled', async () => {
      amqpStatus = 'disabled';
      const response = await responseForReadiness();
      expect(response.status).toHaveBeenCalledWith(200);
      expect(response.json).toHaveBeenCalledWith({
        status: 'ok',
        service: 'combos-svc',
        dependencies: { postgres: 'ok' },
      });
    });

    it('is ready when enabled AMQP has a live connection, channel and subscription', async () => {
      amqpStatus = 'ready';
      const response = await responseForReadiness();
      expect(response.status).toHaveBeenCalledWith(200);
      expect(response.json).toHaveBeenCalledWith({
        status: 'ok',
        service: 'combos-svc',
        dependencies: { postgres: 'ok', rabbitmq: 'ok' },
      });
    });

    it.each([
      ['broker unavailable at startup', 'not_ready'],
      ['connection lost after startup', 'not_ready'],
      ['consumer paused after persistent failure', 'not_ready'],
    ] as const)('is not ready when %s', async (_scenario, status) => {
      amqpStatus = status;
      const response = await responseForReadiness();
      expect(response.status).toHaveBeenCalledWith(503);
      expect(response.json).toHaveBeenCalledWith({
        status: 'error',
        service: 'combos-svc',
        dependencies: { postgres: 'ok', rabbitmq: 'error' },
      });
    });
  });
});
