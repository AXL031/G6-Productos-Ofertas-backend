import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PromotionsReadinessService } from './health/promotions-readiness.service.js';
import { PromotionsConfigService } from './infrastructure/config/promotions-config.js';
import { PromotionsSvcService } from './promotions-svc.service.js';

@Controller()
export class PromotionsSvcController {
  constructor(
    private readonly Service: PromotionsSvcService,
    private readonly readiness: PromotionsReadinessService,
    private readonly config: PromotionsConfigService,
  ) {}

  @Get('health')
  getHealth() {
    return this.Service.getHealth();
  }

  @Get('health/ready')
  async getReadiness(@Res() response: Response) {
    const result = await this.readiness.check(
      this.config.settings.couponRuntimeEnabled,
    );
    return response.status(result.status === 'ready' ? 200 : 503).json(result);
  }
}
