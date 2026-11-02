export const REQUIRED_SCOPE_KEY = 'required_scope';
export const ALLOWED_CLIENTS_KEY = 'allowed_clients';
export const REQUIRED_CAPABILITY_KEY = 'required_capability';
export const ALLOW_USER_BEARER_KEY = 'allow_user_bearer';

export const EXPECTED_AUDIENCE = 'api-productos';
export const EXPECTED_ALGORITHM = 'RS256';
export const EXPECTED_TOKEN_TYPE = 'servicio';

export function getConfiguredIssuer(): string | null {
  const issuer = process.env.G7_JWT_ISSUER?.trim();
  return issuer ? issuer : null;
}

export const INVENTORY_SCOPES = {
  RESERVAR: 'inventario:reservar',
  CONSUMIR: 'inventario:consumir',
  LIBERAR: 'inventario:liberar',
  OPERACIONES_LEER: 'inventario:operaciones:leer',
  DISPONIBILIDAD_LEER: 'inventario:disponibilidad:leer',
  REINTEGRAR: 'inventario:reintegrar',
  INCIDENCIAS_REPORTAR: 'inventario:incidencias:reportar',
  INCIDENCIAS_RESOLVER: 'inventario:incidencias:resolver',
  CONCILIAR_OFFLINE: 'inventario:conciliar-offline',
} as const;

export const KNOWN_CLIENTS = {
  VENTAS: 'modulo-ventas',
  POSTVENTA: 'modulo-postventa',
  MARKETPLACE: 'modulo-marketplace',
  CHATBOT: 'modulo-chatbot',
  RETAIL: 'modulo-retail',
} as const;

/**
 * Capacidades locales de operador (userBearer) declaradas por OpenAPI con
 * `x-required-local-capability`. El claim exacto lo emite Seguridad y Usuarios
 * (G7); este servicio lo valida contra `capabilities`/`roles`/`scope(s)`.
 */
export const INVENTORY_CAPABILITIES = {
  TRASLADOS_LEER: 'INVENTARIO_TRASLADOS_LEER',
  TRASLADOS_RECIBIR: 'INVENTARIO_TRASLADOS_RECIBIR',
} as const;
