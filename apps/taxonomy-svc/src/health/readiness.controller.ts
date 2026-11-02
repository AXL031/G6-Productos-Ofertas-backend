import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import { ProblemDetailsException } from '../errors/taxonomy.errors.js';
import { TaxonomyAmqpRuntime } from '../domain/taxonomy-amqp.runtime.js';
import { TAXONOMY_READINESS } from './readiness.port.js';
import type { TaxonomyReadinessIndicator } from './readiness.port.js';

export interface RespuestaReadiness {
  status: 'ready';
  service: 'taxonomy-svc';
}

@Controller('health')
export class ReadinessController {
  constructor(
    @Inject(TAXONOMY_READINESS)
    private readonly indicador: TaxonomyReadinessIndicator,
    private readonly amqp: TaxonomyAmqpRuntime,
  ) {}

  @Get('readiness')
  async obtenerReadiness(): Promise<RespuestaReadiness> {
    await this.ejecutarReadiness();
    return { status: 'ready', service: 'taxonomy-svc' };
  }

  @Get('ready')
  async obtenerReady(): Promise<RespuestaReadiness> {
    await this.ejecutarReadiness();
    return { status: 'ready', service: 'taxonomy-svc' };
  }

  private async ejecutarReadiness(): Promise<void> {
    const ind = this.indicador as unknown as
      | {
          verificarReadiness?: () => Promise<void>;
          readiness?: () => Promise<boolean>;
        }
      | null
      | undefined;
    try {
      if (!this.amqp.disponible())
        throw ProblemDetailsException.noDisponible(
          'Mensajería de taxonomía no disponible.',
        );
      if (typeof ind?.verificarReadiness === 'function') {
        await ind.verificarReadiness();
        return;
      }
      if (typeof ind?.readiness === 'function') {
        const ok = await ind.readiness();
        if (!ok) {
          throw ProblemDetailsException.noDisponible(
            'Fuente de datos de taxonomía no disponible.',
          );
        }
        return;
      }
      throw ProblemDetailsException.noDisponible(
        'Indicador de readiness de taxonomía no implementado.',
      );
    } catch (error) {
      if (
        error instanceof ProblemDetailsException &&
        error.getStatus() === HttpStatus.SERVICE_UNAVAILABLE
      ) {
        throw error;
      }
      throw ProblemDetailsException.noDisponible(
        'Fuente de datos de taxonomía no disponible.',
      );
    }
  }
}
