const names = ['pricing-svc', 'price-audit-svc'];
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identityId =
  /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[a-z0-9_.()-]+\/providers\/Microsoft.ManagedIdentity\/userAssignedIdentities\/[a-z0-9_-]+$/i;
const fail = () => {
  throw new Error('SERVICE_BUS_ACA_PILOT_CONFIGURATION_INVALID');
};

// Pure preparation. Does not authorize a cutover, migrate data or mutate Azure.
export function validateAcaPilot(runtime, pilot) {
  const selected = Object.entries(runtime).filter(
    ([, env]) =>
      env.MESSAGING_PROVIDER === 'AZURE_SERVICE_BUS' ||
      env.G6_SERVICE_BUS_PILOT_ENABLED === 'true' ||
      env.G6_SERVICE_BUS_PRODUCTION_ENABLED === 'true',
  );
  if (!pilot && !selected.length) return undefined;
  if (
    !pilot ||
    selected.length !== 2 ||
    selected.some(([name]) => !names.includes(name)) ||
    Object.keys(pilot).some(
      (key) => !['namespace', 'identities'].includes(key),
    ) ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(
      pilot.namespace ?? '',
    ) ||
    !pilot.identities ||
    Object.keys(pilot.identities).sort().join() !== [...names].sort().join()
  )
    fail();
  const result = {};
  for (const name of names) {
    const env = runtime[name],
      identity = pilot.identities[name];
    if (
      !identity ||
      Object.keys(identity).sort().join() !== 'clientId,resourceId' ||
      !identityId.test(identity.resourceId ?? '') ||
      !guid.test(identity.clientId ?? '') ||
      identity.clientId === '00000000-0000-0000-0000-000000000000' ||
      env.NODE_ENV !== 'production' ||
      env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
      env.MESSAGING_PROVIDER !== 'AZURE_SERVICE_BUS' ||
      env.G6_SERVICE_BUS_PILOT_ENABLED !== 'true' ||
      env.G6_SERVICE_BUS_PRODUCTION_ENABLED !== 'true' ||
      env.SERVICE_BUS_NAMESPACE_FQDN !== pilot.namespace ||
      env.AZURE_CLIENT_ID?.toLowerCase() !== identity.clientId.toLowerCase() ||
      env[
        name === 'pricing-svc' ? 'PRICING_AMQP_URL' : 'PRICE_AUDIT_AMQP_URL'
      ] !== undefined ||
      (name === 'pricing-svc' &&
        env.PRICING_PRICE_CHANGED_PUBLISH_ENABLED !== 'true')
    )
      fail();
    result[name] = {
      type: 'UserAssigned',
      userAssignedIdentities: { [identity.resourceId]: {} },
    };
  }
  const [first, second] = names.map((name) => pilot.identities[name]);
  if (
    first.clientId.toLowerCase() === second.clientId.toLowerCase() ||
    first.resourceId.toLowerCase() === second.resourceId.toLowerCase()
  )
    fail();
  return result;
}
