import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { IDatabaseClient } from '../database/database.interface.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';
import {
  CrearReservaRequest,
  OperacionReservaRequest,
  LiberarReservaRequest,
  OperacionInventarioAceptada,
} from '../types/inventory.dto.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  RESERVATIONS_REPOSITORY,
  STOCK_BALANCE_REPOSITORY,
  OPERATIONS_REPOSITORY,
  LOCATIONS_REPOSITORY,
  COMMERCIAL_ROUTES_REPOSITORY,
} from '../repositories/interfaces/repository.tokens.js';
import type { IReservationsRepository } from '../repositories/interfaces/reservations.repository.interface.js';
import type { IStockBalanceRepository } from '../repositories/interfaces/stock-balance.repository.interface.js';
import type { IOperationsRepository } from '../repositories/interfaces/operations.repository.interface.js';
import type { ILocationsRepository } from '../repositories/interfaces/locations.repository.interface.js';
import type { ICommercialRoutesRepository } from '../repositories/interfaces/commercial-routes.repository.interface.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function durableAcceptedReplay(
  op: { result_payload?: unknown },
  expected: {
    operation_id: string;
    order_id: string;
    operation_type: OperacionInventarioAceptada['operation_type'];
  },
  correlationId: string,
): OperacionInventarioAceptada {
  let payload = op.result_payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw ProblemDetailsException.idempotencyConflict(
        'El resultado durable de la operación es inconsistente',
        correlationId,
      );
    }
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    (payload as OperacionInventarioAceptada).status !== 'ACCEPTED' ||
    (payload as OperacionInventarioAceptada).operation_id !==
      expected.operation_id ||
    (payload as OperacionInventarioAceptada).order_id !== expected.order_id ||
    (payload as OperacionInventarioAceptada).operation_type !==
      expected.operation_type ||
    ((payload as OperacionInventarioAceptada).correlation_id !== null &&
      typeof (payload as OperacionInventarioAceptada).correlation_id !==
        'string')
  ) {
    throw ProblemDetailsException.idempotencyConflict(
      'El resultado durable de la operación es inconsistente',
      correlationId,
    );
  }
  return payload as OperacionInventarioAceptada;
}

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly idempotencyService: IdempotencyService,
    private readonly kardexService: KardexService,
    private readonly outboxService: OutboxService,
    @Inject(RESERVATIONS_REPOSITORY)
    private readonly reservationsRepo: IReservationsRepository,
    @Inject(STOCK_BALANCE_REPOSITORY)
    private readonly stockBalanceRepo: IStockBalanceRepository,
    @Inject(OPERATIONS_REPOSITORY)
    private readonly operationsRepo: IOperationsRepository,
    @Inject(LOCATIONS_REPOSITORY)
    private readonly locationsRepo: ILocationsRepository,
    @Inject(COMMERCIAL_ROUTES_REPOSITORY)
    private readonly commercialRoutesRepo: ICommercialRoutesRepository,
  ) {}

  /**
   * Solicita una reserva de stock para un pedido CREADO (POST /api/v1/inventario/reservas)
   */
  async solicitarReserva(
    dto: CrearReservaRequest,
    correlationIdHeader?: string,
    idempotencyKeyHeader?: string,
    clientId?: string,
  ): Promise<OperacionInventarioAceptada> {
    const correlationId = correlationIdHeader || randomUUID();
    const verifiedClientId = clientId;

    if (!idempotencyKeyHeader) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio para solicitar una reserva',
        correlationId,
      );
    }
    this.validarIdempotencyKey(idempotencyKeyHeader, correlationId);
    const idempotencyKey = idempotencyKeyHeader;

    // 1. Validaciones estructurales y de tipos
    this.validarCrearReservaInput(dto, correlationId);

    // 2. Cálculo de huella semántica (SHA-256)
    const fingerprint = this.idempotencyService.computeFingerprint({
      order_id: dto.order_id,
      channel_id: dto.channel_id,
      lines: dto.lines,
    });

    // 3. Comprobación de idempotencia previa
    const op = await this.operationsRepo.findByOperationIdOrIdempotencyKey(
      dto.operation_id,
      idempotencyKey,
    );

    if (op) {
      // Caso B: Misma Idempotency-Key pero distinto operation_id -> 409
      if (
        op.idempotency_key === idempotencyKey &&
        op.operation_id !== dto.operation_id
      ) {
        throw ProblemDetailsException.idempotencyConflict(
          'La clave Idempotency-Key ya fue utilizada para otra operación',
          correlationId,
        );
      }
      // Mismo operation_id pero distinta Idempotency-Key -> 409
      if (
        op.operation_id === dto.operation_id &&
        op.idempotency_key !== idempotencyKey
      ) {
        throw ProblemDetailsException.idempotencyConflict(
          'El operation_id ya fue utilizado con otra Idempotency-Key',
          correlationId,
        );
      }

      if (
        op.intention === 'reservar' &&
        ((verifiedClientId !== undefined &&
          op.client_id === verifiedClientId) ||
          (verifiedClientId === undefined && !op.client_id)) &&
        this.idempotencyService.isMatchingFingerprint(
          op.request_fingerprint,
          fingerprint,
        )
      ) {
        // Caso A (APLICADO) y Caso E (RECHAZADO): Replay durable idéntico sin nuevos efectos
        return durableAcceptedReplay(
          op,
          {
            operation_id: dto.operation_id,
            order_id: dto.order_id,
            operation_type: 'RESERVAR',
          },
          correlationId,
        );
      } else {
        // Caso C: Misma identidad con contenido distinto -> conflicto
        throw ProblemDetailsException.idempotencyConflict(
          'La operación o Idempotency-Key ya fue utilizada con otra intención o contenido.',
          correlationId,
        );
      }
    }

    // 4. Resolución de ubicación para cada línea
    const resolvedLines = await this.resolverUbicaciones(dto, correlationId);

    // 5. Ejecución transaccional con bloqueo de filas (SELECT ... FOR UPDATE)
    const config = loadInventoryConfig();
    const ttlSeconds = config.reservationTtlSeconds;

    try {
      return await this.databaseService.transaction<OperacionInventarioAceptada>(
        async (client) => {
          // Serializa la admisión de una misma clave durable en PostgreSQL.
          // El precheck anterior es una optimización; no protege dos requests
          // que lo atraviesan simultáneamente.
          await this.operationsRepo.lockIdempotencyKey(client, idempotencyKey);
          const concurrentReplay =
            await this.operationsRepo.findByOperationIdOrIdempotencyKey(
              dto.operation_id,
              idempotencyKey,
              client,
            );
          if (concurrentReplay) {
            if (
              concurrentReplay.operation_id === dto.operation_id &&
              concurrentReplay.idempotency_key === idempotencyKey &&
              concurrentReplay.intention === 'reservar' &&
              ((verifiedClientId !== undefined &&
                concurrentReplay.client_id === verifiedClientId) ||
                (verifiedClientId === undefined &&
                  !concurrentReplay.client_id)) &&
              this.idempotencyService.isMatchingFingerprint(
                concurrentReplay.request_fingerprint,
                fingerprint,
              )
            ) {
              return durableAcceptedReplay(
                concurrentReplay,
                {
                  operation_id: dto.operation_id,
                  order_id: dto.order_id,
                  operation_type: 'RESERVAR',
                },
                correlationId,
              );
            }
            throw ProblemDetailsException.idempotencyConflict(
              'La operación o Idempotency-Key ya fue utilizada con otra intención o contenido.',
              correlationId,
            );
          }

          // Agrupar líneas por (sku_id, location_id)
          const lineMap = new Map<
            string,
            { sku: string; location_id: string; quantity: number }
          >();
          for (const line of resolvedLines) {
            const key = `${line.sku}:::${line.location_id}`;
            const existing = lineMap.get(key);
            if (existing) {
              existing.quantity += line.quantity;
            } else {
              lineMap.set(key, {
                sku: line.sku,
                location_id: line.location_id,
                quantity: line.quantity,
              });
            }
          }

          const groupedLines = Array.from(lineMap.values());

          // Ordenar por sku y location_id para evitar deadlocks de bloqueo concurrente
          groupedLines.sort((a, b) => {
            const c = a.sku.localeCompare(b.sku);
            return c !== 0 ? c : a.location_id.localeCompare(b.location_id);
          });

          // Bloquear y consultar saldos actuales
          const balanceMap = new Map<
            string,
            {
              sku_id: string;
              location_id: string;
              on_hand: number;
              reserved: number;
              blocked: number;
              available: number;
              stock_version: number;
            }
          >();

          for (const item of groupedLines) {
            const bal =
              await this.stockBalanceRepo.findBySkuAndLocationForUpdate(
                client,
                item.sku,
                item.location_id,
              );

            if (!bal) {
              // No existe registro para el SKU en esa ubicación
              return this.registrarRechazo(
                client,
                dto,
                idempotencyKey,
                fingerprint,
                correlationId,
                'STOCK_INSUFICIENTE',
                verifiedClientId,
              );
            }

            balanceMap.set(`${item.sku}:::${item.location_id}`, {
              sku_id: bal.sku_id,
              location_id: bal.location_id,
              on_hand: bal.on_hand,
              reserved: bal.reserved,
              blocked: bal.blocked,
              available: bal.available,
              stock_version: bal.stock_version,
            });
          }

          // Verificar disponibilidad para todas las líneas (atomicidad: todo o nada)
          for (const item of groupedLines) {
            const bal = balanceMap.get(`${item.sku}:::${item.location_id}`)!;
            const currentAvailable = Math.max(
              0,
              bal.on_hand - bal.reserved - bal.blocked,
            );

            if (currentAvailable < item.quantity) {
              // Saldo insuficiente: registrar rechazo durable y outbox
              return this.registrarRechazo(
                client,
                dto,
                idempotencyKey,
                fingerprint,
                correlationId,
                'STOCK_INSUFICIENTE',
                clientId,
              );
            }
          }

          // Saldo suficiente para todas las líneas: aplicar reserva
          const reservationId = randomUUID();
          const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

          const acceptedResponse: OperacionInventarioAceptada = {
            operation_id: dto.operation_id,
            order_id: dto.order_id,
            operation_type: 'RESERVAR',
            status: 'ACCEPTED',
            correlation_id: correlationId,
          };

          // 5.1. Insertar en inventory.reservations
          const reservationPk = await this.reservationsRepo.create(client, {
            reservation_id: reservationId,
            status: 'ACTIVA',
            expires_at: expiresAt.toISOString(),
            idempotency_key: idempotencyKey,
            intention: 'reservar',
            correlation_id: correlationId,
            order_id: dto.order_id,
            operation_id: dto.operation_id,
            request_fingerprint: fingerprint,
            accepted_payload: JSON.stringify(acceptedResponse),
          });

          // 5.2. Insertar líneas y actualizar stock_balance y Kardex
          const linesToInsert = groupedLines.map((item) => ({
            reservation_id: reservationPk,
            sku_id: item.sku,
            location_id: item.location_id,
            quantity: item.quantity,
          }));
          await this.reservationsRepo.createLines(client, linesToInsert);

          for (const item of groupedLines) {
            const bal = balanceMap.get(`${item.sku}:::${item.location_id}`)!;
            const newReserved = bal.reserved + item.quantity;
            const newStockVersion = bal.stock_version + 1;

            const updatedCount = await this.stockBalanceRepo.updateStock(
              client,
              item.sku,
              item.location_id,
              {
                reserved: newReserved,
                stock_version: newStockVersion,
              },
            );
            if (updatedCount !== 1) {
              throw new Error(
                `Inconsistencia: actualización de saldo para SKU ${item.sku} afectó ${updatedCount} filas`,
              );
            }

            // Movimiento en Kardex
            await this.kardexService.recordMovement(client, {
              sku_id: item.sku,
              location_id: item.location_id,
              operation_type: 'RESERVA',
              operation_id: dto.operation_id,
              reservation_id: reservationId,
              quantity: item.quantity,
              on_hand_before: bal.on_hand,
              on_hand_after: bal.on_hand,
              reserved_before: bal.reserved,
              reserved_after: newReserved,
              blocked_before: bal.blocked,
              blocked_after: bal.blocked,
              stock_version: newStockVersion,
              correlation_id: correlationId,
            });
          }

          // 5.3. Registrar la operación en inventory.inventory_operations
          await this.operationsRepo.create(client, {
            operation_type: 'RESERVA',
            idempotency_key: idempotencyKey,
            intention: 'reservar',
            status: 'APLICADO',
            order_id: dto.order_id,
            reservation_id: reservationId,
            operation_id: dto.operation_id,
            client_id: verifiedClientId,
            request_fingerprint: fingerprint,
            request_payload: JSON.stringify(dto),
            result_payload: JSON.stringify(acceptedResponse),
            correlation_id: correlationId,
          });

          // 5.4. Registro en Outbox: inventory.reservation.created
          const createdEventPayload = this.outboxService.createMessageEnvelope({
            eventName: 'inventory.reservation.created',
            kind: 'event',
            operationId: dto.operation_id,
            correlationId,
            data: {
              order_id: dto.order_id,
              reservation_id: reservationId,
              expires_at: expiresAt.toISOString(),
              decided_at: new Date().toISOString(),
              lines: dto.lines.map((l) => ({
                sku: l.sku,
                quantity: l.quantity,
              })),
            },
          });

          await this.outboxService.enqueue(client, {
            event_id: randomUUID(),
            event_type: 'inventory.reservation.created',
            aggregate_type: 'reservation',
            aggregate_id: reservationId,
            correlation_id: correlationId,
            payload: createdEventPayload,
          });

          // Evento de cambio de stock
          for (const item of groupedLines) {
            const bal = balanceMap.get(`${item.sku}:::${item.location_id}`)!;
            await this.outboxService.stockChanged(client, {
              sku: item.sku,
              location_id: item.location_id,
              on_hand: bal.on_hand,
              reserved: bal.reserved + item.quantity,
              blocked: bal.blocked,
              stock_version: bal.stock_version + 1,
              operationId: dto.operation_id,
              correlationId,
            });
          }

          return acceptedResponse;
        },
      );
    } catch (err: any) {
      if (
        err?.code === '23505' ||
        err?.message?.includes('duplicate key') ||
        err?.message?.includes('uq_') ||
        err?.message?.includes('uk_')
      ) {
        const concurrentOp =
          await this.operationsRepo.findByOperationIdOrIdempotencyKey(
            dto.operation_id,
            idempotencyKey,
          );
        if (concurrentOp) {
          if (
            concurrentOp.operation_id === dto.operation_id &&
            concurrentOp.idempotency_key === idempotencyKey &&
            concurrentOp.intention === 'reservar' &&
            concurrentOp.client_id === verifiedClientId &&
            this.idempotencyService.isMatchingFingerprint(
              concurrentOp.request_fingerprint,
              fingerprint,
            )
          ) {
            return durableAcceptedReplay(
              concurrentOp,
              {
                operation_id: dto.operation_id,
                order_id: dto.order_id,
                operation_type: 'RESERVAR',
              },
              correlationId,
            );
          }
          throw ProblemDetailsException.idempotencyConflict(
            'Conflicto de concurrencia o idempotencia detectado',
            correlationId,
          );
        }
      }
      throw err;
    }
  }

  /**
   * Confirma el consumo definitivo de una reserva activa (POST /api/v1/inventario/reservas/{reservaId}/confirmar)
   */
  async confirmarReserva(
    reservaId: string,
    dto: OperacionReservaRequest,
    correlationIdHeader?: string,
    idempotencyKeyHeader?: string,
    clientId?: string,
  ): Promise<OperacionInventarioAceptada> {
    const correlationId = correlationIdHeader || randomUUID();
    const verifiedClientId = clientId;

    if (!idempotencyKeyHeader) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio para confirmar una reserva',
        correlationId,
      );
    }
    this.validarIdempotencyKey(idempotencyKeyHeader, correlationId);
    const idempotencyKey = idempotencyKeyHeader;

    if (!UUID_REGEX.test(reservaId)) {
      throw ProblemDetailsException.validation(
        'reservaId debe ser un UUID válido',
        correlationId,
      );
    }
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      throw ProblemDetailsException.validation(
        'El cuerpo de la solicitud no puede estar vacío',
        correlationId,
      );
    }
    if (
      typeof dto.operation_id !== 'string' ||
      !UUID_REGEX.test(dto.operation_id)
    ) {
      throw ProblemDetailsException.validation(
        'operation_id debe ser un UUID válido',
        correlationId,
      );
    }
    if (
      !dto.order_id ||
      typeof dto.order_id !== 'string' ||
      dto.order_id.trim().length === 0
    ) {
      throw ProblemDetailsException.validation(
        'order_id es obligatorio',
        correlationId,
      );
    }

    const fingerprint = this.idempotencyService.computeFingerprint({
      reservaId,
      order_id: dto.order_id,
      operation_id: dto.operation_id,
      intention: 'confirmar_consumo',
    });

    // Comprobación de idempotencia previa
    const existingOp =
      await this.operationsRepo.findByOperationIdOrIdempotencyKey(
        dto.operation_id,
        idempotencyKey,
      );

    if (existingOp) {
      if (
        existingOp.idempotency_key === idempotencyKey &&
        existingOp.operation_id !== dto.operation_id
      ) {
        throw ProblemDetailsException.idempotencyConflict(
          'La clave Idempotency-Key ya fue utilizada para otra operación',
          correlationId,
        );
      }
      if (
        existingOp.operation_id === dto.operation_id &&
        existingOp.idempotency_key !== idempotencyKey
      ) {
        throw ProblemDetailsException.idempotencyConflict(
          'El operation_id ya fue utilizado con otra Idempotency-Key',
          correlationId,
        );
      }
      if (
        existingOp.intention === 'confirmar_consumo' &&
        ((verifiedClientId !== undefined &&
          existingOp.client_id === verifiedClientId) ||
          (verifiedClientId === undefined && !existingOp.client_id)) &&
        this.idempotencyService.isMatchingFingerprint(
          existingOp.request_fingerprint,
          fingerprint,
        )
      ) {
        return durableAcceptedReplay(
          existingOp,
          {
            operation_id: dto.operation_id,
            order_id: dto.order_id,
            operation_type: 'CONFIRMAR_CONSUMO',
          },
          correlationId,
        );
      } else {
        throw ProblemDetailsException.idempotencyConflict(
          'operation_id o Idempotency-Key ya fue utilizado con otra intención o contenido',
          correlationId,
        );
      }
    }

    // Comprobación de reserva previa y verificación de expiración durable
    const reservaPrevia =
      await this.reservationsRepo.findByReservationId(reservaId);

    if (!reservaPrevia) {
      throw ProblemDetailsException.reservaNoEncontrada(
        'Reserva no encontrada',
        correlationId,
      );
    }

    if (reservaPrevia.order_id !== dto.order_id) {
      throw ProblemDetailsException.validation(
        'order_id no coincide con la reserva',
        correlationId,
      );
    }

    if (reservaPrevia.status === 'CONSUMIDA') {
      throw ProblemDetailsException.reservaNoActiva(
        'La reserva ya ha sido consumida',
        correlationId,
      );
    }
    if (reservaPrevia.status === 'LIBERADA') {
      throw ProblemDetailsException.reservaNoActiva(
        'La reserva ya ha sido liberada',
        correlationId,
      );
    }
    if (reservaPrevia.status === 'EXPIRADA') {
      throw ProblemDetailsException.reservaExpirada(
        'La reserva está expirada',
        correlationId,
      );
    }

    let expiredAfterLock = false;
    try {
      const response =
        await this.databaseService.transaction<OperacionInventarioAceptada>(
          async (client) => {
            await this.operationsRepo.lockIdempotencyKey(
              client,
              idempotencyKey,
            );
            const concurrentReplay =
              await this.operationsRepo.findByOperationIdOrIdempotencyKey(
                dto.operation_id,
                idempotencyKey,
                client,
              );
            if (concurrentReplay) {
              if (
                concurrentReplay.operation_id === dto.operation_id &&
                concurrentReplay.idempotency_key === idempotencyKey &&
                concurrentReplay.intention === 'confirmar_consumo' &&
                concurrentReplay.client_id === verifiedClientId &&
                this.idempotencyService.isMatchingFingerprint(
                  concurrentReplay.request_fingerprint,
                  fingerprint,
                )
              ) {
                return durableAcceptedReplay(
                  concurrentReplay,
                  {
                    operation_id: dto.operation_id,
                    order_id: dto.order_id,
                    operation_type: 'CONFIRMAR_CONSUMO',
                  },
                  correlationId,
                );
              }
              throw ProblemDetailsException.idempotencyConflict(
                'operation_id o Idempotency-Key ya fue utilizado con otra intención o contenido',
                correlationId,
              );
            }
            // Bloquear reserva
            const reserva =
              await this.reservationsRepo.findByReservationIdForUpdate(
                client,
                reservaId,
              );

            if (!reserva) {
              throw ProblemDetailsException.reservaNoEncontrada(
                'Reserva no encontrada',
                correlationId,
              );
            }

            if (reserva.status === 'EXPIRADA') {
              throw ProblemDetailsException.reservaExpirada(
                'La reserva ha expirado',
                correlationId,
              );
            }
            if (reserva.status !== 'ACTIVA') {
              throw ProblemDetailsException.reservaNoActiva(
                `La reserva no está activa (estado actual: ${reserva.status})`,
                correlationId,
              );
            }

            if (reserva.order_id !== dto.order_id) {
              throw ProblemDetailsException.validation(
                'order_id no coincide con la reserva',
                correlationId,
              );
            }

            if (new Date(reserva.expires_at).getTime() <= Date.now()) {
              await this.expirarReservaInterna(
                client,
                reserva.id,
                reserva.reservation_id,
                reserva.order_id || '',
                reserva.correlation_id || correlationId,
              );
              expiredAfterLock = true;
              return {
                operation_id: dto.operation_id,
                order_id: reserva.order_id || dto.order_id,
                operation_type: 'CONFIRMAR_CONSUMO',
                status: 'ACCEPTED',
                correlation_id: correlationId,
              };
            }

            // Re-comprobar expires_at dentro de la transacción tras adquirir el bloqueo
            const now = new Date();
            const expiresAt = new Date(reserva.expires_at);
            if (now.getTime() >= expiresAt.getTime()) {
              throw ProblemDetailsException.reservaExpirada(
                'La reserva ha expirado',
                correlationId,
              );
            }

            // Transición a CONSUMIDA
            const statusUpdated = await this.reservationsRepo.updateStatus(
              client,
              reserva.id,
              'CONSUMIDA',
            );
            if (statusUpdated !== 1) {
              throw new Error(
                `Inconsistencia: actualización de reserva afectó ${statusUpdated} filas`,
              );
            }

            // Cargar líneas de reserva
            const lines = (
              await this.reservationsRepo.findLinesByReservationPk(
                client,
                reserva.id,
              )
            ).sort(
              (a, b) =>
                a.sku_id.localeCompare(b.sku_id) ||
                a.location_id.localeCompare(b.location_id),
            );

            for (const line of lines) {
              const qty = Number(line.quantity);

              const bal =
                await this.stockBalanceRepo.findBySkuAndLocationForUpdate(
                  client,
                  line.sku_id,
                  line.location_id,
                );

              if (!bal) {
                throw ProblemDetailsException.reservaNoActiva(
                  `Saldo de stock no encontrado para SKU ${line.sku_id}`,
                  correlationId,
                );
              }

              const onHand = Number(bal.on_hand);
              const reserved = Number(bal.reserved);
              const blocked = Number(bal.blocked);

              if (onHand < qty || reserved < qty) {
                throw ProblemDetailsException.reservaNoActiva(
                  `Inconsistencia en stock: unidades insuficientes para confirmar SKU ${line.sku_id}`,
                  correlationId,
                );
              }

              const newOnHand = onHand - qty;
              const newReserved = reserved - qty;
              const newVersion = Number(bal.stock_version) + 1;

              const updatedCount = await this.stockBalanceRepo.updateStock(
                client,
                line.sku_id,
                line.location_id,
                {
                  on_hand: newOnHand,
                  reserved: newReserved,
                  stock_version: newVersion,
                },
              );

              if (updatedCount !== 1) {
                throw new Error(
                  `Fallo al actualizar saldo para SKU ${line.sku_id}`,
                );
              }

              // Kardex de consumo definitivo
              await this.outboxService.stockChanged(client, {
                sku: line.sku_id,
                location_id: line.location_id,
                on_hand: newOnHand,
                reserved: newReserved,
                blocked,
                stock_version: newVersion,
                operationId: dto.operation_id,
                correlationId,
              });
              await this.kardexService.recordMovement(client, {
                sku_id: line.sku_id,
                location_id: line.location_id,
                operation_type: 'CONSUMO',
                operation_id: dto.operation_id,
                reservation_id: reservaId,
                quantity: -qty,
                on_hand_before: onHand,
                on_hand_after: newOnHand,
                reserved_before: reserved,
                reserved_after: newReserved,
                blocked_before: blocked,
                blocked_after: blocked,
                stock_version: newVersion,
                correlation_id: correlationId,
              });
            }

            const acceptedResponse: OperacionInventarioAceptada = {
              operation_id: dto.operation_id,
              order_id: dto.order_id,
              operation_type: 'CONFIRMAR_CONSUMO',
              status: 'ACCEPTED',
              correlation_id: correlationId,
            };

            // Registro durable de operación
            await this.operationsRepo.create(client, {
              operation_type: 'CONSUMO',
              idempotency_key: idempotencyKey,
              intention: 'confirmar_consumo',
              status: 'APLICADO',
              order_id: dto.order_id,
              reservation_id: reservaId,
              operation_id: dto.operation_id,
              client_id: verifiedClientId,
              request_fingerprint: fingerprint,
              request_payload: JSON.stringify(dto),
              result_payload: JSON.stringify(acceptedResponse),
              correlation_id: correlationId,
            });

            // Outbox: inventory.reservation.consumed & inventory.consumption.completed
            const consumedEvent = this.outboxService.createMessageEnvelope({
              eventName: 'inventory.reservation.consumed',
              kind: 'event',
              operationId: dto.operation_id,
              correlationId,
              data: {
                order_id: dto.order_id,
                reservation_id: reservaId,
                decided_at: new Date().toISOString(),
                reason_code: null,
              },
            });

            await this.outboxService.enqueue(client, {
              event_id: randomUUID(),
              event_type: 'inventory.reservation.consumed',
              aggregate_type: 'reservation',
              aggregate_id: reservaId,
              correlation_id: correlationId,
              payload: consumedEvent,
            });

            const completedResult = this.outboxService.createMessageEnvelope({
              eventName: 'inventory.consumption.completed',
              kind: 'result',
              operationId: dto.operation_id,
              correlationId,
              data: {
                order_id: dto.order_id,
                reservation_id: reservaId,
                decided_at: new Date().toISOString(),
                result_code: null,
              },
            });

            await this.outboxService.enqueue(client, {
              event_id: randomUUID(),
              event_type: 'inventory.consumption.completed',
              aggregate_type: 'reservation',
              aggregate_id: reservaId,
              correlation_id: correlationId,
              payload: completedResult,
            });

            return acceptedResponse;
          },
        );
      if (expiredAfterLock) {
        throw ProblemDetailsException.reservaExpirada(
          'La reserva está expirada',
          correlationId,
        );
      }
      return response;
    } catch (err: any) {
      if (
        err?.code === '23505' ||
        err?.message?.includes('duplicate key') ||
        err?.message?.includes('uq_') ||
        err?.message?.includes('uk_')
      ) {
        const concurrentOp =
          await this.operationsRepo.findByOperationIdOrIdempotencyKey(
            dto.operation_id,
            idempotencyKey,
          );
        if (concurrentOp) {
          if (
            concurrentOp.operation_id === dto.operation_id &&
            concurrentOp.idempotency_key === idempotencyKey &&
            concurrentOp.intention === 'confirmar_consumo' &&
            concurrentOp.client_id === verifiedClientId &&
            this.idempotencyService.isMatchingFingerprint(
              concurrentOp.request_fingerprint,
              fingerprint,
            )
          ) {
            return durableAcceptedReplay(
              concurrentOp,
              {
                operation_id: dto.operation_id,
                order_id: dto.order_id,
                operation_type: 'CONFIRMAR_CONSUMO',
              },
              correlationId,
            );
          }
          throw ProblemDetailsException.idempotencyConflict(
            'Conflicto de concurrencia o idempotencia detectado',
            correlationId,
          );
        }
      }
      throw err;
    }
  }

  /**
   * Libera una reserva por pago no completado o anulación (POST /api/v1/inventario/reservas/{reservaId}/liberar)
   */
  async liberarReserva(
    reservaId: string,
    dto: LiberarReservaRequest,
    correlationIdHeader?: string,
    idempotencyKeyHeader?: string,
    clientId?: string,
  ): Promise<OperacionInventarioAceptada> {
    const correlationId = correlationIdHeader || randomUUID();
    const verifiedClientId = clientId;

    if (!idempotencyKeyHeader) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio para liberar una reserva',
        correlationId,
      );
    }
    this.validarIdempotencyKey(idempotencyKeyHeader, correlationId);
    const idempotencyKey = idempotencyKeyHeader;

    if (!UUID_REGEX.test(reservaId)) {
      throw ProblemDetailsException.validation(
        'reservaId debe ser un UUID válido',
        correlationId,
      );
    }
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      throw ProblemDetailsException.validation(
        'El cuerpo de la solicitud no puede estar vacío',
        correlationId,
      );
    }
    if (
      typeof dto.operation_id !== 'string' ||
      !UUID_REGEX.test(dto.operation_id)
    ) {
      throw ProblemDetailsException.validation(
        'operation_id debe ser un UUID válido',
        correlationId,
      );
    }
    if (
      !dto.order_id ||
      typeof dto.order_id !== 'string' ||
      dto.order_id.trim().length === 0
    ) {
      throw ProblemDetailsException.validation(
        'order_id es obligatorio',
        correlationId,
      );
    }
    const validReasons = [
      'PAGO_NO_COMPLETADO',
      'ANULACION',
      'EXPIRACION_FORZADA',
      'OTRO',
    ];
    if (!dto.reason || !validReasons.includes(dto.reason)) {
      throw ProblemDetailsException.validation(
        'Motivo de liberación inválido',
        correlationId,
      );
    }

    const fingerprint = this.idempotencyService.computeFingerprint({
      reservaId,
      order_id: dto.order_id,
      operation_id: dto.operation_id,
      reason: dto.reason,
      intention: 'liberar_reserva',
    });

    // Comprobación de idempotencia previa
    const existingOp =
      await this.operationsRepo.findByOperationIdOrIdempotencyKey(
        dto.operation_id,
        idempotencyKey,
      );

    if (existingOp) {
      if (
        existingOp.idempotency_key === idempotencyKey &&
        existingOp.operation_id !== dto.operation_id
      ) {
        throw ProblemDetailsException.idempotencyConflict(
          'La clave Idempotency-Key ya fue utilizada para otra operación',
          correlationId,
        );
      }
      if (
        existingOp.operation_id === dto.operation_id &&
        existingOp.idempotency_key !== idempotencyKey
      ) {
        throw ProblemDetailsException.idempotencyConflict(
          'El operation_id ya fue utilizado con otra Idempotency-Key',
          correlationId,
        );
      }
      if (
        existingOp.intention === 'liberar_reserva' &&
        ((verifiedClientId !== undefined &&
          existingOp.client_id === verifiedClientId) ||
          (verifiedClientId === undefined && !existingOp.client_id)) &&
        this.idempotencyService.isMatchingFingerprint(
          existingOp.request_fingerprint,
          fingerprint,
        )
      ) {
        return durableAcceptedReplay(
          existingOp,
          {
            operation_id: dto.operation_id,
            order_id: dto.order_id,
            operation_type: 'LIBERAR',
          },
          correlationId,
        );
      } else {
        throw ProblemDetailsException.idempotencyConflict(
          'operation_id o Idempotency-Key ya fue utilizado con otra intención o contenido',
          correlationId,
        );
      }
    }

    // Comprobación de reserva previa y verificación de expiración durable
    const reservaPrevia =
      await this.reservationsRepo.findByReservationId(reservaId);

    if (!reservaPrevia) {
      throw ProblemDetailsException.reservaNoEncontrada(
        'Reserva no encontrada',
        correlationId,
      );
    }

    if (reservaPrevia.order_id !== dto.order_id) {
      throw ProblemDetailsException.validation(
        'order_id no coincide con la reserva',
        correlationId,
      );
    }

    if (
      reservaPrevia.status === 'EXPIRADA' ||
      new Date(reservaPrevia.expires_at) <= new Date()
    ) {
      if (reservaPrevia.status === 'ACTIVA') {
        await this.expirarReservaDurable(
          reservaPrevia.reservation_id,
          dto.order_id,
          correlationId,
        );
      }
      // El contrato de liberación no enumera RESERVA_EXPIRADA en su 409;
      // una reserva expirada no está activa, por lo que se responde
      // RESERVA_NO_ACTIVA.
      throw ProblemDetailsException.reservaNoActiva(
        'La reserva está expirada y no admite liberación',
        correlationId,
      );
    }

    if (reservaPrevia.status === 'LIBERADA') {
      throw ProblemDetailsException.reservaNoActiva(
        'La reserva ya se encuentra liberada',
        correlationId,
      );
    }
    if (reservaPrevia.status !== 'ACTIVA') {
      throw ProblemDetailsException.reservaNoActiva(
        `No es posible liberar una reserva en estado ${reservaPrevia.status}`,
        correlationId,
      );
    }

    let expiredAfterLockRelease = false;
    try {
      const response =
        await this.databaseService.transaction<OperacionInventarioAceptada>(
          async (client) => {
            await this.operationsRepo.lockIdempotencyKey(
              client,
              idempotencyKey,
            );
            const concurrentReplay =
              await this.operationsRepo.findByOperationIdOrIdempotencyKey(
                dto.operation_id,
                idempotencyKey,
                client,
              );
            if (concurrentReplay) {
              if (
                concurrentReplay.operation_id === dto.operation_id &&
                concurrentReplay.idempotency_key === idempotencyKey &&
                concurrentReplay.intention === 'liberar_reserva' &&
                concurrentReplay.client_id === verifiedClientId &&
                this.idempotencyService.isMatchingFingerprint(
                  concurrentReplay.request_fingerprint,
                  fingerprint,
                )
              ) {
                return durableAcceptedReplay(
                  concurrentReplay,
                  {
                    operation_id: dto.operation_id,
                    order_id: dto.order_id,
                    operation_type: 'LIBERAR',
                  },
                  correlationId,
                );
              }
              throw ProblemDetailsException.idempotencyConflict(
                'operation_id o Idempotency-Key ya fue utilizado con otra intención o contenido',
                correlationId,
              );
            }
            // Bloquear reserva
            const reserva =
              await this.reservationsRepo.findByReservationIdForUpdate(
                client,
                reservaId,
              );

            if (!reserva) {
              throw ProblemDetailsException.reservaNoEncontrada(
                'Reserva no encontrada',
                correlationId,
              );
            }

            if (reserva.status !== 'ACTIVA') {
              throw ProblemDetailsException.reservaNoActiva(
                `No es posible liberar una reserva en estado ${reserva.status}`,
                correlationId,
              );
            }

            if (reserva.order_id !== dto.order_id) {
              throw ProblemDetailsException.validation(
                'order_id no coincide con la reserva',
                correlationId,
              );
            }

            if (new Date(reserva.expires_at).getTime() <= Date.now()) {
              await this.expirarReservaInterna(
                client,
                reserva.id,
                reserva.reservation_id,
                reserva.order_id || '',
                reserva.correlation_id || correlationId,
              );
              expiredAfterLockRelease = true;
              return {
                operation_id: dto.operation_id,
                order_id: reserva.order_id || dto.order_id,
                operation_type: 'LIBERAR',
                status: 'ACCEPTED',
                correlation_id: correlationId,
              };
            }

            // Transición a LIBERADA
            const statusUpdated = await this.reservationsRepo.updateStatus(
              client,
              reserva.id,
              'LIBERADA',
            );
            if (statusUpdated !== 1) {
              throw new Error(
                `Inconsistencia: actualización de reserva afectó ${statusUpdated} filas`,
              );
            }

            // Cargar líneas y revertir reserved en stock_balance
            const lines = (
              await this.reservationsRepo.findLinesByReservationPk(
                client,
                reserva.id,
              )
            ).sort(
              (a, b) =>
                a.sku_id.localeCompare(b.sku_id) ||
                a.location_id.localeCompare(b.location_id),
            );

            for (const line of lines) {
              const qty = Number(line.quantity);

              const bal =
                await this.stockBalanceRepo.findBySkuAndLocationForUpdate(
                  client,
                  line.sku_id,
                  line.location_id,
                );

              if (!bal) {
                throw ProblemDetailsException.reservaNoActiva(
                  `Saldo de stock no encontrado para SKU ${line.sku_id}`,
                  correlationId,
                );
              }

              const onHand = Number(bal.on_hand);
              const reserved = Number(bal.reserved);
              const blocked = Number(bal.blocked);

              if (reserved < qty) {
                throw ProblemDetailsException.reservaNoActiva(
                  `Saldo reservado insuficiente para liberar SKU ${line.sku_id}`,
                  correlationId,
                );
              }

              const newReserved = reserved - qty;
              const newVersion = Number(bal.stock_version) + 1;

              const updatedCount = await this.stockBalanceRepo.updateStock(
                client,
                line.sku_id,
                line.location_id,
                {
                  reserved: newReserved,
                  stock_version: newVersion,
                },
              );

              if (updatedCount !== 1) {
                throw new Error(
                  `Fallo al actualizar saldo para SKU ${line.sku_id}`,
                );
              }

              // Kardex de liberación
              await this.outboxService.stockChanged(client, {
                sku: line.sku_id,
                location_id: line.location_id,
                on_hand: onHand,
                reserved: newReserved,
                blocked,
                stock_version: newVersion,
                operationId: dto.operation_id,
                correlationId,
              });
              await this.kardexService.recordMovement(client, {
                sku_id: line.sku_id,
                location_id: line.location_id,
                operation_type: 'LIBERACION',
                operation_id: dto.operation_id,
                reservation_id: reservaId,
                quantity: -qty,
                on_hand_before: onHand,
                on_hand_after: onHand,
                reserved_before: reserved,
                reserved_after: newReserved,
                blocked_before: blocked,
                blocked_after: blocked,
                stock_version: newVersion,
                correlation_id: correlationId,
              });
            }

            const acceptedResponse: OperacionInventarioAceptada = {
              operation_id: dto.operation_id,
              order_id: dto.order_id,
              operation_type: 'LIBERAR',
              status: 'ACCEPTED',
              correlation_id: correlationId,
            };

            // Registro durable de operación
            await this.operationsRepo.create(client, {
              operation_type: 'LIBERACION',
              idempotency_key: idempotencyKey,
              intention: 'liberar_reserva',
              status: 'APLICADO',
              order_id: dto.order_id,
              reservation_id: reservaId,
              operation_id: dto.operation_id,
              client_id: verifiedClientId,
              request_fingerprint: fingerprint,
              request_payload: JSON.stringify(dto),
              result_payload: JSON.stringify(acceptedResponse),
              correlation_id: correlationId,
            });

            // Outbox: inventory.reservation.released
            const releasedEvent = this.outboxService.createMessageEnvelope({
              eventName: 'inventory.reservation.released',
              kind: 'event',
              operationId: dto.operation_id,
              correlationId,
              data: {
                order_id: dto.order_id,
                reservation_id: reservaId,
                decided_at: new Date().toISOString(),
                reason_code: dto.reason,
              },
            });

            await this.outboxService.enqueue(client, {
              event_id: randomUUID(),
              event_type: 'inventory.reservation.released',
              aggregate_type: 'reservation',
              aggregate_id: reservaId,
              correlation_id: correlationId,
              payload: releasedEvent,
            });

            return acceptedResponse;
          },
        );
      if (expiredAfterLockRelease) {
        throw ProblemDetailsException.reservaNoActiva(
          'La reserva está expirada y no admite liberación',
          correlationId,
        );
      }
      return response;
    } catch (err: any) {
      if (
        err?.code === '23505' ||
        err?.message?.includes('duplicate key') ||
        err?.message?.includes('uq_') ||
        err?.message?.includes('uk_')
      ) {
        const concurrentOp =
          await this.operationsRepo.findByOperationIdOrIdempotencyKey(
            dto.operation_id,
            idempotencyKey,
          );
        if (concurrentOp) {
          if (
            concurrentOp.operation_id === dto.operation_id &&
            concurrentOp.idempotency_key === idempotencyKey &&
            concurrentOp.intention === 'liberar_reserva' &&
            concurrentOp.client_id === verifiedClientId &&
            this.idempotencyService.isMatchingFingerprint(
              concurrentOp.request_fingerprint,
              fingerprint,
            )
          ) {
            return durableAcceptedReplay(
              concurrentOp,
              {
                operation_id: dto.operation_id,
                order_id: dto.order_id,
                operation_type: 'LIBERAR',
              },
              correlationId,
            );
          }
          throw ProblemDetailsException.idempotencyConflict(
            'Conflicto de concurrencia o idempotencia detectado',
            correlationId,
          );
        }
      }
      throw err;
    }
  }

  /**
   * Ejecuta la expiración de una reserva de forma durable e independiente,
   * garantizando que el cambio ACTIVA -> EXPIRADA no sufra rollback accidental.
   */
  async expirarReservaDurable(
    reservationIdOrPk: string,
    _orderId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    return await this.databaseService.transaction<boolean>(async (txClient) => {
      let reserva = await this.reservationsRepo.findByReservationIdForUpdate(
        txClient,
        reservationIdOrPk,
      );
      if (!reserva) {
        reserva = await this.reservationsRepo.findByIdForUpdate(
          txClient,
          reservationIdOrPk,
        );
      }
      if (!reserva) {
        return false;
      }
      if (reserva.status !== 'ACTIVA') {
        return false;
      }

      const now = new Date();
      if (now.getTime() < new Date(reserva.expires_at).getTime()) {
        return false;
      }

      await this.expirarReservaInterna(
        txClient,
        reserva.id,
        reserva.reservation_id,
        reserva.order_id || '',
        correlationId || reserva.correlation_id || randomUUID(),
      );

      return true;
    });
  }

  private async expirarReservaInterna(
    client: IDatabaseClient,
    reservationPk: string,
    reservationId: string,
    orderId: string,
    correlationId: string,
  ): Promise<void> {
    const expirationOperationId = randomUUID();
    const statusUpdated = await this.reservationsRepo.updateStatus(
      client,
      reservationPk,
      'EXPIRADA',
    );
    if (statusUpdated !== 1) {
      throw new Error(
        `Inconsistencia: actualización de reserva afectó ${statusUpdated} filas al expirar`,
      );
    }

    const lines = (
      await this.reservationsRepo.findLinesByReservationPk(
        client,
        reservationPk,
      )
    ).sort(
      (a, b) =>
        a.sku_id.localeCompare(b.sku_id) ||
        a.location_id.localeCompare(b.location_id),
    );

    for (const line of lines) {
      const qty = Number(line.quantity);
      const bal = await this.stockBalanceRepo.findBySkuAndLocationForUpdate(
        client,
        line.sku_id,
        line.location_id,
      );

      if (!bal) {
        throw new Error(
          `Inconsistencia: saldo de stock no encontrado para sku '${line.sku_id}' en ubicación '${line.location_id}' al expirar reserva`,
        );
      }

      const reserved = Number(bal.reserved);
      if (reserved < qty) {
        throw new Error(
          `Inconsistencia: stock reservado (${reserved}) es menor a la cantidad a liberar (${qty}) para sku '${line.sku_id}' al expirar reserva`,
        );
      }

      const newReserved = reserved - qty;
      const newVersion = Number(bal.stock_version) + 1;

      const affected = await this.stockBalanceRepo.updateStock(
        client,
        line.sku_id,
        line.location_id,
        {
          reserved: newReserved,
          stock_version: newVersion,
        },
      );

      if (affected !== 1) {
        throw new Error(
          `Inconsistencia: la actualización de saldo para sku '${line.sku_id}' afectó ${affected} filas en lugar de 1`,
        );
      }

      await this.kardexService.recordMovement(client, {
        sku_id: line.sku_id,
        location_id: line.location_id,
        operation_type: 'EXPIRACION',
        reservation_id: reservationId,
        quantity: -qty,
        on_hand_before: Number(bal.on_hand),
        on_hand_after: Number(bal.on_hand),
        reserved_before: reserved,
        reserved_after: newReserved,
        blocked_before: Number(bal.blocked),
        blocked_after: Number(bal.blocked),
        stock_version: newVersion,
        correlation_id: correlationId,
      });
      await this.outboxService.stockChanged(client, {
        sku: line.sku_id,
        location_id: line.location_id,
        on_hand: Number(bal.on_hand),
        reserved: newReserved,
        blocked: Number(bal.blocked),
        stock_version: newVersion,
        operationId: expirationOperationId,
        correlationId,
      });
    }

    // Outbox: inventory.reservation.expired
    const expiredPayload = this.outboxService.createMessageEnvelope({
      eventName: 'inventory.reservation.expired',
      kind: 'event',
      operationId: expirationOperationId,
      correlationId,
      data: {
        order_id: orderId,
        reservation_id: reservationId,
        decided_at: new Date().toISOString(),
        reason_code: 'RESERVA_EXPIRADA',
      },
    });

    await this.outboxService.enqueue(client, {
      event_id: randomUUID(),
      event_type: 'inventory.reservation.expired',
      aggregate_type: 'reservation',
      aggregate_id: reservationId,
      correlation_id: correlationId,
      payload: expiredPayload,
    });
  }

  private async registrarRechazo(
    client: IDatabaseClient,
    dto: CrearReservaRequest,
    idempotencyKey: string,
    fingerprint: string,
    correlationId: string,
    resultCode: string,
    clientId?: string,
  ): Promise<OperacionInventarioAceptada> {
    const acceptedResponse: OperacionInventarioAceptada = {
      status: 'ACCEPTED',
      operation_id: dto.operation_id,
      order_id: dto.order_id,
      operation_type: 'RESERVAR',
      correlation_id: correlationId,
    };

    await this.operationsRepo.create(client, {
      operation_type: 'RESERVA',
      idempotency_key: idempotencyKey,
      intention: 'reservar',
      status: 'RECHAZADO',
      result_code: resultCode,
      order_id: dto.order_id,
      operation_id: dto.operation_id,
      client_id: clientId,
      request_fingerprint: fingerprint,
      request_payload: JSON.stringify(dto),
      // El comando HTTP queda aceptado (202); el rechazo de negocio durable
      // se expresa en status/result_code y en el evento de resultado.
      result_payload: JSON.stringify(acceptedResponse),
      correlation_id: correlationId,
    });

    const rejectedEvent = this.outboxService.createMessageEnvelope({
      eventName: 'inventory.reservation.rejected',
      kind: 'result',
      operationId: dto.operation_id,
      correlationId,
      data: {
        order_id: dto.order_id,
        result_code: resultCode,
        decided_at: new Date().toISOString(),
      },
    });

    await this.outboxService.enqueue(client, {
      event_id: randomUUID(),
      event_type: 'inventory.reservation.rejected',
      aggregate_type: 'reservation',
      aggregate_id: dto.operation_id,
      correlation_id: correlationId,
      payload: rejectedEvent,
    });

    // Se responde 202 Accepted indicando que el comando fue recibido
    // (el rechazo definitivo de negocio queda en inventory_operations y AsyncAPI)
    return acceptedResponse;
  }

  private async resolverUbicaciones(
    dto: CrearReservaRequest,
    correlationId: string,
  ): Promise<Array<{ sku: string; quantity: number; location_id: string }>> {
    const result: Array<{
      sku: string;
      quantity: number;
      location_id: string;
    }> = [];

    // Cargar ubicaciones activas
    const activeLocations = await this.locationsRepo.findActive();

    for (const line of dto.lines) {
      if (line.location_id) {
        if (!UUID_REGEX.test(line.location_id)) {
          throw ProblemDetailsException.validation(
            `location_id inválido: ${line.location_id}`,
            correlationId,
          );
        }
        const exists = activeLocations.some(
          (loc: any) => loc.id === line.location_id,
        );
        if (!exists) {
          throw ProblemDetailsException.validation(
            `Ubicación no encontrada o inactiva: ${line.location_id}`,
            correlationId,
          );
        }
        result.push({
          sku: line.sku,
          quantity: line.quantity,
          location_id: line.location_id,
        });
      } else {
        // location_id no proporcionado: consultar ruta de cumplimiento comercial
        const routeLocationId =
          await this.commercialRoutesRepo.findActiveByChannel(dto.channel_id);

        if (routeLocationId) {
          result.push({
            sku: line.sku,
            quantity: line.quantity,
            location_id: routeLocationId,
          });
        } else if (activeLocations.length === 1) {
          // Única ubicación inequívoca permitida por SPEC-015 §7.2
          result.push({
            sku: line.sku,
            quantity: line.quantity,
            location_id: activeLocations[0].id,
          });
        } else {
          // Múltiples ubicaciones y sin ruta unívoca: prohibido seleccionar implícitamente
          throw ProblemDetailsException.validation(
            `No se puede determinar una ubicación inequívoca para el canal ${dto.channel_id}. Especifique location_id en cada línea.`,
            correlationId,
          );
        }
      }
    }

    return result;
  }

  private validarCrearReservaInput(
    dto: CrearReservaRequest,
    correlationId: string,
  ): void {
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      throw ProblemDetailsException.validation(
        'El cuerpo de la solicitud no puede estar vacío',
        correlationId,
      );
    }
    if (
      !dto.order_id ||
      typeof dto.order_id !== 'string' ||
      dto.order_id.trim().length === 0
    ) {
      throw ProblemDetailsException.validation(
        'order_id es obligatorio y debe ser texto no vacío',
        correlationId,
      );
    }
    if (
      typeof dto.operation_id !== 'string' ||
      !UUID_REGEX.test(dto.operation_id)
    ) {
      throw ProblemDetailsException.validation(
        'operation_id debe ser un UUID válido',
        correlationId,
      );
    }
    const canalesValidos = ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'];
    if (!dto.channel_id || !canalesValidos.includes(dto.channel_id)) {
      throw ProblemDetailsException.validation(
        'channel_id inválido (debe ser MARKETPLACE, CHATBOT, RETAIL o VENTAS)',
        correlationId,
      );
    }
    if (!Array.isArray(dto.lines) || dto.lines.length === 0) {
      throw ProblemDetailsException.validation(
        'lines debe ser una lista con al menos un elemento',
        correlationId,
      );
    }

    for (const [idx, line] of dto.lines.entries()) {
      if (
        !line ||
        typeof line !== 'object' ||
        Array.isArray(line) ||
        !line.sku ||
        typeof line.sku !== 'string' ||
        line.sku.trim().length === 0
      ) {
        throw ProblemDetailsException.validation(
          `Línea ${idx + 1}: sku es obligatorio`,
          correlationId,
        );
      }
      if (
        typeof line.quantity !== 'number' ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity <= 0
      ) {
        throw ProblemDetailsException.cantidadInvalida(
          `Línea ${idx + 1}: quantity debe ser un entero positivo mayor a cero`,
          correlationId,
        );
      }
    }
  }

  private validarIdempotencyKey(key: string, correlationId: string): void {
    if (
      !key ||
      typeof key !== 'string' ||
      key.trim().length < 8 ||
      key.trim().length > 128
    ) {
      throw ProblemDetailsException.validation(
        'Idempotency-Key debe tener entre 8 y 128 caracteres',
        correlationId,
      );
    }
  }
}
