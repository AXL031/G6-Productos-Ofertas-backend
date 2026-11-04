import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import {
  MotivoReintegroInventario,
  ReintegroInventarioRequest,
  ReintegroInventarioResponse,
  ReintegroLineaResultado,
} from '../types/inventory.dto.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  OPERATIONS_REPOSITORY,
  STOCK_BALANCE_REPOSITORY,
  LOCATIONS_REPOSITORY,
} from '../repositories/interfaces/repository.tokens.js';
import type { IOperationsRepository } from '../repositories/interfaces/operations.repository.interface.js';
import type { IStockBalanceRepository } from '../repositories/interfaces/stock-balance.repository.interface.js';
import type { ILocationsRepository } from '../repositories/interfaces/locations.repository.interface.js';
import { KNOWN_CLIENTS } from '../auth/auth.constants.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_INTEGER_MAX = 2_147_483_647;

function isStockQuantity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= PG_INTEGER_MAX
  );
}

const MOTIVOS_REINTEGRO: readonly MotivoReintegroInventario[] = [
  'DEVOLUCION_ACEPTADA',
  'ANULACION_POST_CONSUMO',
  'RETORNO_LOGISTICO',
];

function durableReintegroReplay(
  op: { result_payload?: unknown },
  expected: {
    operation_id: string;
    order_id: string;
    source_ref: string;
    lines: ReintegroInventarioRequest['lines'];
  },
  correlationId: string,
): ReintegroInventarioResponse {
  let payload = op.result_payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw ProblemDetailsException.idempotencyConflict(
        'El resultado durable del reintegro es inconsistente',
        correlationId,
      );
    }
  }
  const result = payload as ReintegroInventarioResponse | null;
  if (
    !result ||
    typeof result !== 'object' ||
    result.status !== 'COMPLETED' ||
    result.operation_id !== expected.operation_id ||
    result.order_id !== expected.order_id ||
    result.source_ref !== expected.source_ref ||
    !Array.isArray(result.lines) ||
    typeof result.completed_at !== 'string' ||
    !Number.isFinite(Date.parse(result.completed_at))
  ) {
    throw ProblemDetailsException.idempotencyConflict(
      'El resultado durable del reintegro es inconsistente',
      correlationId,
    );
  }
  const quantities = new Map<string, number>();
  for (const line of expected.lines) {
    const key = JSON.stringify([line.sku, line.location_id]);
    quantities.set(key, (quantities.get(key) ?? 0) + line.quantity);
  }
  for (const line of result.lines) {
    const key = line && JSON.stringify([line.sku, line.location_id]);
    if (
      !line ||
      !key ||
      !quantities.has(key) ||
      line.quantity !== quantities.get(key) ||
      !isStockQuantity(line.on_hand) ||
      !isStockQuantity(line.reserved) ||
      !isStockQuantity(line.blocked) ||
      !isStockQuantity(line.available) ||
      line.reserved + line.blocked > line.on_hand ||
      line.available !== line.on_hand - line.reserved - line.blocked ||
      !Number.isSafeInteger(line.stock_version) ||
      line.stock_version < 0
    ) {
      throw ProblemDetailsException.idempotencyConflict(
        'El resultado durable del reintegro es inconsistente',
        correlationId,
      );
    }
    quantities.delete(key);
  }
  if (quantities.size !== 0) {
    throw ProblemDetailsException.idempotencyConflict(
      'El resultado durable del reintegro es inconsistente',
      correlationId,
    );
  }
  return result;
}

