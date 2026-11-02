import { Module } from '@nestjs/common';
import { InventorySvcController } from './inventory-svc.controller.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryAdminController } from './inventory-admin.controller.js';
import { InventorySvcService } from './inventory-svc.service.js';
import { DatabaseService } from './database/database.service.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { KardexService } from './kardex/kardex.service.js';
import { OutboxService } from './outbox/outbox.service.js';
import { OutboxPublisherService } from './outbox/outbox-publisher.service.js';
import { ReservationsService } from './reservations/reservations.service.js';
import { ReservationExpirationService } from './reservations/reservation-expiration.service.js';
import { OperationsService } from './operations/operations.service.js';
import { DisponibilidadService } from './disponibilidad/disponibilidad.service.js';
import { ReintegrosService } from './reintegros/reintegros.service.js';
import { UmbralesService } from './umbrales/umbrales.service.js';
import { DashboardService } from './dashboard/dashboard.service.js';
import { IncidenciasService } from './incidencias/incidencias.service.js';
import { TrasladosService } from './traslados/traslados.service.js';
import { InventoryCommandService } from './inbox/inventory-command.service.js';
import { InventoryConsumerService } from './inbox/inventory-consumer.service.js';
import { DrizzleInboxRepository } from './repositories/drizzle/drizzle-inbox.repository.js';

import { DrizzleLocationsRepository } from './repositories/drizzle/drizzle-locations.repository.js';
import { DrizzleCommercialRoutesRepository } from './repositories/drizzle/drizzle-commercial-routes.repository.js';
import { DrizzleStockBalanceRepository } from './repositories/drizzle/drizzle-stock-balance.repository.js';
import { DrizzleReservationsRepository } from './repositories/drizzle/drizzle-reservations.repository.js';
import { DrizzleOperationsRepository } from './repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleKardexRepository } from './repositories/drizzle/drizzle-kardex.repository.js';
import { DrizzleOutboxRepository } from './repositories/drizzle/drizzle-outbox.repository.js';
import { DrizzleThresholdsRepository } from './repositories/drizzle/drizzle-thresholds.repository.js';
import { DrizzleIncidentsRepository } from './repositories/drizzle/drizzle-incidents.repository.js';
import { DrizzleTrasladosRepository } from './repositories/drizzle/drizzle-traslados.repository.js';

import {
  LOCATIONS_REPOSITORY,
  COMMERCIAL_ROUTES_REPOSITORY,
  STOCK_BALANCE_REPOSITORY,
  RESERVATIONS_REPOSITORY,
  OPERATIONS_REPOSITORY,
  KARDEX_REPOSITORY,
  OUTBOX_REPOSITORY,
  THRESHOLDS_REPOSITORY,
  INCIDENTS_REPOSITORY,
  TRASLADOS_REPOSITORY,
  INBOX_REPOSITORY,
} from './repositories/interfaces/repository.tokens.js';

import { InventoryAuthGuard } from './auth/inventory-auth.guard.js';
import { UserAuthGuard } from './auth/user-auth.guard.js';
import { InventoryWorkersService } from './workers/inventory-workers.service.js';

@Module({
  imports: [],
  controllers: [
    InventorySvcController,
    InventoryController,
    InventoryAdminController,
  ],
  providers: [
    InventorySvcService,
    DatabaseService,
    IdempotencyService,
    KardexService,
    OutboxService,
    OutboxPublisherService,
    ReservationsService,
    ReservationExpirationService,
    OperationsService,
    DisponibilidadService,
    ReintegrosService,
    UmbralesService,
    DashboardService,
    IncidenciasService,
    TrasladosService,
    InventoryAuthGuard,
    UserAuthGuard,
    InventoryWorkersService,
    InventoryCommandService,
    InventoryConsumerService,
    { provide: INBOX_REPOSITORY, useClass: DrizzleInboxRepository },
    // Repositorios Drizzle vinculados a sus tokens de interfaz
    {
      provide: LOCATIONS_REPOSITORY,
      useClass: DrizzleLocationsRepository,
    },
    {
      provide: COMMERCIAL_ROUTES_REPOSITORY,
      useClass: DrizzleCommercialRoutesRepository,
    },
    {
      provide: STOCK_BALANCE_REPOSITORY,
      useClass: DrizzleStockBalanceRepository,
    },
    {
      provide: RESERVATIONS_REPOSITORY,
      useClass: DrizzleReservationsRepository,
    },
    {
      provide: OPERATIONS_REPOSITORY,
      useClass: DrizzleOperationsRepository,
    },
    {
      provide: KARDEX_REPOSITORY,
      useClass: DrizzleKardexRepository,
    },
    {
      provide: OUTBOX_REPOSITORY,
      useClass: DrizzleOutboxRepository,
    },
    {
      provide: THRESHOLDS_REPOSITORY,
      useClass: DrizzleThresholdsRepository,
    },
    {
      provide: INCIDENTS_REPOSITORY,
      useClass: DrizzleIncidentsRepository,
    },
    {
      provide: TRASLADOS_REPOSITORY,
      useClass: DrizzleTrasladosRepository,
    },
    // Compatibilidad directa de clases
    DrizzleLocationsRepository,
    DrizzleCommercialRoutesRepository,
    DrizzleStockBalanceRepository,
    DrizzleReservationsRepository,
    DrizzleOperationsRepository,
    DrizzleKardexRepository,
    DrizzleOutboxRepository,
    DrizzleThresholdsRepository,
    DrizzleIncidentsRepository,
    DrizzleTrasladosRepository,
  ],
  exports: [
    DatabaseService,
    IdempotencyService,
    KardexService,
    OutboxService,
    OutboxPublisherService,
    ReservationsService,
    ReservationExpirationService,
    OperationsService,
    DisponibilidadService,
    ReintegrosService,
    UmbralesService,
    DashboardService,
    IncidenciasService,
    TrasladosService,
    InventoryAuthGuard,
    UserAuthGuard,
    LOCATIONS_REPOSITORY,
    COMMERCIAL_ROUTES_REPOSITORY,
    STOCK_BALANCE_REPOSITORY,
    RESERVATIONS_REPOSITORY,
    OPERATIONS_REPOSITORY,
    KARDEX_REPOSITORY,
    OUTBOX_REPOSITORY,
    THRESHOLDS_REPOSITORY,
    INCIDENTS_REPOSITORY,
    TRASLADOS_REPOSITORY,
    DrizzleLocationsRepository,
    DrizzleCommercialRoutesRepository,
    DrizzleStockBalanceRepository,
    DrizzleReservationsRepository,
    DrizzleOperationsRepository,
    DrizzleKardexRepository,
    DrizzleOutboxRepository,
    DrizzleThresholdsRepository,
    DrizzleIncidentsRepository,
    DrizzleTrasladosRepository,
  ],
})
export class InventorySvcModule {}
