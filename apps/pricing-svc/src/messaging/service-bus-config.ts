export interface PricingServiceBusConfig {
  namespace: string;
  managedIdentityClientId?: string;
  fanoutEnabled?: true;
  catalogEnabled?: true;
}

// H5 is selected explicitly; production uses only the assigned workload identity.
export function readPricingServiceBus(
  env: NodeJS.ProcessEnv,
): PricingServiceBusConfig | undefined {
  const pilot = env.G6_SERVICE_BUS_PILOT_ENABLED;
  const fanout = env.PRICING_SERVICE_BUS_FANOUT_ENABLED;
  const catalog = env.PRICING_SERVICE_BUS_CATALOG_ENABLED;
  if (
    (env.MESSAGING_PROVIDER === undefined ||
      env.MESSAGING_PROVIDER === 'RABBITMQ') &&
    (pilot === undefined || pilot === 'false') &&
    (fanout === undefined || fanout === 'false') &&
    (catalog === undefined || catalog === 'false') &&
    (env.G6_SERVICE_BUS_PRODUCTION_ENABLED === undefined ||
      env.G6_SERVICE_BUS_PRODUCTION_ENABLED === 'false') &&
    env.SERVICE_BUS_NAMESPACE_FQDN === undefined
  )
    return undefined;
  if (
    env.MESSAGING_PROVIDER !== 'AZURE_SERVICE_BUS' ||
    ![undefined, 'true', 'false'].includes(pilot) ||
    ![undefined, 'true', 'false'].includes(fanout) ||
    ![undefined, 'true', 'false'].includes(catalog) ||
    (catalog === 'true' && fanout !== 'true') ||
    (pilot === 'true') === (fanout === 'true') ||
    env.PRICING_PRICE_CHANGED_PUBLISH_ENABLED !== 'true' ||
    !['test', 'development', 'production'].includes(env.NODE_ENV ?? '') ||
    env.PRICING_AMQP_URL !== undefined ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(
      env.SERVICE_BUS_NAMESPACE_FQDN ?? '',
    )
  )
    throw new Error('PRICING_SERVICE_BUS_PILOT_CONFIGURATION_INVALID');
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
    throw new Error('PRICING_SERVICE_BUS_PRODUCTION_CONFIGURATION_INVALID');
  return {
    namespace: env.SERVICE_BUS_NAMESPACE_FQDN!,
    ...(identity ? { managedIdentityClientId: identity } : {}),
    ...(fanout === 'true' ? { fanoutEnabled: true } : {}),
    ...(catalog === 'true' ? { catalogEnabled: true } : {}),
  };
}
