import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import type { IDatabaseClient } from '../database/database.interface.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  DisponibilidadStock,
  DisposicionRecepcionTraslado,
  EstadoTrasladoInventario,
  ListadoTrasladosInventario,
  RecepcionTrasladoInventarioRequest,
  RecepcionTrasladoInventarioResponse,
  TrasladoInventario,
} from '../types/inventory.dto.js';
import {
  OPERATIONS_REPOSITORY,
  STOCK_BALANCE_REPOSITORY,
  TRASLADOS_REPOSITORY,
} from '../repositories/interfaces/repository.tokens.js';
import type { IOperationsRepository } from '../repositories/interfaces/operations.repository.interface.js';
import type { IStockBalanceRepository } from '../repositories/interfaces/stock-balance.repository.interface.js';
import type {
  ITrasladosRepository,
  TrasladoEntity,
} from '../repositories/interfaces/traslados.repository.interface.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ESTADOS: EstadoTrasladoInventario[] = [
  'EN_TRANSITO',
  'RECIBIDO_PARCIAL',
  'COMPLETADO',
  'COMPLETADO_CON_DISCREPANCIA',
];

const DISPOSICIONES: DisposicionRecepcionTraslado[] = [
  'REINGRESAR_DISPONIBLE',
  'REINGRESAR_BLOQUEADO',
  'CONFIRMAR_MERMA',
];

const INTENCION_RECEPCION = 'recepcion_traslado';

export interface ListarTrasladosFiltros {
  estado?: string;
  target_location_id?: string;
  pagina?: number | string;
  tamanio?: number | string;
}

