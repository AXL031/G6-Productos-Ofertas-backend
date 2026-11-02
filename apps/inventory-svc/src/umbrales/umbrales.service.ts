import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import { UmbralInventario } from '../types/inventory.dto.js';
import { THRESHOLDS_REPOSITORY } from '../repositories/interfaces/repository.tokens.js';
import type { IThresholdsRepository } from '../repositories/interfaces/thresholds.repository.interface.js';

@Injectable()
export class UmbralesService {
  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(THRESHOLDS_REPOSITORY)
    private readonly thresholdsRepository: IThresholdsRepository,
  ) {}

  /**
   * Umbral efectivo global y overrides por SKU (SPEC-015/016). El umbral global
   * por defecto proviene de la configuración cuando no existe override global.
   */
  async obtenerUmbrales(correlationId?: string): Promise<UmbralInventario> {
    const [globalOverride, overrides] = await Promise.all([
      this.thresholdsRepository.getGlobalThreshold(),
      this.thresholdsRepository.listSkuOverrides(),
    ]);

    const umbralGlobal =
      globalOverride ?? loadInventoryConfig().defaultLowStockThreshold;

    void correlationId;
    return {
      umbralGlobal,
      overrides: overrides.map((o) => ({
        sku: o.sku_id,
        umbral: o.umbral_efectivo,
      })),
    };
  }

  async actualizarUmbralGlobal(
    umbral: unknown,
    correlationId?: string,
  ): Promise<UmbralInventario> {
    const value = this.assertUmbralValido(umbral, correlationId);
    await this.databaseService.transaction(async (client) => {
      await this.thresholdsRepository.setGlobalThreshold(client, value);
    });
    return this.obtenerUmbrales(correlationId);
  }

  async establecerUmbralSku(
    sku: string,
    umbral: unknown,
    correlationId?: string,
  ): Promise<UmbralInventario> {
    const normalizedSku = this.assertSku(sku, correlationId);
    const value = this.assertUmbralValido(umbral, correlationId);

    await this.databaseService.transaction(async (client) => {
      const existe = await this.thresholdsRepository.existsStockForSku(
        normalizedSku,
        client,
      );
      if (!existe) {
        throw ProblemDetailsException.skuNoEncontrado404(
          `El SKU '${normalizedSku}' no está registrado en el inventario`,
          correlationId,
        );
      }
      await this.thresholdsRepository.upsertSkuOverride(
        client,
        normalizedSku,
        value,
      );
    });

    return this.obtenerUmbrales(correlationId);
  }

  async eliminarUmbralSku(sku: string, correlationId?: string): Promise<void> {
    const normalizedSku = this.assertSku(sku, correlationId);

    await this.databaseService.transaction(async (client) => {
      const existe = await this.thresholdsRepository.existsStockForSku(
        normalizedSku,
        client,
      );
      if (!existe) {
        throw ProblemDetailsException.skuNoEncontrado404(
          `El SKU '${normalizedSku}' no está registrado en el inventario`,
          correlationId,
        );
      }
      await this.thresholdsRepository.deleteSkuOverride(client, normalizedSku);
    });
  }

  private assertUmbralValido(umbral: unknown, correlationId?: string): number {
    if (typeof umbral !== 'number' || !Number.isInteger(umbral) || umbral < 0) {
      throw ProblemDetailsException.validation(
        'El campo umbral es obligatorio y debe ser un entero mayor o igual a 0',
        correlationId,
      );
    }
    return umbral;
  }

  private assertSku(sku: string, correlationId?: string): string {
    const normalized = typeof sku === 'string' ? sku.trim() : '';
    if (normalized.length === 0) {
      throw ProblemDetailsException.validation(
        'El SKU es obligatorio en la ruta',
        correlationId,
      );
    }
    return normalized;
  }
}
