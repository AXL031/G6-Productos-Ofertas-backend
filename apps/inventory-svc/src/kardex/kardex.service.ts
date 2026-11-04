import { Injectable, Inject } from '@nestjs/common';
import { IDatabaseClient } from '../database/database.interface.js';
import { KARDEX_REPOSITORY } from '../repositories/interfaces/repository.tokens.js';
import type { IKardexRepository } from '../repositories/interfaces/kardex.repository.interface.js';

export interface KardexEntry {
  sku_id: string;
  location_id: string;
  operation_type:
    | 'RESERVA'
    | 'CONSUMO'
    | 'LIBERACION'
    | 'EXPIRACION'
    | 'AJUSTE_ABSOLUTO'
    | 'INCIDENCIA_BLOQUEO'
    | 'INCIDENCIA_RESOLUCION'
    | 'REINTEGRO'
    | 'CONCILIACION_OFFLINE'
    | 'RECEPCION_TRASLADO'
    | 'INICIALIZACION_SKU';
  operation_id?: string | null;
  reservation_id?: string | null;
  quantity: number;
  on_hand_before: number;
  on_hand_after: number;
  reserved_before: number;
  reserved_after: number;
  blocked_before: number;
  blocked_after: number;
  stock_version: number | bigint;
  correlation_id?: string | null;
}

@Injectable()
export class KardexService {
  constructor(
    @Inject(KARDEX_REPOSITORY)
    private readonly kardexRepository: IKardexRepository,
  ) {}

  async recordMovement(
    client: IDatabaseClient,
    entry: KardexEntry,
  ): Promise<void> {
    if (entry.quantity === 0) {
      return;
    }

    await this.kardexRepository.createMovement(client, {
      sku_id: entry.sku_id,
      location_id: entry.location_id,
      operation_type: entry.operation_type,
      operation_id: entry.operation_id ?? null,
      reservation_id: entry.reservation_id ?? null,
      quantity: entry.quantity,
      on_hand_before: entry.on_hand_before,
      on_hand_after: entry.on_hand_after,
      reserved_before: entry.reserved_before,
      reserved_after: entry.reserved_after,
      blocked_before: entry.blocked_before,
      blocked_after: entry.blocked_after,
      stock_version: Number(entry.stock_version),
      correlation_id: entry.correlation_id ?? null,
    });
  }
}
