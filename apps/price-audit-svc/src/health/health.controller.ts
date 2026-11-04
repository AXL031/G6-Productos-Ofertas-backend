import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditReadiness } from './audit-readiness.js';
@Controller('health')
export class HealthController {
  constructor(
    @Inject(AuditReadiness) private readonly readiness: AuditReadiness,
  ) {}
  @Get('live') live() {
    return { status: 'ok', service: 'price-audit-svc' };
  }
  @Get('ready') async ready(@Res() response: Response) {
    const available = await this.readiness.check();
    return response.status(available ? 200 : 503).json({
      status: available ? 'ready' : 'not_ready',
      service: 'price-audit-svc',
    });
  }
}
