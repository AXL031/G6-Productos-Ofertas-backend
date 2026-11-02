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
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { readCombosEnvironment } from './config/combos-environment.js';
import { isAllowedDemoGatewayIp } from './http/combos-demo-origin.js';
import {
  ComboError,
  CombosSvcService,
  type ComboInput,
} from './combos-svc.service.js';

@Controller()
export class CombosSvcController {
  constructor(private readonly service: CombosSvcService) {}
  @Get('health') getHealth() {
    return this.service.getHealth();
  }
  @Get('ready') async ready(@Res() res: Response) {
    const result = await this.service.readiness();
    return res.status(result.status === 'ok' ? 200 : 503).json(result);
  }
  private auth(req: Request) {
    const policy = readCombosEnvironment(process.env);
    if (req.headers.authorization)
      throw new ComboError(
        401,
        'TOKEN_INVALIDO',
        'No se admite Authorization sin un validador JWT configurado',
      );
    if (!policy.demoEnabled)
      throw new ComboError(
        401,
        'TOKEN_INVALIDO',
        'Autenticación JWT requerida; validador G7 no disponible',
      );
    if (
      !isAllowedDemoGatewayIp(req.socket.remoteAddress, policy.demoGatewayIps)
    )
      throw new ComboError(
        403,
        'SCOPE_INSUFICIENTE',
        'Origen de red no autorizado para la demostración restringida',
      );
  }
  @Get('combos') async list(
    @Req() req: Request,
    @Query() query: Record<string, string | undefined>,
  ) {
    this.auth(req);
    return this.service.list(query);
  }
  @Post('combos') async create(
    @Req() req: Request,
    @Body() body: ComboInput,
    @Res() res: Response,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    this.auth(req);
    return res
      .status(201)
      .json(await this.service.create(body, correlationId ?? randomUUID()));
  }
  @Get('combos/:comboId') async get(
    @Req() req: Request,
    @Param('comboId') id: string,
  ) {
    this.auth(req);
    return this.service.get(id);
  }
  @Patch('combos/:comboId') async update(
    @Req() req: Request,
    @Param('comboId') id: string,
    @Body() body: ComboInput,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    this.auth(req);
    return this.service.update(id, body, correlationId ?? randomUUID());
  }
  @Post('combos/:comboId/desactivar')
  @HttpCode(200)
  async deactivate(@Req() req: Request, @Param('comboId') id: string) {
    this.auth(req);
    return this.service.deactivate(id);
  }
  @Get('combos/:comboId/disponibilidad') async availability(
    @Req() req: Request,
    @Param('comboId') id: string,
  ) {
    this.auth(req);
    return this.service.availability(id);
  }
}
