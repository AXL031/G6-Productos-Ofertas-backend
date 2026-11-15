import type { ContractRoute } from './contract-route.js';

/** Private Catalog-to-Pricing operations are never routable by the external Gateway. */
export const PHASE1_INTERNAL_READ_ROUTES: readonly ContractRoute[] = [];
