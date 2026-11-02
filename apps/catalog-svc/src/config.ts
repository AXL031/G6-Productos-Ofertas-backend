import { readPostgresSettings, type PostgresSettings } from './database.js';
import { readTaxonomyConfig, type TaxonomyConfig } from './taxonomy-config.js';
import { readHttpConfig } from './http-config.js';
import {
  readCatalogReadDemo,
  type CatalogReadDemo,
} from './catalog-read-demo.js';
import {
  readCatalogAmqpConfig,
  type CatalogAmqpSettings,
} from './catalog-amqp.js';
import {
  preparationTimeout,
  type CatalogPreparationConfig,
} from './catalog-messages.js';
import {
  readCatalogSecurityConfig,
  type CatalogSecurityConfig,
} from './catalog-auth.js';
import {
  readCatalogServiceCredentials,
  type CatalogServiceCredentials,
} from './catalog-service-credentials.js';

export type Environment = 'development' | 'test' | 'production';

export class CatalogConfig {
  readonly environment: Environment;
  readonly port: number;
  readonly host: string;
  readonly database: PostgresSettings;
  readonly taxonomy: TaxonomyConfig;
  readonly security?: CatalogSecurityConfig;
  readonly amqp: CatalogAmqpSettings;
  readonly preparation: CatalogPreparationConfig;
  readonly readDemo: CatalogReadDemo;
  readonly marketplaceDemoPreview: boolean;
  readonly pricingOrigin?: string;
  readonly serviceCredentials?: CatalogServiceCredentials;

  constructor(env: Record<string, string | undefined>) {
    this.readDemo = readCatalogReadDemo(env);
    const errors: string[] = [];
    const environment = env.NODE_ENV;
    if (!['development', 'test', 'production'].includes(environment ?? '')) {
      errors.push('NODE_ENV debe ser development, test o production.');
    }
    if (!(env.CATALOG_SVC_PORT ?? env.PORT)) {
      errors.push('CATALOG_SVC_PORT (o PORT) es obligatorio.');
    }
    let http: ReturnType<typeof readHttpConfig> | undefined;
    try {
      http = readHttpConfig(env);
    } catch {
      errors.push('CATALOG_SVC_PORT/PORT o CATALOG_SVC_HOST invalido.');
    }
    let database: PostgresSettings | undefined;
    try {
      database = readPostgresSettings(env);
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : 'Configuracion PostgreSQL catalog invalida.',
      );
    }
    let taxonomy: TaxonomyConfig | undefined;
    try {
      taxonomy = readTaxonomyConfig(env);
    } catch {
      errors.push(
        'CATALOG_TAXONOMY_URL debe ser un origen HTTP(S) sin credenciales.',
      );
    }
    let security: CatalogSecurityConfig | undefined;
    try {
      security = readCatalogSecurityConfig(env);
    } catch {
      errors.push(
        'SECURITY_ISSUER, SECURITY_DISCOVERY_URL y SECURITY_JWKS_URL deben configurarse juntos y ser válidos.',
      );
    }
    let amqp: CatalogAmqpSettings = {},
      preparation: CatalogPreparationConfig = {};
    try {
      amqp = { connection: readCatalogAmqpConfig(env) };
      preparation = { timeoutMs: preparationTimeout(env) };
    } catch {
      errors.push(
        'Configuración de mensajería/preparación de Catálogo inválida.',
      );
    }
    let serviceCredentials: CatalogServiceCredentials | undefined;
    try {
      serviceCredentials = readCatalogServiceCredentials(env, security?.issuer);
    } catch {
      errors.push(
        'CATALOG_SERVICE_TOKEN_URL y CATALOG_SERVICE_CLIENT_SECRET deben configurarse juntos con el emisor autorizado.',
      );
    }
    const preview = env.CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED;
    if (preview !== undefined && !['true', 'false'].includes(preview)) {
      errors.push(
        'CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED debe ser true o false.',
      );
    }
    if (this.readDemo.restricted && preview === 'true')
      errors.push('No combinar preview Marketplace y demo restringida.');
    let pricingOrigin: string | undefined;
    if (env.CATALOG_PRICING_URL !== undefined) {
      try {
        const url = new URL(env.CATALOG_PRICING_URL);
        if (
          url.protocol !== 'http:' ||
          url.hostname !== 'pricing-svc' ||
          url.port !== '3002' ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw new Error();
        pricingOrigin = url.origin;
      } catch {
        errors.push(
          'CATALOG_PRICING_URL debe usar el origen privado pricing-svc:3002.',
        );
      }
    }
    if (
      this.readDemo.restricted &&
      taxonomy?.origin &&
      new URL(taxonomy.origin).hostname !== 'taxonomy-svc'
    )
      errors.push('Demo restringida requiere Taxonomy privado taxonomy-svc.');
    if (preview === 'true' && !pricingOrigin) {
      errors.push('CATALOG_PRICING_URL es obligatorio para la demo.');
    }
    if (errors.length || !http || !database || !taxonomy) {
      throw new Error(
        'Configuracion de catalog-svc invalida: ' + errors.join(' '),
      );
    }
    this.environment = environment as Environment;
    this.port = http.port;
    this.host = http.host;
    this.database = database;
    this.taxonomy = taxonomy;
    this.security = security;
    this.amqp = Object.freeze(amqp);
    this.preparation = Object.freeze(preparation);
    this.marketplaceDemoPreview = preview === 'true';
    this.pricingOrigin = pricingOrigin;
    this.serviceCredentials = serviceCredentials;
    Object.freeze(this);
  }
}
