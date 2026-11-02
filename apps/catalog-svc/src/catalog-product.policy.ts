import type { CatalogProductCreationPolicy } from './catalog-mutation.service.js';
import type { MutationInput } from './catalog-mutation.input.js';

/** Product owner approval in this task (2026-10-17): initial PEN intent and stable name + UUID slug. */
export const approvedCatalogProductPolicy: CatalogProductCreationPolicy =
  Object.freeze({
    resolve: async (input: MutationInput, productId: string) => {
      const name = input
        .nombre!.normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
      return { slug: (name || 'producto') + '-' + productId, moneda: 'PEN' };
    },
  });
