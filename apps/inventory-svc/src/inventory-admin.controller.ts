import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { UmbralesService } from './umbrales/umbrales.service.js';
import { DashboardService } from './dashboard/dashboard.service.js';
import { TrasladosService } from './traslados/traslados.service.js';
import {
  DashboardInventario,
  ListadoTrasladosInventario,
  RecepcionTrasladoInventarioRequest,
  RecepcionTrasladoInventarioResponse,
  TrasladoInventario,
  UmbralGlobalRequest,
  UmbralInventario,
  UmbralSkuRequest,
} from './types/inventory.dto.js';
import { UserAuthGuard } from './auth/user-auth.guard.js';
import { RequireCapability } from './auth/auth.decorators.js';
import { INVENTORY_CAPABILITIES } from './auth/auth.constants.js';

/**
 * Endpoints `userBearer` (operador humano) del bounded context de Inventario:
 * administración de umbrales y dashboard read-only.
 */
@Controller('api/v1/inventario')
@UseGuards(UserAuthGuard)
export class InventoryAdminController {
  constructor(
    private readonly umbralesService: UmbralesService,
    private readonly dashboardService: DashboardService,
    private readonly trasladosService: TrasladosService,
  ) {}

  @Get('umbrales')
  async obtenerUmbrales(
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<UmbralInventario> {
    return this.umbralesService.obtenerUmbrales(correlationId);
  }

  @Put('umbrales/global')
  @HttpCode(HttpStatus.OK)
  async actualizarUmbralGlobal(
    @Body() dto: UmbralGlobalRequest,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<UmbralInventario> {
    return this.umbralesService.actualizarUmbralGlobal(
      dto?.umbral,
      correlationId,
    );
  }

  @Put('umbrales/skus/:sku')
  @HttpCode(HttpStatus.OK)
  async establecerUmbralSku(
    @Param('sku') sku: string,
    @Body() dto: UmbralSkuRequest,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<UmbralInventario> {
    return this.umbralesService.establecerUmbralSku(
      sku,
      dto?.umbral,
      correlationId,
    );
  }

  @Delete('umbrales/skus/:sku')
  @HttpCode(HttpStatus.NO_CONTENT)
  async eliminarUmbralSku(
    @Param('sku') sku: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    return this.umbralesService.eliminarUmbralSku(sku, correlationId);
  }

  @Get('dashboard')
  async obtenerDashboard(
    @Query('productoId') productoId?: string,
    @Query('categoriaId') categoriaId?: string,
    @Query('marcaId') marcaId?: string,
    @Query('sku') sku?: string,
    @Query('locationId') locationId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<DashboardInventario> {
    return this.dashboardService.obtenerDashboard(
      { productoId, categoriaId, marcaId, sku, locationId },
      correlationId,
    );
  }

  @Get('traslados')
  @RequireCapability(INVENTORY_CAPABILITIES.TRASLADOS_LEER)
  async listarTraslados(
    @Query('estado') estado?: string,
    @Query('target_location_id') targetLocationId?: string,
    @Query('pagina') pagina?: string,
    @Query('tamanio') tamanio?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<ListadoTrasladosInventario> {
    return this.trasladosService.listarTraslados(
      { estado, target_location_id: targetLocationId, pagina, tamanio },
      correlationId,
    );
  }

  @Get('traslados/:trasladoId')
  @RequireCapability(INVENTORY_CAPABILITIES.TRASLADOS_LEER)
  async obtenerTraslado(
    @Param('trasladoId') trasladoId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<TrasladoInventario> {
    return this.trasladosService.obtenerTraslado(trasladoId, correlationId);
  }

  @Post('traslados/:trasladoId/recepciones')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(INVENTORY_CAPABILITIES.TRASLADOS_RECIBIR)
  async registrarRecepcion(
    @Param('trasladoId') trasladoId: string,
    @Body() dto: RecepcionTrasladoInventarioRequest,
    @Req() req: any,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RecepcionTrasladoInventarioResponse> {
    const subGestor = req?.user?.sub;
    return this.trasladosService.registrarRecepcion(
      trasladoId,
      dto,
      correlationId,
      idempotencyKey,
      subGestor,
    );
  }
}
