import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Pure validation: never authenticates, provisions, grants roles or modifies ACA.
export function validatePilotParameters(document) {
  const parameters = document?.parameters;
  const value = (name) => parameters?.[name]?.value;
  const namespace = value('namespaceName');
  const location = value('location');
  const sender = value('pricingPrincipalId');
  const receiver = value('auditPrincipalId');
  const guid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    typeof namespace !== 'string' ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]$/.test(namespace)
  )
    throw new Error('INVALID_NAMESPACE_NAME');
  if (typeof location !== 'string' || !/^[a-z][a-z0-9]+$/.test(location))
    throw new Error('EXPLICIT_REGION_REQUIRED');
  if (
    typeof sender !== 'string' ||
    typeof receiver !== 'string' ||
    !guid.test(sender) ||
    !guid.test(receiver) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(sender) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(receiver)
  )
    throw new Error('VALID_WORKLOAD_PRINCIPALS_REQUIRED');
  if (sender.toLowerCase() === receiver.toLowerCase())
    throw new Error('SEPARATE_WORKLOAD_IDENTITIES_REQUIRED');
  if (
    value('maxDeliveryCount') !== undefined &&
    (!Number.isInteger(value('maxDeliveryCount')) ||
      value('maxDeliveryCount') < 1 ||
      value('maxDeliveryCount') > 100)
  )
    throw new Error('INVALID_MAX_DELIVERY_COUNT');
  const allowed = new Set([
    'namespaceName',
    'location',
    'pricingPrincipalId',
    'auditPrincipalId',
    'maxDeliveryCount',
  ]);
  if (Object.keys(parameters).some((key) => !allowed.has(key)))
    throw new Error('UNEXPECTED_PILOT_PARAMETER');
  return {
    namespace,
    location,
    queue: 'g6.price-audit.from.pricing',
    mode: 'ISOLATED_PILOT',
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (!process.argv[2]) throw new Error('PARAMETER_FILE_REQUIRED');
    console.log(
      JSON.stringify(
        validatePilotParameters(
          JSON.parse(readFileSync(process.argv[2], 'utf8')),
        ),
      ),
    );
  } catch (error) {
    // Fixed validation codes only; never echo a supplied file or its values.
    console.error(
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'INVALID_PARAMETER_DOCUMENT',
    );
    process.exitCode = 1;
  }
}
