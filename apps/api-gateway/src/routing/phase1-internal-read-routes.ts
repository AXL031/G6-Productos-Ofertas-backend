import type { ContractRoute } from './contract-route.js';

/** User-authorized academic exception. Never registered in phases 2 or 3.
 * Metadata copied from Docs a7778ec1 OpenAPI; no contract file modified.
 */
export const PHASE1_INTERNAL_READ_ROUTES: readonly ContractRoute[] = [
  {
    method: 'GET',
    path: '/api/v1/productos/skus/{sku}/contexto',
    operationId: 'obtenerContextoSku',
    service: 'catalog-svc',
    security: ['serviceBearer'],
    scope: 'catalogo:leer',
    audience: 'api-productos',
    clients: ['modulo-productos'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['SKU_NO_ENCONTRADO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
];