@Injectable()
export class ReintegrosService {
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
  ) {}

  /**
   * Reiniega unidades físicamente recibidas y aptas para reventa
   * (POST /api/v1/inventario/reintegros, SPEC-015 §24.1).
   *
   * Efecto: on_hand += quantity; blocked no cambia; available se recalcula;
   * stock_version += 1. Registra Kardex, inventory_operations y publica
   * inventory.stock.changed. Un retry idéntico no duplica efectos.
   */
  async reintegrarInventario(
    dto: ReintegroInventarioRequest,
    correlationIdHeader?: string,
    idempotencyKeyHeader?: string,
    clientId?: string,
  ): Promise<ReintegroInventarioResponse> {
    const correlationId = correlationIdHeader || randomUUID();
    const verifiedClientId = clientId;

    if (!idempotencyKeyHeader) {
      throw ProblemDetailsException.validation(
        'El encabezado Idempotency-Key es obligatorio para reintegrar inventario',
        correlationId,
      );
    }
    this.validarIdempotencyKey(idempotencyKeyHeader, correlationId);
    const idempotencyKey = idempotencyKeyHeader;

    if (
      typeof verifiedClientId !== 'string' ||
      verifiedClientId.trim().length === 0
    ) {
      throw ProblemDetailsException.tokenInvalido(
        'El token verificado no contiene una identidad de cliente',
        correlationId,
      );
    }

    this.validarReintegroInput(dto, correlationId);

    // Precondición F3 (SPEC-015 §24.1, FLOW-015 §4.7): el motivo
    // DEVOLUCION_ACEPTADA solo lo ejecuta M2/Postventa tras recepción física
    // apta; M1/Ventas queda admitido para los otros motivos contractuales.
    if (
      dto.reason === 'DEVOLUCION_ACEPTADA' &&
      verifiedClientId !== KNOWN_CLIENTS.POSTVENTA
    ) {
      throw ProblemDetailsException.reintegroNoAplicable(
        'El reintegro F3 con reason DEVOLUCION_ACEPTADA corresponde a modulo-postventa',
        correlationId,
      );
    }

    const fingerprint = this.idempotencyService.computeFingerprint({
      order_id: dto.order_id,
      source_ref: dto.source_ref,
      reason: dto.reason,
      lines: dto.lines,
      intention: 'reintegrar',
    });

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
        existingOp.intention === 'reintegrar' &&
        existingOp.client_id === verifiedClientId &&
        this.idempotencyService.isMatchingFingerprint(
          existingOp.request_fingerprint,
          fingerprint,
        )
      ) {
        return durableReintegroReplay(
          existingOp,
          {
            operation_id: dto.operation_id,
            order_id: dto.order_id,
            source_ref: dto.source_ref,
            lines: dto.lines,
          },
          correlationId,
        );
      }
      throw ProblemDetailsException.idempotencyConflict(
        'operation_id o Idempotency-Key ya fue utilizado con otra intención o contenido',
        correlationId,
      );
    }

    try {
      return await this.databaseService.transaction<ReintegroInventarioResponse>(
        async (client) => {
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
              concurrentReplay.intention === 'reintegrar' &&
              concurrentReplay.client_id === verifiedClientId &&
              this.idempotencyService.isMatchingFingerprint(
                concurrentReplay.request_fingerprint,
                fingerprint,
              )
            ) {
              return durableReintegroReplay(
                concurrentReplay,
                {
                  operation_id: dto.operation_id,
                  order_id: dto.order_id,
                  source_ref: dto.source_ref,
                  lines: dto.lines,
                },
                correlationId,
              );
            }
            throw ProblemDetailsException.idempotencyConflict(
              'operation_id o Idempotency-Key ya fue utilizado con otra intención o contenido',
              correlationId,
            );
          }

          // Agrupar líneas por (sku, location_id) y ordenar para evitar deadlocks.
          const lineMap = new Map<
            string,
            { sku: string; location_id: string; quantity: number }
          >();
          for (const line of dto.lines) {
            const key = `${line.sku}:::${line.location_id}`;
            const existing = lineMap.get(key);
            if (existing) {
              existing.quantity += line.quantity;
              if (existing.quantity > PG_INTEGER_MAX) {
                throw ProblemDetailsException.cantidadInvalida(
                  'La cantidad agrupada excede el rango de almacenamiento del inventario',
                  correlationId,
                );
              }
            } else {
              lineMap.set(key, {
                sku: line.sku,
                location_id: line.location_id,
                quantity: line.quantity,
              });
            }
          }
          const groupedLines = Array.from(lineMap.values()).sort((a, b) => {
            const c = a.sku.localeCompare(b.sku);
            return c !== 0 ? c : a.location_id.localeCompare(b.location_id);
          });

          const activeLocations = await this.locationsRepo.findActive(client);
          const activeLocationIds = new Set(
            activeLocations.map((loc) => loc.id),
          );

          const results: ReintegroLineaResultado[] = [];

          for (const item of groupedLines) {
            if (!activeLocationIds.has(item.location_id)) {
              throw ProblemDetailsException.ubicacionNoEncontrada(
                `Ubicación no encontrada o inactiva: ${item.location_id}`,
                correlationId,
              );
            }

            const bal =
              await this.stockBalanceRepo.findBySkuAndLocationForUpdate(
                client,
                item.sku,
                item.location_id,
              );

            if (!bal) {
              throw ProblemDetailsException.skuNoEncontrado(
                `No existe saldo para el SKU '${item.sku}' en la ubicación '${item.location_id}'`,
                correlationId,
              );
            }

            const onHand = Number(bal.on_hand);
            const reserved = Number(bal.reserved);
            const blocked = Number(bal.blocked);
            const newOnHand = onHand + item.quantity;
            const newVersion = Number(bal.stock_version) + 1;
            if (newOnHand > PG_INTEGER_MAX) {
              throw ProblemDetailsException.cantidadInvalida(
                'El reintegro excede el saldo máximo de almacenamiento del inventario',
                correlationId,
              );
            }

            const updatedCount = await this.stockBalanceRepo.updateStock(
              client,
              item.sku,
              item.location_id,
              {
                on_hand: newOnHand,
                stock_version: newVersion,
              },
            );
            if (updatedCount !== 1) {
              throw new Error(
                `Inconsistencia: la actualización de saldo para el SKU '${item.sku}' afectó ${updatedCount} filas`,
              );
            }

            await this.kardexService.recordMovement(client, {
              sku_id: item.sku,
              location_id: item.location_id,
              operation_type: 'REINTEGRO',
              operation_id: dto.operation_id,
              quantity: item.quantity,
              on_hand_before: onHand,
              on_hand_after: newOnHand,
              reserved_before: reserved,
              reserved_after: reserved,
              blocked_before: blocked,
              blocked_after: blocked,
              stock_version: newVersion,
              correlation_id: correlationId,
            });

            results.push({
              sku: item.sku,
              location_id: item.location_id,
              quantity: item.quantity,
              on_hand: newOnHand,
              reserved,
              blocked,
              available: Math.max(0, newOnHand - reserved - blocked),
              stock_version: newVersion,
            });
          }

          const response: ReintegroInventarioResponse = {
            operation_id: dto.operation_id,
            order_id: dto.order_id,
            source_ref: dto.source_ref,
            status: 'COMPLETED',
            lines: results,
            completed_at: new Date().toISOString(),
          };

          await this.operationsRepo.create(client, {
            operation_type: 'REINTEGRO',
            idempotency_key: idempotencyKey,
            intention: 'reintegrar',
            status: 'APLICADO',
            order_id: dto.order_id,
            operation_id: dto.operation_id,
            client_id: verifiedClientId,
            request_fingerprint: fingerprint,
            request_payload: JSON.stringify(dto),
            result_payload: JSON.stringify(response),
            correlation_id: correlationId,
          });

          for (const item of results) {
            await this.outboxService.stockChanged(client, {
              ...item,
              operationId: dto.operation_id,
              correlationId,
            });
          }

          return response;
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
            concurrentOp.intention === 'reintegrar' &&
            concurrentOp.client_id === verifiedClientId &&
            this.idempotencyService.isMatchingFingerprint(
              concurrentOp.request_fingerprint,
              fingerprint,
            )
          ) {
            return durableReintegroReplay(
              concurrentOp,
              {
                operation_id: dto.operation_id,
                order_id: dto.order_id,
                source_ref: dto.source_ref,
                lines: dto.lines,
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

  private validarReintegroInput(
    dto: ReintegroInventarioRequest,
    correlationId: string,
  ): void {
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
        'order_id es obligatorio y debe ser texto no vacío',
        correlationId,
      );
    }
    if (
      !dto.source_ref ||
      typeof dto.source_ref !== 'string' ||
      dto.source_ref.trim().length === 0
    ) {
      throw ProblemDetailsException.validation(
        'source_ref es obligatorio y debe ser texto no vacío',
        correlationId,
      );
    }
    if (!dto.reason || !MOTIVOS_REINTEGRO.includes(dto.reason)) {
      throw ProblemDetailsException.validation(
        `reason inválido (debe ser ${MOTIVOS_REINTEGRO.join(', ')})`,
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
        line.quantity <= 0 ||
        line.quantity > PG_INTEGER_MAX
      ) {
        throw ProblemDetailsException.cantidadInvalida(
          `Línea ${idx + 1}: quantity debe ser un entero entre 1 y ${PG_INTEGER_MAX}`,
          correlationId,
        );
      }
      if (
        !line.location_id ||
        typeof line.location_id !== 'string' ||
        line.location_id.trim().length === 0
      ) {
        throw ProblemDetailsException.validation(
          `Línea ${idx + 1}: location_id es obligatorio`,
          correlationId,
        );
      }
      if (!UUID_REGEX.test(line.location_id)) {
        throw ProblemDetailsException.ubicacionNoEncontrada(
          `Línea ${idx + 1}: location_id debe ser un UUID válido`,
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
