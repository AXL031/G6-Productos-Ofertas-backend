export const taxonomyCatalogQueue = 'g6.catalog.from.taxonomy';
export const catalogTaxonomyQueue = 'g6.taxonomy.from.catalog';

export const taxonomyServiceBusEvents = [
  'taxonomy.category.updated',
  'taxonomy.product-type-schema.changed',
  'taxonomy.characteristic-value.updated',
  'taxonomy.master.deactivation.check.requested',
  'taxonomy.master.deactivated',
  'taxonomy.master.deactivation.rejected',
] as const;

export function readTaxonomyServiceBus(env: Readonly<NodeJS.ProcessEnv>) {
  const provider = env.MESSAGING_PROVIDER;
  const flag = env.TAXONOMY_SERVICE_BUS_ENABLED;
  const namespace = env.SERVICE_BUS_NAMESPACE_FQDN;
  const clientId = env.AZURE_CLIENT_ID;
  if (
    (provider === undefined || provider === 'RABBITMQ') &&
    (flag === undefined || flag === 'false') &&
    namespace === undefined
  )
    return undefined;
  if (
    provider !== 'AZURE_SERVICE_BUS' ||
    (flag !== 'true' && flag !== 'false') ||
    env.RABBITMQ_URL !== undefined ||
    env.TAXONOMY_CATALOG_AMQP_USER !== undefined ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(
      namespace ?? '',
    ) ||
    (clientId !== undefined &&
      (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(clientId) ||
        /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(clientId))) ||
    (env.NODE_ENV === 'production' &&
      (env.G6_SERVICE_BUS_PRODUCTION_ENABLED !== 'true' ||
        env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
        !clientId))
  )
    throw new Error('TAXONOMY_SERVICE_BUS_CONFIGURATION_INVALID');
  return { namespace: namespace!, clientId, enabled: flag === 'true' };
}
