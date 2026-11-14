import { Test, TestingModule } from '@nestjs/testing';
import { PromotionsSvcController } from './promotions-svc.controller.js';
import { PromotionsSvcService } from './promotions-svc.service.js';
import { PromotionsReadinessService } from './health/promotions-readiness.service.js';
import { PromotionsConfigService } from './infrastructure/config/promotions-config.js';
import type { Response } from 'express';

describe('PromotionsSvcController', () => {
  let controller: PromotionsSvcController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [PromotionsSvcController],
      providers: [
        {
          provide: PromotionsSvcService,
          useValue: {
            getHealth: () => ({ status: 'ok', service: 'promotions-svc' }),
          },
        },
        {
          provide: PromotionsReadinessService,
          useValue: {
            check: vi.fn(async () => ({
              status: 'ready',
              service: 'promotions-svc',
              dependencies: { database: 'up', broker: 'disabled' },
            })),
          },
        },
        {
          provide: PromotionsConfigService,
          useValue: { settings: { couponRuntimeEnabled: false } },
        },
      ],
    }).compile();

    controller = app.get<PromotionsSvcController>(PromotionsSvcController);
  });

  describe('health', () => {
    it('should return health status for promotions-svc', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'promotions-svc',
      });
    });
  });

  it('returns HTTP readiness in the format required by the Gateway', async () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await controller.getReadiness(response as unknown as Response);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      status: 'ready',
      service: 'promotions-svc',
      dependencies: { database: 'up', broker: 'disabled' },
    });
  });

  it('returns 503 when a required dependency is down', async () => {
    vi.mocked(controller['readiness'].check).mockResolvedValueOnce({
      status: 'not_ready',
      service: 'promotions-svc',
      dependencies: { database: 'down', broker: 'disabled' },
    });
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await controller.getReadiness(response as unknown as Response);
    expect(response.status).toHaveBeenCalledWith(503);
  });
});
