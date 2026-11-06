import { isIP } from 'node:net';
/** Legacy read-only presentation and explicit restricted H4 access selection.
 * Neither policy grants commercial eligibility or fabricates a G7 principal.
 */
export const CATALOG_READ_DEMO = Symbol('CATALOG_READ_DEMO');
export const CATALOG_MARKETPLACE_PREVIEW = Symbol(
  'CATALOG_MARKETPLACE_PREVIEW',
);
export type CatalogSecurityMode =
  'PUBLIC_READ_ONLY' | 'SIMULATED_AUTH' | 'G7_AUTHENTICATED';
export interface CatalogReadDemo {
  readonly enabled: boolean;
  readonly restricted?: boolean;
  readonly gatewayIps?: readonly string[];
  readonly securityMode?: CatalogSecurityMode;
  readonly publicOperations?: readonly string[];
}

const CATALOG_ELIGIBLE_PUBLIC_OPERATIONS = new Set([
  'listarProductos',
  'obtenerProductoPorSlug',
  'obtenerProducto',
]);

/** Existing legacy placeholders are not photographs of the stored product. */
export function isDemoCatalogImage(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.hostname !== 'placehold.co'
    );
  } catch {
    return false;
  }
}

export function readCatalogReadDemo(
  env: Record<string, string | undefined> = process.env,
): CatalogReadDemo {
  const securityModeRaw = env.G6_SECURITY_MODE;
  if (
    securityModeRaw !== undefined &&
    !['PUBLIC_READ_ONLY', 'G7_AUTHENTICATED'].includes(securityModeRaw)
  ) {
    throw new Error(
      'G6_SECURITY_MODE debe ser PUBLIC_READ_ONLY o G7_AUTHENTICATED; SIMULATED_AUTH no está homologado.',
    );
  }
  const securityMode =
    (securityModeRaw as CatalogSecurityMode | undefined) ?? 'G7_AUTHENTICATED';
  const publicOperations = (env.CATALOG_PUBLIC_OPERATION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (
    publicOperations.some((id) => !CATALOG_ELIGIBLE_PUBLIC_OPERATIONS.has(id))
  ) {
    throw new Error(
      'CATALOG_PUBLIC_OPERATION_IDS contiene una operación no elegible para lectura pública.',
    );
  }
  const flag = env.G6_READ_ONLY_DEMO_ENABLED ?? 'false';
  if (!['true', 'false'].includes(flag))
    throw new Error('G6_READ_ONLY_DEMO_ENABLED debe ser true/false.');
  const mode = env.GATEWAY_DEMO_NO_AUTH_ENABLED ?? 'false';
  if (!['true', 'false'].includes(mode))
    throw new Error('GATEWAY_DEMO_NO_AUTH_ENABLED debe ser true/false.');
  if (
    securityModeRaw !== undefined &&
    (mode === 'true' ||
      flag === 'true' ||
      env.CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED === 'true')
  ) {
    throw new Error('Configuracion G6_SECURITY_MODE contradictoria.');
  }
  if (securityMode !== 'PUBLIC_READ_ONLY' && publicOperations.length > 0) {
    throw new Error('Configuracion G6_SECURITY_MODE contradictoria.');
  }
  if (securityModeRaw === 'PUBLIC_READ_ONLY') {
    // Phase 1 never activates an automatic list of public operations.
    return Object.freeze({
      enabled: false,
      securityMode,
      publicOperations: Object.freeze(publicOperations),
    });
  }
  if (mode === 'false')
    return Object.freeze({
      enabled: flag === 'true',
      securityMode,
    });
  if (flag === 'true')
    throw new Error('No combinar demo de lectura y demo restringida.');
  const gatewayIps = (env.CATALOG_DEMO_GATEWAY_IPS ?? '')
    .split(',')
    .map((ip) => ip.trim());
  if (
    gatewayIps.some(
      (ip) =>
        isIP(ip) !== 4 ||
        !(
          ip.startsWith('10.') ||
          ip.startsWith('127.') ||
          ip.startsWith('192.168.') ||
          /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)
        ),
    )
  )
    throw new Error(
      'CATALOG_DEMO_GATEWAY_IPS requiere IP privadas explicitas del Gateway.',
    );
  return Object.freeze({
    enabled: false,
    restricted: true,
    gatewayIps: Object.freeze(gatewayIps),
    securityMode,
  });
}
