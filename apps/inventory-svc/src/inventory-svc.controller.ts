import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InventorySvcService } from './inventory-svc.service.js';

@Controller()
export class InventorySvcController {
  constructor(private readonly service: InventorySvcService) {}

  @Get('health')
  getHealth() {
    return this.service.getHealth();
  }

  @Get('health/readiness')
  async getReadiness(@Res({ passthrough: true }) res: Response) {
    const readiness = await this.service.getReadiness();
    if (readiness.status !== 'ready') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return readiness;
  }
}
