/**
 * Configuración de Azure Service Bus para inventory-svc (H5).
 *
 * Sigue el patrón de pricing-svc: fail-closed, sin habilitar el transporte
 * a menos que las variables de entorno lo activen explícitamente.
 *
 * Variables requeridas para activación:
 *   MESSAGING_PROVIDER=AZURE_SERVICE_BUS
 *   G6_SERVICE_BUS_PILOT_ENABLED=true
 *   INVENTORY_SERVICE_BUS_PUBLISH_ENABLED=true
 *   SERVICE_BUS_NAMESPACE_FQDN=<namespace>.servicebus.windows.net
 *
 * En producción se exige además:
 *   G6_SERVICE_BUS_PRODUCTION_ENABLED=true
 *   G6_SECURITY_MODE=G7_AUTHENTICATED
 *   AZURE_CLIENT_ID=<managed-identity-guid>
 */

export interface InventoryServiceBusConfig {
  namespace: string;
  managedIdentityClientId?: string;
}

export function readInventoryServiceBus(
  env: NodeJS.ProcessEnv,
): InventoryServiceBusConfig | undefined {
  // H4 unchanged: si no hay indicador alguno de Service Bus, seguir con RabbitMQ / sin broker.
  if (
    (env.MESSAGING_PROVIDER === undefined ||
      env.MESSAGING_PROVIDER === 'RABBITMQ') &&
    (env.G6_SERVICE_BUS_PILOT_ENABLED === undefined ||
      env.G6_SERVICE_BUS_PILOT_ENABLED === 'false') &&
    (env.G6_SERVICE_BUS_PRODUCTION_ENABLED === undefined ||
      env.G6_SERVICE_BUS_PRODUCTION_ENABLED === 'false') &&
    env.SERVICE_BUS_NAMESPACE_FQDN === undefined
  )
    return undefined;

  // Validación estricta: todas las banderas deben coincidir.
  if (
    env.MESSAGING_PROVIDER !== 'AZURE_SERVICE_BUS' ||
    env.G6_SERVICE_BUS_PILOT_ENABLED !== 'true' ||
    env.INVENTORY_SERVICE_BUS_PUBLISH_ENABLED !== 'true' ||
    !['test', 'development', 'production'].includes(env.NODE_ENV ?? '') ||
    env.RABBITMQ_URL !== undefined ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(
      env.SERVICE_BUS_NAMESPACE_FQDN ?? '',
    )
  )
    throw new Error('INVENTORY_SERVICE_BUS_PILOT_CONFIGURATION_INVALID');

  const identity = env.AZURE_CLIENT_ID;
  if (
    (identity !== undefined &&
      (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        identity,
      ) ||
        identity === '00000000-0000-0000-0000-000000000000')) ||
    (env.G6_SERVICE_BUS_PRODUCTION_ENABLED !== undefined &&
      !['true', 'false'].includes(env.G6_SERVICE_BUS_PRODUCTION_ENABLED)) ||
    (env.NODE_ENV === 'production' &&
      (env.G6_SERVICE_BUS_PRODUCTION_ENABLED !== 'true' ||
        env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
        !identity)) ||
    (env.NODE_ENV !== 'production' &&
      env.G6_SERVICE_BUS_PRODUCTION_ENABLED === 'true')
  )
    throw new Error('INVENTORY_SERVICE_BUS_PRODUCTION_CONFIGURATION_INVALID');

  return {
    namespace: env.SERVICE_BUS_NAMESPACE_FQDN!,
    ...(identity ? { managedIdentityClientId: identity } : {}),
  };
}
