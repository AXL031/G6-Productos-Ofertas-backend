export const bulkFromCatalog = 'g6.bulk.from.catalog';

export function readBulkCatalogBus(env: Readonly<NodeJS.ProcessEnv>) {
  const selected = env.MESSAGING_PROVIDER === 'AZURE_SERVICE_BUS';
  const flag = env.BULK_SERVICE_BUS_CATALOG_RESULTS_ENABLED;
  if (!selected && (flag === undefined || flag === 'false')) return undefined;
  const namespace = env.SERVICE_BUS_NAMESPACE_FQDN;
  const clientId = env.AZURE_CLIENT_ID;
  if (
    !selected ||
    (flag !== 'true' && flag !== 'false') ||
    env.BULK_AMQP_URL !== undefined ||
    (env.BULK_AMQP_ENABLED !== undefined &&
      env.BULK_AMQP_ENABLED !== 'false') ||
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
    throw new Error('BULK_SERVICE_BUS_CONFIGURATION_INVALID');
  return { namespace: namespace!, clientId, enabled: flag === 'true' };
}
