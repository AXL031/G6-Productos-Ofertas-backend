export const promotionsEventQueues = [
  'g6.promotions.from.catalog',
  'g6.promotions.from.pricing',
  'g6.promotions.from.inventory',
] as const;

type PromotionsEventQueue = (typeof promotionsEventQueues)[number];

export interface PromotionsServiceBusConfig {
  namespace: string;
  managedIdentityClientId?: string;
  eventsEnabled: boolean;
  eventQueues?: readonly PromotionsEventQueue[];
}

// Internal transport configuration, never a grant for the proposed G5 API.
export function readPromotionsServiceBus(
  env: Readonly<NodeJS.ProcessEnv>,
): PromotionsServiceBusConfig | undefined {
  const azure = env.MESSAGING_PROVIDER === 'AZURE_SERVICE_BUS';
  const flag = env.PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED;
  const production = env.G6_SERVICE_BUS_PRODUCTION_ENABLED;
  const selected = env.PROMOTIONS_SERVICE_BUS_EVENT_QUEUES;
  if (!azure) {
    if (
      (env.MESSAGING_PROVIDER !== undefined &&
        env.MESSAGING_PROVIDER !== 'RABBITMQ') ||
      (flag !== undefined && flag !== 'false') ||
      (production !== undefined && production !== 'false') ||
      selected !== undefined ||
      env.SERVICE_BUS_NAMESPACE_FQDN !== undefined
    )
      throw new Error('PROMOTIONS_SERVICE_BUS_CONFIGURATION_INVALID');
    return undefined;
  }
  const identity = env.AZURE_CLIENT_ID;
  const eventQueues = selected?.split(',').map((value) => value.trim());
  if (
    eventQueues &&
    (flag !== 'true' ||
      new Set(eventQueues).size !== eventQueues.length ||
      eventQueues.some(
        (queue) =>
          !(promotionsEventQueues as readonly string[]).includes(queue),
      ))
  )
    throw new Error('PROMOTIONS_SERVICE_BUS_CONFIGURATION_INVALID');
  if (
    !['true', 'false'].includes(flag ?? 'false') ||
    !['true', 'false'].includes(production ?? 'false') ||
    !['development', 'test', 'production'].includes(
      env.NODE_ENV ?? 'development',
    ) ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(
      env.SERVICE_BUS_NAMESPACE_FQDN ?? '',
    ) ||
    env.RABBITMQ_URL !== undefined ||
    env.PROMOTIONS_COUPON_RUNTIME_ENABLED === 'true' ||
    (identity !== undefined &&
      (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(identity) ||
        /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(identity))) ||
    (env.NODE_ENV === 'production' &&
      (production !== 'true' ||
        env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
        !identity)) ||
    (env.NODE_ENV !== 'production' && production === 'true')
  )
    throw new Error('PROMOTIONS_SERVICE_BUS_CONFIGURATION_INVALID');
  return Object.freeze({
    namespace: env.SERVICE_BUS_NAMESPACE_FQDN!,
    managedIdentityClientId: identity,
    eventsEnabled: flag === 'true',
    eventQueues: Object.freeze(
      (eventQueues as PromotionsEventQueue[] | undefined) ??
        promotionsEventQueues,
    ),
  });
}
