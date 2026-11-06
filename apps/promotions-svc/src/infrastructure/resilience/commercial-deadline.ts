import {
  CommercialDependencyError,
  CommercialInputError,
  type CommercialContext,
  type BasketRequest,
  type CommercialReadContext,
} from '../../domain/commercial-context.js';
import { withDeadline } from './deadline.js';

// Bounds the internal port even when a test/provider replacement hangs. Future
// authenticated adapters must pass the signal to transport and close on abort.
export class BoundedCommercialContext implements CommercialContext {
  constructor(
    private readonly source: CommercialContext,
    private readonly milliseconds = 2500,
  ) {}
  private async call<T>(
    operation: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      return await withDeadline(work, this.milliseconds);
    } catch (error) {
      if (
        error instanceof CommercialDependencyError ||
        error instanceof CommercialInputError
      )
        throw error;
      throw new CommercialDependencyError(
        operation,
        'Catálogo/Pricing/Inventario + integración G6/G7',
        'adaptador autenticado completo que respete cancelación y el límite de espera; sin reintento implícito',
      );
    }
  }
  basket(
    request: BasketRequest,
    at: string,
    parent?: AbortSignal,
    context?: CommercialReadContext,
  ) {
    return this.call('evaluarPromociones/validarCupon', (signal) =>
      this.source.basket(
        request,
        at,
        parent ? AbortSignal.any([parent, signal]) : signal,
        context,
      ),
    );
  }
  recommendationOrigin(
    productId: string,
    channel: string,
    parent?: AbortSignal,
    context?: CommercialReadContext,
  ) {
    return this.call('obtenerRecomendaciones/origen', (signal) =>
      this.source.recommendationOrigin(
        productId,
        channel,
        parent ? AbortSignal.any([parent, signal]) : signal,
        context,
      ),
    );
  }
  recommendationProducts(
    ids: readonly string[],
    channel: string,
    parent?: AbortSignal,
    context?: CommercialReadContext,
  ) {
    return this.call('obtenerRecomendaciones/productos', (signal) =>
      this.source.recommendationProducts(
        ids,
        channel,
        parent ? AbortSignal.any([parent, signal]) : signal,
        context,
      ),
    );
  }
}
