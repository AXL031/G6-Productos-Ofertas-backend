import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Marketplace disposable CI security wiring (source regression)', () => {
  it('configures Catalog trust independently of Gateway and preserves the 400 assertion', () => {
    const script = readFileSync(
      resolve('scripts/ci/marketplace-docker.sh'),
      'utf8',
    );
    const catalog = script
      .split('cat >> "$scratch/catalog.env" <<EOF')[1]
      ?.split('\nEOF')[0];
    expect(catalog).toContain('SECURITY_ISSUER=https://issuer:3443');
    expect(catalog).toContain(
      'SECURITY_DISCOVERY_URL=https://issuer:3443/.well-known/openid-configuration',
    );
    expect(catalog).toContain('SECURITY_JWKS_URL=https://issuer:3443/keys');
    expect(catalog).toContain('NODE_EXTRA_CA_CERTS=/run/certs/postgres-ca.crt');
    expect(script).not.toContain('GATEWAY_DEMO_NO_AUTH_ENABLED=true');
    expect(
      readFileSync(resolve('scripts/ci/marketplace-probe.mjs'), 'utf8'),
    ).toContain(
      "await check('/api/v1/productos?canal=MARKETPLACE&pagina=0', 400)",
    );
    const issuer = readFileSync(resolve('scripts/ci/issuer.mjs'), 'utf8');
    expect(issuer).toContain("req.url === '/.well-known/openid-configuration'");
    expect(issuer).toContain("jwks_uri: 'https://issuer:3443/keys'");
  });
});
