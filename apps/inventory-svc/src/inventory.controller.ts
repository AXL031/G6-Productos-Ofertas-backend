import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ReservationsService } from './reservations/reservations.service.js';
import { OperationsService } from './operations/operations.service.js';
import { DisponibilidadService } from './disponibilidad/disponibilidad.service.js';
import { ReintegrosService } from './reintegros/reintegros.service.js';
import { IncidenciasService } from './incidencias/incidencias.service.js';
import {
  CrearReservaRequest,
  OperacionReservaRequest,
  LiberarReservaRequest,
  OperacionInventarioAceptada,
  ConsultaOperacionInventario,
  ConsultaDisponibilidadResponse,
  ConsultaDisponibilidadComercialResponse,
  CanalComercial,
  VerificarCantidadComercialRequest,
  VerificarCantidadComercialResponse,
  ReintegroInventarioRequest,
  ReintegroInventarioResponse,
  CrearIncidenciaInventarioRequest,
  IncidenciaInventarioResponse,
  ResolverIncidenciaInventarioRequest,
} from './types/inventory.dto.js';
import { ProblemDetailsException } from './errors/inventory.errors.js';
import { InventoryAuthGuard } from './auth/inventory-auth.guard.js';
import {
  RequireScope,
  AllowedClients,
  AllowUserBearer,
} from './auth/auth.decorators.js';
import { INVENTORY_SCOPES, KNOWN_CLIENTS } from './auth/auth.constants.js';
import {
  AllowCommercialDemo,
  isCommercialDemoRequest,
  type CommercialRequest,
} from './auth/commercial-demo.js';

const CANAL_CLIENT_MAP: Record<string, string> = {
  MARKETPLACE: KNOWN_CLIENTS.MARKETPLACE,
  CHATBOT: KNOWN_CLIENTS.CHATBOT,
  RETAIL: KNOWN_CLIENTS.RETAIL,
};

