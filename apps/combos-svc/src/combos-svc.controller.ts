import {
  Body,
  Controller,
  Get,
  HttpCode,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CombosEventConsumer } from './messaging/combos-event-consumer.js';
import { CombosAuthGuard, RequireComboAccess } from './http/combos-auth.js';
import { CombosSvcService, type ComboInput } from './combos-svc.service.js';

@Controller()
@UseGuards(CombosAuthGuard)
export class CombosSvcController {
  constructor(
    private readonly service: CombosSvcService,
    private readonly consumer: CombosEventConsumer,
  ) {}
  @Get('health') getHealth() {
    return this.service.getHealth();
  }
  @Get('ready') async ready(@Res() res: Response) {
    const result = await this.service.readiness(
      this.consumer.readinessStatus(),
    );
    return res.status(result.status === 'ok' ? 200 : 503).json(result);
  }
  @RequireComboAccess({ operationId: 'listarCombosAdmin', identity: 'user' })
  @Get('combos')
  async list(
    @Req() req: Request,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.service.list(query);
  }
  @RequireComboAccess({ operationId: 'crearCombo', identity: 'user' })
  @Post('combos')
  async create(
    @Req() req: Request,
    @Body() body: ComboInput,
    @Res() res: Response,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return res
      .status(201)
      .json(await this.service.create(body, correlationId ?? randomUUID()));
  }
  @RequireComboAccess({
    operationId: 'obtenerCombo',
    identity: 'user_or_service',
    scope: 'combos:leer',
  })
  @Get('combos/:comboId')
  async get(@Req() req: Request, @Param('comboId') id: string) {
    return this.service.get(id);
  }
  @RequireComboAccess({ operationId: 'actualizarCombo', identity: 'user' })
  @Patch('combos/:comboId')
  async update(
    @Req() req: Request,
    @Param('comboId') id: string,
    @Body() body: ComboInput,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.service.update(id, body, correlationId ?? randomUUID());
  }
  @RequireComboAccess({ operationId: 'desactivarCombo', identity: 'user' })
  @Post('combos/:comboId/desactivar')
  @HttpCode(200)
  async deactivate(@Req() req: Request, @Param('comboId') id: string) {
    return this.service.deactivate(id);
  }
  @RequireComboAccess({
    operationId: 'consultarDisponibilidadCombo',
    identity: 'user_or_service',
    scope: 'combos:leer',
  })
  @Get('combos/:comboId/disponibilidad')
  async availability(@Req() req: Request, @Param('comboId') id: string) {
    return this.service.availability(id);
  }
}
