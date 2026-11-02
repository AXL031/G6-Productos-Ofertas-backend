import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import {
  CrearIncidenciaInventarioRequest,
  IncidenciaInventarioResponse,
  ResolucionIncidenciaInventario,
  ResolverIncidenciaInventarioRequest,
  TipoIncidenciaInventario,
} from '../types/inventory.dto.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  OPERATIONS_REPOSITORY,
  STOCK_BALANCE_REPOSITORY,
  LOCATIONS_REPOSITORY,
  INCIDENTS_REPOSITORY,
  TRASLADOS_REPOSITORY,
} from '../repositories/interfaces/repository.tokens.js';
import type { IOperationsRepository } from '../repositories/interfaces/operations.repository.interface.js';
import type { IStockBalanceRepository } from '../repositories/interfaces/stock-balance.repository.interface.js';
import type { ILocationsRepository } from '../repositories/interfaces/locations.repository.interface.js';
import type { IIncidentsRepository } from '../repositories/interfaces/incidents.repository.interface.js';
import type { ITrasladosRepository } from '../repositories/interfaces/traslados.repository.interface.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TIPOS_INCIDENCIA: TipoIncidenciaInventario[] = [
  'DANIO',
  'NO_UBICADA',
  'OTRO_FISICO',
];

const RESOLUCIONES: ResolucionIncidenciaInventario[] = [
  'REHABILITADO',
  'MERMA',
  'FALTANTE_CONFIRMADO',
  'TRASLADO_ALMACEN_CENTRAL',
];

const INTENCION_REPORTAR = 'reportar_incidencia';
const INTENCION_RESOLVER = 'resolver_incidencia';

function parseDurablePayload<T>(
  op: { result_payload?: unknown },
  correlationId: string,
): T {
  let payload = op.result_payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw ProblemDetailsException.idempotencyConflict(
        'El resultado durable de la incidencia es inconsistente',
        correlationId,
      );
    }
  }
  if (!payload || typeof payload !== 'object') {
    throw ProblemDetailsException.idempotencyConflict(
      'El resultado durable de la incidencia es inconsistente',
      correlationId,
    );
  }
  return payload as T;
}

/**
 * Incidencias físicas de inventario (SPEC-015, OpenAPI IncidenciaInventario).
 * Retail reporta un hecho físico; Inventario sigue siendo la única autoridad
 * del saldo: bloquea únicamente unidades disponibles y confirma la cuarentena
 * antes de responder.
 */