@Injectable()
export class TrasladosService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly idempotencyService: IdempotencyService,
    private readonly kardexService: KardexService,
    private readonly outboxService: OutboxService,
    @Inject(OPERATIONS_REPOSITORY)
    private readonly operationsRepo: IOperationsRepository,
    @Inject(STOCK_BALANCE_REPOSITORY)
    private readonly stockBalanceRepo: IStockBalanceRepository,
    @Inject(TRASLADOS_REPOSITORY)
    private readonly trasladosRepo: ITrasladosRepository,
  ) {}

  async listarTraslados(
    filtros: ListarTrasladosFiltros,
    correlationId?: string,
  ): Promise<ListadoTrasladosInventario> {
    const pagina = this.parsePagina(filtros.pagina, correlationId);
    const tamanio = this.parseTamanio(filtros.tamanio, correlationId);

    if (filtros.estado && !ESTADOS.includes(filtros.estado as never)) {
      throw ProblemDetailsException.validation(
        `estado inválido (debe ser ${ESTADOS.join(', ')})`,
        correlationId,
      );
    }

    if (
      filtros.target_location_id !== undefined &&
      (typeof filtros.target_location_id !== 'string' ||
        !UUID_REGEX.test(filtros.target_location_id))
    ) {
      throw ProblemDetailsException.validation(
        'target_location_id debe ser un UUID válido',
        correlationId,
      );
    }

    const { items, total } = await this.trasladosRepo.list({
      estado: filtros.estado,
      targetLocationId: filtros.target_location_id,
      pagina,
      tamanio,
    });

    return {
      items: items.map((t) => this.toDto(t)),
      pagina,
      tamanio,
      total,
    };
  }

  async obtenerTraslado(
    trasladoId: string,
    correlationId?: string,
  ): Promise<TrasladoInventario> {
    if (!trasladoId || !UUID_REGEX.test(trasladoId)) {
      throw ProblemDetailsException.validation(
        'trasladoId debe ser un UUID válido',
        correlationId,
      );
    }
    const traslado = await this.trasladosRepo.findByTrasladoId(trasladoId);
    if (!traslado) {
      throw ProblemDetailsException.trasladoNoEncontrado(
        `No existe el traslado '${trasladoId}'`,
        correlationId,
      );
    }
    return this.toDto(traslado);
  }

  async registrarRecepcion(
    trasladoId: string,
    dto: RecepcionTrasladoInventarioRequest,
    correlationIdHeader?: string,
    idempotencyKeyHeader?: string,
    subGestor?: string,
  ): Promise<RecepcionTrasladoInventarioResponse> {
    const correlationId = correlationIdHeader || randomUUID();
    const idempotencyKey = this.requireIdempotencyKey(
      idempotencyKeyHeader,
      correlationId,
    );
    if (!subGestor || subGestor.trim().length === 0) {
      throw ProblemDetailsException.tokenInvalido(
        'El token verificado no contiene sub (gestor autorizado)',
        correlationId,
      );
    }
    if (!trasladoId || !UUID_REGEX.test(trasladoId)) {
      throw ProblemDetailsException.validation(
        'trasladoId debe ser un UUID válido',
        correlationId,
      );
    }
    this.validarRecepcion(dto, correlationId);

    const fingerprint = this.idempotencyService.computeFingerprint({
      traslado_id: trasladoId,
      received_quantity: dto.received_quantity,
      disposition: dto.disposition,
      final_receipt: dto.final_receipt,
      received_at: dto.received_at,
      note: dto.note ?? null,
      intention: INTENCION_RECEPCION,
    });

    const existingOp =
      await this.operationsRepo.findByOperationIdOrIdempotencyKey(
        dto.operation_id,
        idempotencyKey,
      );
    if (existingOp) {
      return this.handleExisting(
        existingOp,
        trasladoId,
        dto,
        idempotencyKey,
        fingerprint,
        subGestor,
        correlationId,
      );
    }

    try {
      return await this.databaseService.transaction<RecepcionTrasladoInventarioResponse>(
        async (client) => {
          await this.operationsRepo.lockIdempotencyKey(client, idempotencyKey);
          const concurrent =
            await this.operationsRepo.findByOperationIdOrIdempotencyKey(
              dto.operation_id,
              idempotencyKey,
              client,
            );
          if (concurrent) {
            return this.handleExisting(
              concurrent,
              trasladoId,
              dto,
              idempotencyKey,
              fingerprint,
              subGestor,
              correlationId,
            );
          }

          const traslado = await this.trasladosRepo.findByIdForUpdate(
            client,
            trasladoId,
          );
          if (!traslado) {
            throw ProblemDetailsException.trasladoNoEncontrado(
              `No existe el traslado '${trasladoId}'`,
              correlationId,
            );
          }
          if (
            traslado.estado !== 'EN_TRANSITO' &&
            traslado.estado !== 'RECIBIDO_PARCIAL'
          ) {
            throw ProblemDetailsException.trasladoNoRecibible(
              `El traslado '${trasladoId}' está ${traslado.estado} y no admite más recepciones`,
              correlationId,
            );
          }

          const pendiente =
            traslado.quantity_shipped - traslado.quantity_received;
          if (dto.received_quantity > pendiente) {
            throw ProblemDetailsException.cantidadRecibidaExcedeTraslado(
              `received_quantity (${dto.received_quantity}) excede lo pendiente (${pendiente})`,
              correlationId,
            );
          }

          let destinationBalance: DisponibilidadStock | null = null;

          if (dto.disposition !== 'CONFIRMAR_MERMA') {
            const blockedDelta =
              dto.disposition === 'REINGRESAR_BLOQUEADO'
                ? dto.received_quantity
                : 0;
            const after = await this.stockBalanceRepo.upsertOnHandDelta(
              client,
              traslado.sku_id,
              traslado.target_location_id,
              { on_hand: dto.received_quantity, blocked: blockedDelta },
            );

            await this.kardexService.recordMovement(client, {
              sku_id: traslado.sku_id,
              location_id: traslado.target_location_id,
              operation_type: 'RECEPCION_TRASLADO',
              operation_id: dto.operation_id,
              quantity: dto.received_quantity,
              on_hand_before: after.on_hand - dto.received_quantity,
              on_hand_after: after.on_hand,
              reserved_before: after.reserved,
              reserved_after: after.reserved,
              blocked_before: after.blocked - blockedDelta,
              blocked_after: after.blocked,
              stock_version: after.stock_version,
              correlation_id: correlationId,
            });

            await this.outboxService.stockChanged(client, {
              sku: traslado.sku_id,
              ...after,
              operationId: dto.operation_id,
              correlationId,
            });
            destinationBalance = await this.buildDisponibilidad(
              client,
              traslado.sku_id,
              traslado.target_location_id,
              after.on_hand,
              after.reserved,
              after.blocked,
            );
          }

          const recepcionId = randomUUID();
          await this.trasladosRepo.createRecepcion(client, {
            recepcion_id: recepcionId,
            traslado_pk: traslado.id,
            cantidad_recibida: dto.received_quantity,
            disposicion: dto.disposition,
            es_recepcion_final: dto.final_receipt,
            sub_gestor: subGestor,
            idempotency_key: idempotencyKey,
            received_at: dto.received_at,
          });

          const nuevoRecibido =
            traslado.quantity_received + dto.received_quantity;
          const faltante = traslado.quantity_shipped - nuevoRecibido;
          let nuevoEstado: EstadoTrasladoInventario;
          if (faltante === 0) {
            nuevoEstado = 'COMPLETADO';
          } else if (dto.final_receipt) {
            nuevoEstado = 'COMPLETADO_CON_DISCREPANCIA';
          } else {
            nuevoEstado = 'RECIBIDO_PARCIAL';
          }

          const updated = await this.trasladosRepo.update(client, {
            id: traslado.id,
            quantity_received: nuevoRecibido,
            missing_quantity: faltante,
            estado: nuevoEstado,
          });

          const completedAt = updated.updated_at || new Date().toISOString();
          const response: RecepcionTrasladoInventarioResponse = {
            receipt_id: recepcionId,
            operation_id: dto.operation_id,
            traslado: this.toDto(updated),
            disposition: dto.disposition,
            received_quantity: dto.received_quantity,
            destination_balance: destinationBalance,
            completed_at: completedAt,
          };

          await this.operationsRepo.create(client, {
            operation_type: 'RECEPCION_TRASLADO',
            idempotency_key: idempotencyKey,
            intention: INTENCION_RECEPCION,
            status: 'APLICADO',
            operation_id: dto.operation_id,
            client_id: subGestor,
            request_fingerprint: fingerprint,
            request_payload: JSON.stringify({ trasladoId, ...dto }),
            result_payload: JSON.stringify(response),
            correlation_id: correlationId,
          });

          return response;
        },
      );
    } catch (err) {
      return this.recoverFromDuplicate(err, () =>
        this.operationsRepo.findByOperationIdOrIdempotencyKey(
          dto.operation_id,
          idempotencyKey,
        ),
      ).then((op) =>
        this.handleExisting(
          op,
          trasladoId,
          dto,
          idempotencyKey,
          fingerprint,
          subGestor,
          correlationId,
        ),
      );
    }
  }

  private async buildDisponibilidad(
    client: IDatabaseClient,
    sku: string,
    locationId: string,
    onHand: number,
    reserved: number,
    blocked: number,
  ): Promise<DisponibilidadStock> {
    const defaultThreshold = loadInventoryConfig().defaultLowStockThreshold;
    const overrides =
      await this.stockBalanceRepo.findThresholdOverrides(client);
    let globalThreshold = defaultThreshold;
    let skuThreshold: number | undefined;
    for (const row of overrides) {
      if (row.sku_id === null) {
        globalThreshold = Number(row.umbral_efectivo);
      } else if (row.sku_id === sku) {
        skuThreshold = Number(row.umbral_efectivo);
      }
    }
    const threshold = skuThreshold ?? globalThreshold;
    const available = Math.max(0, onHand - reserved - blocked);
    const status =
      available === 0
        ? 'AGOTADO'
        : available <= threshold
          ? 'STOCK_BAJO'
          : 'DISPONIBLE';
    return {
      sku,
      location_id: locationId,
      on_hand: onHand,
      reserved,
      blocked,
      available,
      status,
      threshold,
    };
  }

  private handleExisting(
    op: Awaited<
      ReturnType<IOperationsRepository['findByOperationIdOrIdempotencyKey']>
    >,
    trasladoId: string,
    dto: RecepcionTrasladoInventarioRequest,
    idempotencyKey: string,
    fingerprint: string,
    subGestor: string,
    correlationId: string,
  ): RecepcionTrasladoInventarioResponse {
    if (!op) {
      throw ProblemDetailsException.idempotencyConflict(
        'Conflicto de concurrencia o idempotencia detectado',
        correlationId,
      );
    }
    if (
      op.idempotency_key === idempotencyKey &&
      op.operation_id !== dto.operation_id
    ) {
      throw ProblemDetailsException.idempotencyConflict(
        'La clave Idempotency-Key ya fue utilizada para otra operación',
        correlationId,
      );
    }
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
      op.intention === INTENCION_RECEPCION &&
      op.client_id === subGestor &&
      this.idempotencyService.isMatchingFingerprint(
        op.request_fingerprint,
        fingerprint,
      )
    ) {
      let payload = op.result_payload;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          throw ProblemDetailsException.idempotencyConflict(
            'El resultado durable de la recepción es inconsistente',
            correlationId,
          );
        }
      }
      const result = payload as RecepcionTrasladoInventarioResponse | null;
      if (
        result &&
        typeof result === 'object' &&
        result.operation_id === dto.operation_id &&
        result.traslado?.traslado_id === trasladoId
      ) {
        return result;
      }
    }
    throw ProblemDetailsException.idempotencyConflict(
      'operation_id o Idempotency-Key ya fue utilizado con otra intención o contenido',
      correlationId,
    );
  }

  private async recoverFromDuplicate<T>(
    err: unknown,
    finder: () => Promise<T | null>,
  ): Promise<T> {
    const error = err as { code?: unknown; message?: unknown } | null;
    const message = typeof error?.message === 'string' ? error.message : '';
    if (
      error?.code === '23505' ||
      message.includes('duplicate key') ||
      message.includes('uq_') ||
      message.includes('uk_')
    ) {
      const op = await finder();
      if (op) return op;
    }
    throw err;
  }

  private toDto(t: TrasladoEntity): TrasladoInventario {
    return {
      traslado_id: t.traslado_id,
      source_incident_id: t.source_incident_id ?? null,
      sku: t.sku_id,
      quantity_shipped: t.quantity_shipped,
      quantity_received: t.quantity_received,
      missing_quantity: t.missing_quantity ?? 0,
      source_location_id: t.source_location_id,
      target_location_id: t.target_location_id,
      estado: t.estado,
      created_at: t.created_at ?? '',
      updated_at: t.updated_at ?? '',
    };
  }

  private parsePagina(
    value: number | string | undefined,
    correlationId?: string,
  ): number {
    if (value === undefined || value === null || value === '') return 1;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) {
      throw ProblemDetailsException.validation(
        'pagina debe ser un entero mayor o igual a 1',
        correlationId,
      );
    }
    return n;
  }

  private parseTamanio(
    value: number | string | undefined,
    correlationId?: string,
  ): number {
    if (value === undefined || value === null || value === '') return 20;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw ProblemDetailsException.validation(
        'tamanio debe ser un entero entre 1 y 100',
        correlationId,
      );
    }
    return n;
  }

  private requireIdempotencyKey(
    key: string | undefined,
    correlationId: string,
  ): string {
    if (!key) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio',
        correlationId,
      );
    }
    if (key.trim().length < 8 || key.trim().length > 128) {
      throw ProblemDetailsException.validation(
        'Idempotency-Key debe tener entre 8 y 128 caracteres',
        correlationId,
      );
    }
    return key;
  }

  private validarRecepcion(
    dto: RecepcionTrasladoInventarioRequest,
    correlationId: string,
  ): void {
    if (!dto || typeof dto !== 'object') {
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
      typeof dto.received_quantity !== 'number' ||
      !Number.isSafeInteger(dto.received_quantity) ||
      dto.received_quantity < 1
    ) {
      throw ProblemDetailsException.cantidadRecibidaExcedeTraslado(
        'received_quantity debe ser un entero mayor o igual a 1',
        correlationId,
      );
    }
    if (!dto.disposition || !DISPOSICIONES.includes(dto.disposition)) {
      throw ProblemDetailsException.disposicionRecepcionInvalida(
        `disposition inválida (debe ser ${DISPOSICIONES.join(', ')})`,
        correlationId,
      );
    }
    if (typeof dto.final_receipt !== 'boolean') {
      throw ProblemDetailsException.validation(
        'final_receipt es obligatorio y debe ser booleano',
        correlationId,
      );
    }
    if (
      !dto.received_at ||
      typeof dto.received_at !== 'string' ||
      Number.isNaN(Date.parse(dto.received_at))
    ) {
      throw ProblemDetailsException.validation(
        'received_at es obligatorio y debe ser una fecha ISO-8601 válida',
        correlationId,
      );
    }
    if (
      dto.note !== undefined &&
      dto.note !== null &&
      (typeof dto.note !== 'string' || dto.note.length > 500)
    ) {
      throw ProblemDetailsException.validation(
        'note debe ser una cadena de máximo 500 caracteres',
        correlationId,
      );
    }
  }
}
