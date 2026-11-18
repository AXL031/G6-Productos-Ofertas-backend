/**
 * Configuración de Azure Service Bus para inventory-svc (H5).
 *
 * Sigue el patrón fail-closed: se valida al iniciar el servicio (bootstrap).
 * Si H5 está seleccionado (MESSAGING_PROVIDER=AZURE_SERVICE_BUS) y la configuración
 * es inválida, lanza un error que detiene el arranque.
 * Si H5 no está seleccionado, retorna undefined conservando H4 (RabbitMQ) intacto.
 */

export interface InventoryServiceBusConfig {
  namespace: string;
  publishEnabled: boolean;
  consumeEnabled: boolean;
  managedIdentityClientId?: string;
}

export function readInventoryServiceBus(
  env: NodeJS.ProcessEnv,
): InventoryServiceBusConfig | undefined {
  const isH5 = env.MESSAGING_PROVIDER === 'AZURE_SERVICE_BUS';

  // Si H5 no está seleccionado:
  if (!isH5) {
    // Si se especificaron variables de Service Bus sin seleccionar el transporte, configuración inválida.
    if (
      env.G6_SERVICE_BUS_PILOT_ENABLED === 'true' ||
      env.SERVICE_BUS_NAMESPACE_FQDN !== undefined ||
      env.INVENTORY_SERVICE_BUS_PUBLISH_ENABLED === 'true' ||
      env.INVENTORY_SERVICE_BUS_CONSUME_ENABLED === 'true'
    ) {
      throw new Error('INVENTORY_SERVICE_BUS_PILOT_CONFIGURATION_INVALID');
    }
    return undefined;
  }

  // Si H5 está seleccionado:
  const publishFlag = env.INVENTORY_SERVICE_BUS_PUBLISH_ENABLED;
  const consumeFlag = env.INVENTORY_SERVICE_BUS_CONSUME_ENABLED;

  if (
    env.G6_SERVICE_BUS_PILOT_ENABLED !== 'true' ||
    !['test', 'development', 'production'].includes(env.NODE_ENV ?? '') ||
    env.RABBITMQ_URL !== undefined ||
    (publishFlag !== undefined && !['true', 'false'].includes(publishFlag)) ||
    (consumeFlag !== undefined && !['true', 'false'].includes(consumeFlag)) ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(
      env.SERVICE_BUS_NAMESPACE_FQDN ?? '',
    )
  ) {
    throw new Error('INVENTORY_SERVICE_BUS_PILOT_CONFIGURATION_INVALID');
  }

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
  ) {
    throw new Error('INVENTORY_SERVICE_BUS_PRODUCTION_CONFIGURATION_INVALID');
  }

  return {
    namespace: env.SERVICE_BUS_NAMESPACE_FQDN!,
    publishEnabled: publishFlag === 'true',
    consumeEnabled: consumeFlag === 'true',
    ...(identity ? { managedIdentityClientId: identity } : {}),
  };
}
