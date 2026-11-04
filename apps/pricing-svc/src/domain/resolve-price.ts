import {
  contains,
  requireRule,
  validateTarget,
  PriceRuleError,
  type PriceDefinition,
} from './price.js';

// Contexto de Catálogo recibido por el caller; sin JOIN ni proyección autoritativa.
export function resolvePrice(
  definitions: readonly PriceDefinition[],
  context: { productId: string; sku?: string | null; isVariant: boolean },
  channelId: string | null,
  at: Date,
) {
  requireRule(Number.isFinite(at.getTime()), 'VALIDACION');
  const sku = context.sku ?? '';
  requireRule(
    context.productId.length > 0 && (!context.isVariant || sku.length > 0),
    'SCOPE_PRECIO_INVALIDO',
  );
  const targets = context.isVariant
    ? [
        { productId: null, sku },
        { productId: context.productId, sku: null },
      ]
    : [{ productId: context.productId, sku: null }];
  for (const target of targets) {
    for (const channel of channelId === null ? [null] : [channelId, null]) {
      const definition = definitions.find((candidate) => {
        validateTarget(candidate.target);
        return (
          candidate.target.productId === target.productId &&
          candidate.target.sku === target.sku &&
          candidate.channelId === channel
        );
      });
      const validity = definition?.validities.find((candidate) =>
        contains(candidate, at),
      );
      if (definition && validity) {
        return {
          definition,
          validity,
          origen:
            target.sku === null
              ? ('PRODUCTO' as const)
              : ('SKU_OVERRIDE' as const),
        };
      }
    }
  }
  throw new PriceRuleError('PRECIO_NO_ENCONTRADO');
}
