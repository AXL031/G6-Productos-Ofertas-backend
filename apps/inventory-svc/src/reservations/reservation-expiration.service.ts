import { Injectable, Logger, Inject } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { ReservationsService } from './reservations.service.js';
import { RESERVATIONS_REPOSITORY } from '../repositories/interfaces/repository.tokens.js';
import type { IReservationsRepository } from '../repositories/interfaces/reservations.repository.interface.js';
import { SanitizedLogger } from '../logging/sanitized-logger.js';

@Injectable()
export class ReservationExpirationService {
  private readonly logger = new SanitizedLogger(
    new Logger(ReservationExpirationService.name),
  );

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly reservationsService: ReservationsService,
    @Inject(RESERVATIONS_REPOSITORY)
    private readonly reservationsRepo: IReservationsRepository,
  ) {}

  /**
   * Procesa la expiración automática de reservas cuyo TTL haya vencido.
   * Utiliza selección de registros vencidos y bloqueo transaccional desacoplado
   * garantizando que múltiples workers no colisionen ni dupliquen eventos de expiración.
   */
  async expirarReservasVencidas(
    limit = 50,
  ): Promise<{ procesadas: number; expiradas: number; fallidas: number }> {
    const querySql = `
      SELECT id, reservation_id, order_id, correlation_id, expires_at
      FROM inventory.reservations
      WHERE status = 'ACTIVA' AND expires_at <= now()
      ORDER BY expires_at ASC
      LIMIT $1
    `;

    let expiredCandidates: any[] = [];
    try {
      const res = await this.databaseService.query(querySql, [limit]);
      expiredCandidates = res.rows;
    } catch (dbErr) {
      this.logger.warn(
        `Error al consultar reservas vencidas para expiración: ${(dbErr as Error).message}`,
      );
      throw dbErr;
    }

    if (expiredCandidates.length === 0) {
      return { procesadas: 0, expiradas: 0, fallidas: 0 };
    }

    let expiradas = 0;
    let fallidas = 0;

    for (const row of expiredCandidates) {
      try {
        const result = await this.reservationsService.expirarReservaDurable(
          row.reservation_id,
          row.order_id,
          row.correlation_id || undefined,
        );
        if (result) {
          expiradas++;
        }
      } catch (expErr) {
        fallidas++;
        this.logger.error(
          `Error al expirar automáticamente la reserva ${row.reservation_id}: ${(expErr as Error).message}`,
        );
      }
    }

    return {
      procesadas: expiredCandidates.length,
      expiradas,
      fallidas,
    };
  }
}
