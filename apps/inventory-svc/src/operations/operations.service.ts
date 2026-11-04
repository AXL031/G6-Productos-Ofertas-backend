import { Injectable, Inject } from '@nestjs/common';
import {
  ConsultaOperacionInventario,
  OperacionInventarioTipo,
  OperacionInventarioEstado,
} from '../types/inventory.dto.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  OPERATIONS_REPOSITORY,
  RESERVATIONS_REPOSITORY,
} from '../repositories/interfaces/repository.tokens.js';
import type { IOperationsRepository } from '../repositories/interfaces/operations.repository.interface.js';
import type { IReservationsRepository } from '../repositories/interfaces/reservations.repository.interface.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class OperationsService {
  constructor(
    @Inject(OPERATIONS_REPOSITORY)
    private readonly operationsRepository: IOperationsRepository,
    @Inject(RESERVATIONS_REPOSITORY)
    private readonly reservationsRepository: IReservationsRepository,
  ) {}

  /**
   * Consulta el resultado durable persistido de una operación de inventario (GET /api/v1/inventario/operaciones/{operationId})
   */
  async consultarOperacion(
    operationId: string,
    correlationId?: string,
  ): Promise<ConsultaOperacionInventario> {
    if (!UUID_REGEX.test(operationId)) {
      throw ProblemDetailsException.validation(
        'operationId debe ser un UUID válido',
        correlationId,
      );
    }

    const op = await this.operationsRepository.findByOperationId(operationId);

    if (!op) {
      throw ProblemDetailsException.operacionNoEncontrada(
        'Operación de inventario no encontrada',
        correlationId,
      );
    }

    let expiresAt: string | null = null;
    if (op.reservation_id) {
      const res = await this.reservationsRepository.findByReservationId(
        op.reservation_id,
      );
      if (res?.expires_at) {
        if (!Number.isFinite(Date.parse(res.expires_at))) {
          throw ProblemDetailsException.operacionNoEncontrada(
            'El resultado histórico no contiene un vencimiento válido',
            correlationId,
          );
        }
        expiresAt = new Date(res.expires_at).toISOString();
      }
    }

    // Mapear tipos y estados al contrato OpenAPI
    const opTypeMap: Record<string, OperacionInventarioTipo> = {
      RESERVA: 'RESERVAR',
      CONSUMO: 'CONFIRMAR_CONSUMO',
      LIBERACION: 'LIBERAR',
      REINTEGRO: 'REINTEGRAR',
      CONCILIACION_OFFLINE: 'CONCILIAR_OFFLINE',
    };

    const statusMap: Record<string, OperacionInventarioEstado> = {
      RECIBIDO: 'ACCEPTED',
      APLICADO: 'COMPLETED',
      RECHAZADO: 'REJECTED',
      REQUIRES_REVIEW: 'REQUIRES_REVIEW',
    };

    const operationType = opTypeMap[op.operation_type];
    const status = statusMap[op.status];
    if (
      !operationType ||
      !status ||
      !op.operation_id ||
      !op.order_id?.trim() ||
      !op.accepted_at ||
      !Number.isFinite(Date.parse(op.accepted_at)) ||
      (op.applied_at != null && !Number.isFinite(Date.parse(op.applied_at))) ||
      (status === 'REJECTED' && !op.result_code?.trim())
    ) {
      throw ProblemDetailsException.operacionNoEncontrada(
        'La operación histórica no contiene un resultado durable suficiente para reproducirse',
        correlationId,
      );
    }

    const result: ConsultaOperacionInventario = {
      operation_id: op.operation_id,
      order_id: op.order_id,
      operation_type: operationType,
      status,
      reservation_id: op.reservation_id || null,
      expires_at: expiresAt,
      result_code: op.result_code || null,
      accepted_at: new Date(op.accepted_at).toISOString(),
      completed_at: op.applied_at
        ? new Date(op.applied_at).toISOString()
        : null,
    };

    return result;
  }
}
