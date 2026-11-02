import { isIP } from 'node:net';
/** Legacy read-only presentation and explicit restricted H4 access selection.
 * Neither policy grants commercial eligibility or fabricates a G7 principal.
 */
export const CATALOG_READ_DEMO = Symbol('CATALOG_READ_DEMO');
export const CATALOG_MARKETPLACE_PREVIEW = Symbol(
  'CATALOG_MARKETPLACE_PREVIEW',
);
export interface CatalogReadDemo {
  readonly enabled: boolean;
  readonly restricted?: boolean;
  readonly gatewayIps?: readonly string[];
}

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
  const flag = env.G6_READ_ONLY_DEMO_ENABLED ?? 'false';
  if (!['true', 'false'].includes(flag))
    throw new Error('G6_READ_ONLY_DEMO_ENABLED debe ser true/false.');
  const mode = env.GATEWAY_DEMO_NO_AUTH_ENABLED ?? 'false';
  if (!['true', 'false'].includes(mode))
    throw new Error('GATEWAY_DEMO_NO_AUTH_ENABLED debe ser true/false.');
  if (mode === 'false') return Object.freeze({ enabled: flag === 'true' });
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
  });
}