function parseSkusQuery(skusQuery?: string | string[]): string[] {
  if (typeof skusQuery === 'string') {
    return skusQuery
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(skusQuery)) {
    return skusQuery
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Conforme a CanalComercial: un canal fuera del enum es 400 VALIDACION; un canal
 * válido que no corresponde al client_id autenticado es 403 SCOPE_INSUFICIENTE.
 */
function assertCanalDelCliente(
  canal: string | undefined,
  clientId: string | undefined,
  correlationId?: string,
  commercialDemo = false,
): void {
  const expectedClient =
    typeof canal === 'string' && Object.hasOwn(CANAL_CLIENT_MAP, canal)
      ? CANAL_CLIENT_MAP[canal]
      : undefined;
  if (!expectedClient) {
    throw ProblemDetailsException.validation(
      `El canal '${canal ?? ''}' debe ser MARKETPLACE, CHATBOT o RETAIL`,
      correlationId,
    );
  }
  if (!commercialDemo && expectedClient !== clientId) {
    throw ProblemDetailsException.scopeInsuficiente(
      `El canal '${canal}' no corresponde al cliente autenticado '${clientId ?? ''}'`,
      correlationId,
    );
  }
}

@Controller('api/v1/inventario')
@UseGuards(InventoryAuthGuard)
export class InventoryController {
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly operationsService: OperationsService,
    private readonly disponibilidadService: DisponibilidadService,
    private readonly reintegrosService: ReintegrosService,
    private readonly incidenciasService: IncidenciasService,
  ) {}

  @Post('reservas')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScope(INVENTORY_SCOPES.RESERVAR)
  @AllowedClients([KNOWN_CLIENTS.VENTAS])
  async solicitarReserva(
    @Body() dto: CrearReservaRequest,
    @Req() req: any,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OperacionInventarioAceptada> {
    if (!idempotencyKey) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio para solicitar una reserva',
        correlationId,
      );
    }
    const clientId = req?.clientId;
    if (typeof clientId !== 'string' || clientId.trim().length === 0) {
      throw ProblemDetailsException.tokenInvalido(
        'El token verificado no contiene una identidad de cliente',
        correlationId,
      );
    }
    return this.reservationsService.solicitarReserva(
      dto,
      correlationId,
      idempotencyKey,
      clientId,
    );
  }

  @Post('reservas/:reservaId/confirmar')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScope(INVENTORY_SCOPES.CONSUMIR)
  @AllowedClients([KNOWN_CLIENTS.VENTAS])
  async confirmarReserva(
    @Param('reservaId') reservaId: string,
    @Body() dto: OperacionReservaRequest,
    @Req() req: any,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OperacionInventarioAceptada> {
    if (!idempotencyKey) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio para confirmar una reserva',
        correlationId,
      );
    }
    const clientId = req?.clientId;
    if (typeof clientId !== 'string' || clientId.trim().length === 0) {
      throw ProblemDetailsException.tokenInvalido(
        'El token verificado no contiene una identidad de cliente',
        correlationId,
      );
    }
    return this.reservationsService.confirmarReserva(
      reservaId,
      dto,
      correlationId,
      idempotencyKey,
      clientId,
    );
  }

  @Post('reservas/:reservaId/liberar')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScope(INVENTORY_SCOPES.LIBERAR)
  @AllowedClients([KNOWN_CLIENTS.VENTAS])
  async liberarReserva(
    @Param('reservaId') reservaId: string,
    @Body() dto: LiberarReservaRequest,
    @Req() req: any,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OperacionInventarioAceptada> {
    if (!idempotencyKey) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio para liberar una reserva',
        correlationId,
      );
    }
    const clientId = req?.clientId;
    if (typeof clientId !== 'string' || clientId.trim().length === 0) {
      throw ProblemDetailsException.tokenInvalido(
        'El token verificado no contiene una identidad de cliente',
        correlationId,
      );
    }
    return this.reservationsService.liberarReserva(
      reservaId,
      dto,
      correlationId,
      idempotencyKey,
      clientId,
    );
  }

  @Post('reintegros')
  @HttpCode(HttpStatus.OK)
  @RequireScope(INVENTORY_SCOPES.REINTEGRAR)
  @AllowedClients([KNOWN_CLIENTS.VENTAS, KNOWN_CLIENTS.POSTVENTA])
  async reintegrarInventario(
    @Body() dto: ReintegroInventarioRequest,
    @Req() req: any,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReintegroInventarioResponse> {
    if (!idempotencyKey) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio para reintegrar inventario',
        correlationId,
      );
    }
    const clientId = req?.clientId;
    return this.reintegrosService.reintegrarInventario(
      dto,
      correlationId,
      idempotencyKey,
      clientId,
    );
  }

  @Get('operaciones/:operationId')
  @RequireScope(INVENTORY_SCOPES.OPERACIONES_LEER)
  @AllowedClients([KNOWN_CLIENTS.VENTAS])
  async consultarOperacion(
    @Param('operationId') operationId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<ConsultaOperacionInventario> {
    return this.operationsService.consultarOperacion(
      operationId,
      correlationId,
    );
  }

  @Get('disponibilidad')
  @AllowUserBearer()
  @RequireScope(INVENTORY_SCOPES.DISPONIBILIDAD_LEER)
  @AllowedClients([KNOWN_CLIENTS.VENTAS, KNOWN_CLIENTS.POSTVENTA])
  async consultarDisponibilidad(
    @Query('skus') skusQuery?: string | string[],
    @Query('location_id') locationId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<ConsultaDisponibilidadResponse> {
    const skus = parseSkusQuery(skusQuery);

    if (skus.length === 0) {
      throw ProblemDetailsException.validation(
        'El parámetro de consulta skus es obligatorio (ej. ?skus=SKU-1,SKU-2)',
        correlationId,
      );
    }

    return this.disponibilidadService.consultarDisponibilidad(
      skus,
      locationId,
      correlationId,
    );
  }

  @Get('disponibilidad/comercial')
  @AllowCommercialDemo('consultarDisponibilidadComercial')
  @RequireScope(INVENTORY_SCOPES.DISPONIBILIDAD_LEER)
  @AllowedClients([
    KNOWN_CLIENTS.MARKETPLACE,
    KNOWN_CLIENTS.CHATBOT,
    KNOWN_CLIENTS.RETAIL,
  ])
  async consultarDisponibilidadComercial(
    @Query('skus') skusQuery: string | string[] | undefined,
    @Query('canal') canal: string | undefined,
    @Req() req: CommercialRequest,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<ConsultaDisponibilidadComercialResponse> {
    const skus = parseSkusQuery(skusQuery);
    if (skus.length === 0) {
      throw ProblemDetailsException.validation(
        'El parámetro de consulta skus es obligatorio (ej. ?skus=SKU-1,SKU-2)',
        correlationId,
      );
    }

    assertCanalDelCliente(
      canal,
      req.clientId,
      correlationId,
      isCommercialDemoRequest(req),
    );

    return this.disponibilidadService.consultarDisponibilidadComercial(
      skus,
      canal as CanalComercial,
      correlationId,
    );
  }

  @Post('disponibilidad/comercial/verificar')
  @AllowCommercialDemo('verificarCantidadComercial')
  @HttpCode(HttpStatus.OK)
  @RequireScope(INVENTORY_SCOPES.DISPONIBILIDAD_LEER)
  @AllowedClients([
    KNOWN_CLIENTS.MARKETPLACE,
    KNOWN_CLIENTS.CHATBOT,
    KNOWN_CLIENTS.RETAIL,
  ])
  async verificarCantidadComercial(
    @Body() dto: VerificarCantidadComercialRequest,
    @Req() req: CommercialRequest,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<VerificarCantidadComercialResponse> {
    assertCanalDelCliente(
      dto?.channel_id,
      req.clientId,
      correlationId,
      isCommercialDemoRequest(req),
    );

    return this.disponibilidadService.verificarCantidadComercial(
      dto,
      correlationId,
    );
  }

  @Post('incidencias')
  @HttpCode(HttpStatus.CREATED)
  @RequireScope(INVENTORY_SCOPES.INCIDENCIAS_REPORTAR)
  @AllowedClients([KNOWN_CLIENTS.RETAIL])
  async reportarIncidencia(
    @Body() dto: CrearIncidenciaInventarioRequest,
    @Req() req: any,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<IncidenciaInventarioResponse> {
    const clientId = req?.clientId;
    return this.incidenciasService.reportarIncidencia(
      dto,
      correlationId,
      idempotencyKey,
      clientId,
    );
  }

  @Post('incidencias/:incidenciaId/resolver')
  @HttpCode(HttpStatus.OK)
  @RequireScope(INVENTORY_SCOPES.INCIDENCIAS_RESOLVER)
  @AllowedClients([KNOWN_CLIENTS.RETAIL])
  async resolverIncidencia(
    @Param('incidenciaId') incidenciaId: string,
    @Body() dto: ResolverIncidenciaInventarioRequest,
    @Req() req: any,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<IncidenciaInventarioResponse> {
    const clientId = req?.clientId;
    return this.incidenciasService.resolverIncidencia(
      incidenciaId,
      dto,
      correlationId,
      idempotencyKey,
      clientId,
    );
  }
}
