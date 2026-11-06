export interface DemoClientConfig {
  readonly clientSecret: string;
  readonly allowedScopes: readonly string[];
}

export interface DemoIssuerOptions {
  readonly kid?: string;
  readonly adminSecret: string;
  readonly privateKeyPem?: string;
  readonly clients?: Readonly<Record<string, DemoClientConfig>>;
}

export interface DemoIssuerServer {
  readonly origin: string;
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly jwksUrl: string;
  readonly tokenUrl: string;
  close(): Promise<void>;
}

export interface DemoIssuer {
  readonly kid: string;
  readonly publicJwk: Readonly<Record<string, unknown>>;
  exportPrivateKeyPem(): string | Buffer;
  mintProfile(options: {
    readonly issuer: string;
    readonly profile: string;
    readonly secret: string;
  }): string;
  listenLocalOnly(host?: string, port?: number): Promise<DemoIssuerServer>;
}

export function createDemoIssuer(options: DemoIssuerOptions): DemoIssuer;
