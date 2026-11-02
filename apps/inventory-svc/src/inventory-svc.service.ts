import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database/database.service.js';

@Injectable()
export class InventorySvcService {
  constructor(private readonly databaseService: DatabaseService) {}

  getHealth() {
    return {
      status: 'ok',
      service: 'inventory-svc',
    };
  }

  async getHealthDetailed() {
    const db = await this.databaseService.isHealthy();
    return {
      status: 'ok',
      service: 'inventory-svc',
      database: db.healthy ? 'connected' : 'unreachable',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness: verifica únicamente dependencias propias del servicio
   * (conectividad PostgreSQL). No expone secretos ni detalles internos.
   * El broker RabbitMQ es opcional: su ausencia conserva eventos PENDING en el
   * Outbox y no impide atender peticiones, por lo que no bloquea el readiness.
   */
  async getReadiness(): Promise<{
    status: 'ready' | 'not_ready';
    service: 'inventory-svc';
  }> {
    const db = await this.databaseService.isHealthy();
    return {
      status: db.healthy ? 'ready' : 'not_ready',
      service: 'inventory-svc',
    };
  }
}
