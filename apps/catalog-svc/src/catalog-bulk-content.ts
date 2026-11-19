import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CatalogConfig } from './config.js';
import { CatalogTokenVerifier } from './catalog-auth.js';
import { CatalogPricingIdentityProvider } from './catalog-pricing-identity.js';
import { readCatalogServiceCredentials } from './catalog-service-credentials.js';
import {
  InvalidCatalogMessage,
  UUID,
  type CatalogEnvelope,
} from './catalog-messages.js';

const JSON_MEDIA_TYPE = 'application/json';
const CONTENT_SCOPE = 'carga-masiva:contenidos:leer';
const DOCUMENT_MAX_BYTES = 1_048_576;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reference(message: CatalogEnvelope) {
  const { batch_id, batch_operation_id, template_version, mode, content_ref } =
    message.data;
  if (
    Object.keys(message.data).length !== 5 ||
    typeof batch_id !== 'string' ||
    !UUID.test(batch_id) ||
    typeof batch_operation_id !== 'string' ||
    !UUID.test(batch_operation_id) ||
    message.operation_id !== batch_operation_id ||
    template_version !== 2 ||
    (mode !== 'ALTA' && mode !== 'ACTUALIZACION') ||
    !object(content_ref) ||
    Object.keys(content_ref).length !== 4 ||
    typeof content_ref.content_id !== 'string' ||
    !UUID.test(content_ref.content_id) ||
    typeof content_ref.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(content_ref.sha256) ||
    typeof content_ref.byte_length !== 'number' ||
    !Number.isSafeInteger(content_ref.byte_length) ||
    content_ref.byte_length < 1 ||
    content_ref.byte_length > DOCUMENT_MAX_BYTES ||
    content_ref.content_type !== JSON_MEDIA_TYPE
  )
    throw new InvalidCatalogMessage();
  return {
    contentId: content_ref.content_id,
    length: content_ref.byte_length,
    sha256: content_ref.sha256,
  };
}

@Injectable()
export class CatalogBulkContentIdentity extends CatalogPricingIdentityProvider {
  constructor(
    @Optional() @Inject(CatalogConfig) config: CatalogConfig | undefined,
    verifier: CatalogTokenVerifier,
  ) {
    super(config, verifier);
  }
  protected override get scope() {
    return CONTENT_SCOPE;
  }
  protected override get clientId() {
    return 'catalog-svc';
  }
  protected override get credentials() {
    return readCatalogServiceCredentials(
      {
        CATALOG_SERVICE_TOKEN_URL: process.env.CATALOG_BULK_CONTENT_TOKEN_URL,
        CATALOG_SERVICE_CLIENT_SECRET:
          process.env.CATALOG_BULK_CONTENT_CLIENT_SECRET,
      },
      this.config?.security?.issuer,
    );
  }
}

@Injectable()
export class CatalogBulkContentReader {
  constructor(private readonly identity: CatalogBulkContentIdentity) {}

  async rows(message: CatalogEnvelope): Promise<unknown[]> {
    const ref = reference(message);
    const configured = process.env.CATALOG_BULK_CONTENT_ORIGIN;
    let origin: URL;
    try {
      if (!configured || process.env.MESSAGING_PROVIDER !== 'AZURE_SERVICE_BUS')
        throw new Error();
      origin = new URL(configured);
      if (
        (origin.protocol !== 'https:' &&
          !(
            process.env.NODE_ENV === 'test' &&
            origin.protocol === 'http:' &&
            ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
          )) ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash
      )
        throw new Error();
    } catch {
      throw new ServiceUnavailableException();
    }
    const signal = AbortSignal.timeout(8000);
    const authorization = await this.identity.authorization(signal);
    const response = await fetch(
      new URL(
        '/api/v1/interno/carga-masiva/contenidos/' + ref.contentId,
        origin,
      ),
      {
        redirect: 'error',
        signal,
        headers: { authorization, accept: JSON_MEDIA_TYPE },
      },
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ServiceUnavailableException();
    }
    if (
      response.headers.get('content-type')?.split(';')[0] !== JSON_MEDIA_TYPE ||
      response.headers.get('content-length') !== String(ref.length) ||
      response.headers.get('x-content-sha256') !== ref.sha256 ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new InvalidCatalogMessage();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > ref.length) throw new InvalidCatalogMessage();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = Buffer.concat(chunks);
    if (
      length !== ref.length ||
      createHash('sha256').update(bytes).digest('hex') !== ref.sha256
    )
      throw new InvalidCatalogMessage();
    let document: unknown;
    try {
      document = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw new InvalidCatalogMessage();
    }
    if (
      !object(document) ||
      Object.keys(document).length !== 1 ||
      !Array.isArray(document.rows)
    )
      throw new InvalidCatalogMessage();
    return document.rows;
  }
}
