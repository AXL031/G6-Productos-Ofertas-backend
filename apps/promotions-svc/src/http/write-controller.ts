import {
  Controller,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PromotionsQueryGuard, QueryOperation } from './promotions-identity.js';
import { PromotionsWriteService } from './write-service.js';

@Controller('api/v1')
@UseGuards(PromotionsQueryGuard)
export class PromotionsWriteController {
  constructor(
    @Inject(PromotionsWriteService)
    private readonly service: PromotionsWriteService,
  ) {}
  @Post('promociones') @QueryOperation('crearPromocion') createPromotion(
    @Req() r: Request,
  ) {
    return this.service.execute('crearPromocion', r);
  }
  @Patch('promociones/:promocionId')
  @QueryOperation('actualizarPromocion')
  updatePromotion(@Req() r: Request) {
    return this.service.execute('actualizarPromocion', r);
  }
  @Post('promociones/:promocionId/activar')
  @HttpCode(200)
  @QueryOperation('activarPromocion')
  activatePromotion(@Req() r: Request) {
    return this.service.execute('activarPromocion', r);
  }
  @Post('promociones/:promocionId/desactivar')
  @HttpCode(200)
  @QueryOperation('desactivarPromocion')
  deactivatePromotion(@Req() r: Request) {
    return this.service.execute('desactivarPromocion', r);
  }
  @Post('cupones') @QueryOperation('crearCupon') createCoupon(
    @Req() r: Request,
  ) {
    return this.service.execute('crearCupon', r);
  }
  @Patch('cupones/:cuponId') @QueryOperation('actualizarCupon') updateCoupon(
    @Req() r: Request,
  ) {
    return this.service.execute('actualizarCupon', r);
  }
  @Post('cupones/:cuponId/activar')
  @HttpCode(200)
  @QueryOperation('activarCupon')
  activateCoupon(@Req() r: Request) {
    return this.service.execute('activarCupon', r);
  }
  @Post('cupones/:cuponId/desactivar')
  @HttpCode(200)
  @QueryOperation('desactivarCupon')
  deactivateCoupon(@Req() r: Request) {
    return this.service.execute('desactivarCupon', r);
  }
  @Post('recomendaciones/reglas')
  @QueryOperation('crearReglaRecomendacion')
  createRule(@Req() r: Request) {
    return this.service.execute('crearReglaRecomendacion', r);
  }
  @Patch('recomendaciones/reglas/:reglaId')
  @QueryOperation('actualizarReglaRecomendacion')
  updateRule(@Req() r: Request) {
    return this.service.execute('actualizarReglaRecomendacion', r);
  }
  @Post('recomendaciones/reglas/:reglaId/activar')
  @HttpCode(200)
  @QueryOperation('activarReglaRecomendacion')
  activateRule(@Req() r: Request) {
    return this.service.execute('activarReglaRecomendacion', r);
  }
  @Post('recomendaciones/reglas/:reglaId/desactivar')
  @HttpCode(200)
  @QueryOperation('desactivarReglaRecomendacion')
  deactivateRule(@Req() r: Request) {
    return this.service.execute('desactivarReglaRecomendacion', r);
  }
}
