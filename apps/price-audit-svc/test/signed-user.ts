import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Proveedor JWKS HTTP real, exclusivamente para las suites aisladas.
export class SignedUser {
  private readonly pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private server?: Server;
  issuer = '';
  readonly jwk = {
    ...this.pair.publicKey.export({ format: 'jwk' }),
    kid: 'pricing-fixture',
    use: 'sig',
    alg: 'RS256',
  };

  async start(): Promise<void> {
    this.server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ keys: [this.jwk] }));
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
  token(
    overrides: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const content = `${encode({ alg: 'RS256', kid: 'pricing-fixture', typ: 'JWT', ...header })}.${encode(
      {
        iss: this.issuer,
        sub: '74ed2f19-7e70-4915-a6f6-bbc691b82587',
        tipo: 'acceso',
        iat: now,
        exp: now + 300,
        jti: randomUUID(),
        roles: ['GESTOR_COMERCIAL'],
        ...overrides,
      },
    )}`;
    return `${content}.${sign('RSA-SHA256', Buffer.from(content), this.pair.privateKey).toString('base64url')}`;
  }
}