@Injectable()
export class IncidenciasService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly idempotencyService: IdempotencyService,
    private readonly kardexService: KardexService,
    private readonly outboxService: OutboxService,
    @Inject(OPERATIONS_REPOSITORY)
    private readonly operationsRepo: IOperationsRepository,
    @Inject(STOCK_BALANCE_REPOSITORY)
    private readonly stockBalanceRepo: IStockBalanceRepository,
    @Inject(LOCATIONS_REPOSITORY)
    private readonly locationsRepo: ILocationsRepository,
    @Inject(INCIDENTS_REPOSITORY)
    private readonly incidentsRepo: IIncidentsRepository,
    @Inject(TRASLADOS_REPOSITORY)
    private readonly trasladosRepo: ITrasladosRepository,
  ) {}

  async reportarIncidencia(
    dto: CrearIncidenciaInventarioRequest,
    correlationIdHeader?: string,
    idempotencyKeyHeader?: string,
    clientId?: string,
  ): Promise<IncidenciaInventarioResponse> {
    const correlationId = correlationIdHeader || randomUUID();
    const idempotencyKey = this.requireIdempotencyKey(
      idempotencyKeyHeader,
      correlationId,
    );
    this.requireClientId(clientId, correlationId);
    this.validarReporte(dto, correlationId);

    const fingerprint = this.idempotencyService.computeFingerprint({
      external_incident_id: dto.external_incident_id,
      sku: dto.sku,
      quantity: dto.quantity,
      location_id: dto.location_id,
      type: dto.type,
      intention: INTENCION_REPORTAR,
    });

    const existingOp =
      await this.operationsRepo.findByOperationIdOrIdempotencyKey(
        dto.operation_id,
        idempotencyKey,
      );
    if (existingOp) {
      return this.handleExistingOperation(
        existingOp,
        dto,
        idempotencyKey,
        fingerprint,
        clientId as string,
        INTENCION_REPORTAR,
        correlationId,
      );
    }

    try {
      return await this.databaseService.transaction<IncidenciaInventarioResponse>(
        async (client) => {
          await this.operationsRepo.lockIdempotencyKey(client, idempotencyKey);
          const concurrent =
            await this.operationsRepo.findByOperationIdOrIdempotencyKey(
              dto.operation_id,
              idempotencyKey,
              client,
            );
          if (concurrent) {
            return this.handleExistingOperation(
              concurrent,
              dto,
              idempotencyKey,
              fingerprint,
              clientId as string,
              INTENCION_REPORTAR,
              correlationId,
            );
          }

          await this.assertUbicacionActiva(
            this.locationsRepo,
            client,
            dto.location_id,
            correlationId,
          );

          const bal = await this.stockBalanceRepo.findBySkuAndLocationForUpdate(
            client,
            dto.sku,
            dto.location_id,
          );
          if (!bal) {
            throw ProblemDetailsException.skuNoEncontrado(
              `No existe saldo para el SKU '${dto.sku}' en la ubicación '${dto.location_id}'`,
              correlationId,
            );
          }

          const onHand = Number(bal.on_hand);
          const reserved = Number(bal.reserved);
          const blocked = Number(bal.blocked);
          const available = Math.max(0, onHand - reserved - blocked);
          if (dto.quantity > available) {
            throw ProblemDetailsException.stockInsuficiente(
              `Solo hay ${available} unidad(es) disponible(s) para bloquear en cuarentena`,
              correlationId,
            );
          }

          const newBlocked = blocked + dto.quantity;
          const newVersion = Number(bal.stock_version) + 1;

          await this.updateStockStrict(client, dto.sku, dto.location_id, {
            blocked: newBlocked,
            stock_version: newVersion,
          });

          await this.kardexService.recordMovement(client, {
            sku_id: dto.sku,
            location_id: dto.location_id,
            operation_type: 'INCIDENCIA_BLOQUEO',
            operation_id: dto.operation_id,
            quantity: dto.quantity,
            on_hand_before: onHand,
            on_hand_after: onHand,
            reserved_before: reserved,
            reserved_after: reserved,
            blocked_before: blocked,
            blocked_after: newBlocked,
            stock_version: newVersion,
            correlation_id: correlationId,
          });

          const incidenciaId = randomUUID();
          const incidencia = await this.incidentsRepo.create(client, {
            incidencia_id: incidenciaId,
            sku_id: dto.sku,
            location_id: dto.location_id,
            external_incident_id: dto.external_incident_id,
            cantidad_bloqueada: dto.quantity,
            idempotency_key: idempotencyKey,
            correlation_id: correlationId,
          });

          const response: IncidenciaInventarioResponse = {
            incidencia_id: incidencia.incidencia_id,
            operation_id: dto.operation_id,
            external_incident_id: dto.external_incident_id,
            sku: dto.sku,
            quantity: dto.quantity,
            location_id: dto.location_id,
            type: dto.type,
            estado: 'ABIERTA',
            resolution: null,
            on_hand: onHand,
            reserved,
            blocked: newBlocked,
            available: Math.max(0, onHand - reserved - newBlocked),
            stock_version: newVersion,
            transfer_ref: null,
            updated_at: incidencia.updated_at || new Date().toISOString(),
          };

          await this.operationsRepo.create(client, {
            operation_type: 'INCIDENCIA_BLOQUEO',
            idempotency_key: idempotencyKey,
            intention: INTENCION_REPORTAR,
            status: 'APLICADO',
            operation_id: dto.operation_id,
            client_id: clientId,
            request_fingerprint: fingerprint,
            request_payload: JSON.stringify(dto),
            result_payload: JSON.stringify(response),
            correlation_id: correlationId,
          });

          await this.emitStockChanged(client, response, correlationId);

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
        this.handleExistingOperation(
          op,
          dto,
          idempotencyKey,
          fingerprint,
          clientId as string,
          INTENCION_REPORTAR,
          correlationId,
        ),
      );
    }
  }

  async resolverIncidencia(
    incidenciaId: string,
    dto: ResolverIncidenciaInventarioRequest,
    correlationIdHeader?: string,
    idempotencyKeyHeader?: string,
    clientId?: string,
  ): Promise<IncidenciaInventarioResponse> {
    const correlationId = correlationIdHeader || randomUUID();
    const idempotencyKey = this.requireIdempotencyKey(
      idempotencyKeyHeader,
      correlationId,
    );
    this.requireClientId(clientId, correlationId);
    if (!incidenciaId || !UUID_REGEX.test(incidenciaId)) {
      throw ProblemDetailsException.validation(
        'incidenciaId debe ser un UUID válido',
        correlationId,
      );
    }
    this.validarResolucion(dto, correlationId);

    const fingerprint = this.idempotencyService.computeFingerprint({
      incidencia_id: incidenciaId,
      resolution: dto.resolution,
      act_ref: dto.act_ref,
      target_location_id: dto.target_location_id ?? null,
      intention: INTENCION_RESOLVER,
    });

    const existingOp =
      await this.operationsRepo.findByOperationIdOrIdempotencyKey(
        dto.operation_id,
        idempotencyKey,
      );
    if (existingOp) {
      return this.handleExistingResolution(
        existingOp,
        incidenciaId,
        dto,
        idempotencyKey,
        fingerprint,
        clientId as string,
        correlationId,
      );
    }

    try {
      return await this.databaseService.transaction<IncidenciaInventarioResponse>(
        async (client) => {
          await this.operationsRepo.lockIdempotencyKey(client, idempotencyKey);
          const concurrent =
            await this.operationsRepo.findByOperationIdOrIdempotencyKey(
              dto.operation_id,
              idempotencyKey,
              client,
            );
          if (concurrent) {
            return this.handleExistingResolution(
              concurrent,
              incidenciaId,
              dto,
              idempotencyKey,
              fingerprint,
              clientId as string,
              correlationId,
            );
          }

          const incidencia =
            await this.incidentsRepo.findByIncidenciaIdForUpdate(
              client,
              incidenciaId,
            );
          if (!incidencia) {
            throw ProblemDetailsException.incidenciaNoEncontrada(
              `No existe la incidencia '${incidenciaId}'`,
              correlationId,
            );
          }
          if (incidencia.estado !== 'ABIERTA') {
            throw ProblemDetailsException.incidenciaNoActiva(
              `La incidencia '${incidenciaId}' ya fue resuelta`,
              correlationId,
            );
          }

          const bal = await this.stockBalanceRepo.findBySkuAndLocationForUpdate(
            client,
            incidencia.sku_id,
            incidencia.location_id,
          );
          if (!bal) {
            throw ProblemDetailsException.skuNoEncontrado(
              `No existe saldo para el SKU '${incidencia.sku_id}' en la ubicación '${incidencia.location_id}'`,
              correlationId,
            );
          }

          const qty = incidencia.cantidad_bloqueada;
          const onHand = Number(bal.on_hand);
          const reserved = Number(bal.reserved);
          const blocked = Number(bal.blocked);
          if (blocked < qty) {
            throw ProblemDetailsException.resolucionIncidenciaInvalida(
              `El bloqueo actual (${blocked}) es menor a la cantidad de la incidencia (${qty})`,
              correlationId,
            );
          }

          const esTraslado = dto.resolution === 'TRASLADO_ALMACEN_CENTRAL';
          const reduceOnHand =
            dto.resolution === 'MERMA' ||
            dto.resolution === 'FALTANTE_CONFIRMADO' ||
            esTraslado;

          const newBlocked = blocked - qty;
          const newOnHand = reduceOnHand ? onHand - qty : onHand;
          const newVersion = Number(bal.stock_version) + 1;

          await this.updateStockStrict(
            client,
            incidencia.sku_id,
            incidencia.location_id,
            {
              on_hand: newOnHand,
              blocked: newBlocked,
              stock_version: newVersion,
            },
          );

          await this.kardexService.recordMovement(client, {
            sku_id: incidencia.sku_id,
            location_id: incidencia.location_id,
            operation_type: 'INCIDENCIA_RESOLUCION',
            operation_id: dto.operation_id,
            quantity: qty,
            on_hand_before: onHand,
            on_hand_after: newOnHand,
            reserved_before: reserved,
            reserved_after: reserved,
            blocked_before: blocked,
            blocked_after: newBlocked,
            stock_version: newVersion,
            correlation_id: correlationId,
          });

          let transferRef: string | null = null;
          let estado: 'RESUELTA' | 'TRASLADO_PENDIENTE' = 'RESUELTA';

          if (esTraslado) {
            const targetLocationId = dto.target_location_id as string;
            await this.assertUbicacionActiva(
              this.locationsRepo,
              client,
              targetLocationId,
              correlationId,
            );
            const traslado = await this.trasladosRepo.create(client, {
              traslado_id: randomUUID(),
              source_incident_id: incidencia.incidencia_id,
              sku_id: incidencia.sku_id,
              source_location_id: incidencia.location_id,
              target_location_id: targetLocationId,
              quantity_shipped: qty,
            });
            transferRef = traslado.traslado_id;
            estado = 'TRASLADO_PENDIENTE';
          }

          const updated = await this.incidentsRepo.resolve(client, {
            id: incidencia.id,
            estado,
            tipo_resolucion: dto.resolution,
            act_ref: dto.act_ref,
          });

          // El modelo físico no persiste el tipo físico reportado; se recupera
          // del payload durable de la operación de bloqueo original.
          const reportOp =
            await this.operationsRepo.findIncidenciaBloqueoByIncidenciaId(
              incidenciaId,
              client,
            );
          const tipoFisico =
            (
              reportOp?.request_payload as
                CrearIncidenciaInventarioRequest | null | undefined
            )?.type ?? 'OTRO_FISICO';

          const response: IncidenciaInventarioResponse = {
            incidencia_id: incidencia.incidencia_id,
            operation_id: dto.operation_id,
            external_incident_id: incidencia.external_incident_id ?? '',
            sku: incidencia.sku_id,
            quantity: qty,
            location_id: incidencia.location_id,
            type: tipoFisico,
            estado,
            resolution: dto.resolution,
            on_hand: newOnHand,
            reserved,
            blocked: newBlocked,
            available: Math.max(0, newOnHand - reserved - newBlocked),
            stock_version: newVersion,
            transfer_ref: transferRef,
            updated_at: updated.updated_at || new Date().toISOString(),
          };

          await this.operationsRepo.create(client, {
            operation_type: 'INCIDENCIA_RESOLUCION',
            idempotency_key: idempotencyKey,
            intention: INTENCION_RESOLVER,
            status: 'APLICADO',
            operation_id: dto.operation_id,
            client_id: clientId,
            request_fingerprint: fingerprint,
            request_payload: JSON.stringify({ incidenciaId, ...dto }),
            result_payload: JSON.stringify(response),
            correlation_id: correlationId,
          });

          await this.emitStockChanged(client, response, correlationId);

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
        this.handleExistingResolution(
          op,
          incidenciaId,
          dto,
          idempotencyKey,
          fingerprint,
          clientId as string,
          correlationId,
        ),
      );
    }
  }

  private handleExistingOperation(
    op: Awaited<
      ReturnType<IOperationsRepository['findByOperationIdOrIdempotencyKey']>
    >,
    dto: CrearIncidenciaInventarioRequest,
    idempotencyKey: string,
    fingerprint: string,
    clientId: string,
    intention: string,
    correlationId: string,
  ): IncidenciaInventarioResponse {
    return this.assertReplayable(
      op,
      dto.operation_id,
      idempotencyKey,
      fingerprint,
      clientId,
      intention,
      correlationId,
      (payload) => payload.operation_id === dto.operation_id,
    );
  }

  private handleExistingResolution(
    op: Awaited<
      ReturnType<IOperationsRepository['findByOperationIdOrIdempotencyKey']>
    >,
    incidenciaId: string,
    dto: ResolverIncidenciaInventarioRequest,
    idempotencyKey: string,
    fingerprint: string,
    clientId: string,
    correlationId: string,
  ): IncidenciaInventarioResponse {
    return this.assertReplayable(
      op,
      dto.operation_id,
      idempotencyKey,
      fingerprint,
      clientId,
      INTENCION_RESOLVER,
      correlationId,
      (payload) =>
        payload.operation_id === dto.operation_id &&
        payload.incidencia_id === incidenciaId,
    );
  }

  private assertReplayable(
    op: Awaited<
      ReturnType<IOperationsRepository['findByOperationIdOrIdempotencyKey']>
    >,
    operationId: string,
    idempotencyKey: string,
    fingerprint: string,
    clientId: string,
    intention: string,
    correlationId: string,
    validate: (payload: IncidenciaInventarioResponse) => boolean,
  ): IncidenciaInventarioResponse {
    if (!op) {
      throw ProblemDetailsException.idempotencyConflict(
        'Conflicto de concurrencia o idempotencia detectado',
        correlationId,
      );
    }
    if (
      op.idempotency_key === idempotencyKey &&
      op.operation_id !== operationId
    ) {
      throw ProblemDetailsException.idempotencyConflict(
        'La clave Idempotency-Key ya fue utilizada para otra operación',
        correlationId,
      );
    }
    if (
      op.operation_id === operationId &&
      op.idempotency_key !== idempotencyKey
    ) {
      throw ProblemDetailsException.idempotencyConflict(
        'El operation_id ya fue utilizado con otra Idempotency-Key',
        correlationId,
      );
    }
    if (
      op.intention === intention &&
      op.client_id === clientId &&
      this.idempotencyService.isMatchingFingerprint(
        op.request_fingerprint,
        fingerprint,
      )
    ) {
      const payload = parseDurablePayload<IncidenciaInventarioResponse>(
        op,
        correlationId,
      );
      if (validate(payload)) {
        return payload;
      }
    }
    throw ProblemDetailsException.idempotencyConflict(
      'operation_id o Idempotency-Key ya fue utilizado con otra intención o contenido',
      correlationId,
    );
  }

  private async recoverFromDuplicate<T>(
    err: any,
    finder: () => Promise<T | null>,
  ): Promise<T> {
    if (
      err?.code === '23505' ||
      err?.message?.includes('duplicate key') ||
      err?.message?.includes('uq_') ||
      err?.message?.includes('uk_')
    ) {
      const op = await finder();
      if (op) return op;
    }
    throw err;
  }

  private async updateStockStrict(
    client: any,
    sku: string,
    locationId: string,
    values: { on_hand?: number; blocked: number; stock_version: number },
  ): Promise<void> {
    const updated = await this.stockBalanceRepo.updateStock(
      client,
      sku,
      locationId,
      values,
    );
    if (updated !== 1) {
      throw new Error(
        `Inconsistencia: la actualización de saldo para el SKU '${sku}' afectó ${updated} filas`,
      );
    }
  }

  private async assertUbicacionActiva(
    repo: ILocationsRepository,
    client: any,
    locationId: string,
    correlationId: string,
  ): Promise<void> {
    const active = await repo.findActive(client);
    if (!active.some((loc) => loc.id === locationId)) {
      throw ProblemDetailsException.ubicacionNoEncontrada(
        `Ubicación no encontrada o inactiva: ${locationId}`,
        correlationId,
      );
    }
  }

  private async emitStockChanged(
    client: any,
    response: IncidenciaInventarioResponse,
    correlationId: string,
  ): Promise<void> {
    await this.outboxService.stockChanged(client, {
      ...response,
      operationId: response.operation_id,
      correlationId,
    });
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

  private requireClientId(
    clientId: string | undefined,
    correlationId: string,
  ): void {
    if (typeof clientId !== 'string' || clientId.trim().length === 0) {
      throw ProblemDetailsException.tokenInvalido(
        'El token verificado no contiene una identidad de cliente',
        correlationId,
      );
    }
  }

  private validarReporte(
    dto: CrearIncidenciaInventarioRequest,
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
      !dto.external_incident_id ||
      typeof dto.external_incident_id !== 'string' ||
      dto.external_incident_id.trim().length === 0 ||
      dto.external_incident_id.length > 128
    ) {
      throw ProblemDetailsException.validation(
        'external_incident_id es obligatorio (1..128 caracteres)',
        correlationId,
      );
    }
    if (
      !dto.sku ||
      typeof dto.sku !== 'string' ||
      dto.sku.trim().length === 0
    ) {
      throw ProblemDetailsException.validation(
        'sku es obligatorio',
        correlationId,
      );
    }
    if (
      typeof dto.quantity !== 'number' ||
      !Number.isSafeInteger(dto.quantity) ||
      dto.quantity < 1
    ) {
      throw ProblemDetailsException.cantidadInvalida(
        'quantity debe ser un entero mayor o igual a 1',
        correlationId,
      );
    }
    if (
      !dto.location_id ||
      typeof dto.location_id !== 'string' ||
      !UUID_REGEX.test(dto.location_id)
    ) {
      throw ProblemDetailsException.ubicacionNoEncontrada(
        'location_id debe ser un UUID válido',
        correlationId,
      );
    }
    if (!dto.type || !TIPOS_INCIDENCIA.includes(dto.type)) {
      throw ProblemDetailsException.validation(
        `type inválido (debe ser ${TIPOS_INCIDENCIA.join(', ')})`,
        correlationId,
      );
    }
    if (
      !dto.occurred_at ||
      typeof dto.occurred_at !== 'string' ||
      Number.isNaN(Date.parse(dto.occurred_at))
    ) {
      throw ProblemDetailsException.validation(
        'occurred_at es obligatorio y debe ser una fecha ISO-8601 válida',
        correlationId,
      );
    }
  }

  private validarResolucion(
    dto: ResolverIncidenciaInventarioRequest,
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
    if (!dto.resolution || !RESOLUCIONES.includes(dto.resolution)) {
      throw ProblemDetailsException.resolucionIncidenciaInvalida(
        `resolution inválida (debe ser ${RESOLUCIONES.join(', ')})`,
        correlationId,
      );
    }
    if (
      !dto.act_ref ||
      typeof dto.act_ref !== 'string' ||
      dto.act_ref.trim().length === 0 ||
      dto.act_ref.length > 128
    ) {
      throw ProblemDetailsException.validation(
        'act_ref es obligatorio (1..128 caracteres)',
        correlationId,
      );
    }
    if (
      dto.resolution === 'TRASLADO_ALMACEN_CENTRAL' &&
      (!dto.target_location_id ||
        typeof dto.target_location_id !== 'string' ||
        !UUID_REGEX.test(dto.target_location_id))
    ) {
      throw ProblemDetailsException.resolucionIncidenciaInvalida(
        'target_location_id es obligatorio (UUID) para TRASLADO_ALMACEN_CENTRAL',
        correlationId,
      );
    }
  }
}
