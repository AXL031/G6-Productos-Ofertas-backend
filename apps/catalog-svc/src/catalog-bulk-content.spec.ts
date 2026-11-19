import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CatalogBulkContentReader,
  type CatalogBulkContentIdentity,
} from './catalog-bulk-content.js';
import {
  InvalidCatalogMessage,
  parseCatalogMessage,
  type CatalogEnvelope,
} from './catalog-messages.js';

function fixture() {
  vi.stubEnv('CATALOG_BULK_CONTENT_ORIGIN', 'https://bulk.private.test');
  vi.stubEnv('MESSAGING_PROVIDER', 'AZURE_SERVICE_BUS');
  const rows = [{ row_operation_id: randomUUID(), sku_base: 'ñ-variant' }];
  const body = JSON.stringify({ rows });
  const document = Buffer.from(body);
  const ref = {
    content_id: randomUUID(),
    sha256: createHash('sha256').update(document).digest('hex'),
    byte_length: document.length,
    content_type: 'application/json',
  };
  const operation = randomUUID();
  const message: CatalogEnvelope = {
    message_id: randomUUID(),
    schema_version: 3,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: null,
    operation_id: operation,
    producer: 'bulk-svc',
    kind: 'command',
    name: 'catalog.bulk.upsert.requested',
    data: {
      batch_id: randomUUID(),
      batch_operation_id: operation,
      template_version: 2,
      mode: 'ACTUALIZACION',
      content_ref: ref,
    },
  };
  const identity = { authorization: vi.fn(async () => 'Bearer fixture') };
  const reader = new CatalogBulkContentReader(
    identity as unknown as CatalogBulkContentIdentity,
  );
  const headers = {
    'content-type': 'application/json',
    'content-length': String(ref.byte_length),
    'x-content-sha256': ref.sha256,
  };
  return { headers, body, message, ref, reader, rows, identity };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('downloads and verifies the original UTF-8 bytes only on the Service Bus route', async () => {
  const f = fixture();
  const fetch = vi.fn(async () => new Response(f.body, { headers: f.headers }));
  vi.stubGlobal('fetch', fetch);
  expect(() => parseCatalogMessage(f.message)).toThrow(InvalidCatalogMessage);
  expect(await f.reader.rows(parseCatalogMessage(f.message, true))).toEqual(
    f.rows,
  );
  expect(fetch).toHaveBeenCalledWith(
    new URL(
      '/api/v1/interno/carga-masiva/contenidos/' + f.ref.content_id,
      'https://bulk.private.test',
    ),
    expect.objectContaining({
      redirect: 'error',
      headers: { authorization: 'Bearer fixture', accept: 'application/json' },
    }),
  );
});

it('rejects a body with the same length and different hash and rejects inline rows in V3', async () => {
  const f = fixture();
  const fetch = vi.fn(
    async () =>
      new Response(f.body.replace('variant', 'altered'), {
        headers: f.headers,
      }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(f.reader.rows(f.message)).rejects.toBeInstanceOf(
    InvalidCatalogMessage,
  );
  f.message.data.rows = f.rows;
  await expect(f.reader.rows(f.message)).rejects.toBeInstanceOf(
    InvalidCatalogMessage,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps temporary unavailability retryable and checks the length header', async () => {
  const f = fixture();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(
      new Response(f.body, {
        headers: { ...f.headers, 'content-length': '1' },
      }),
    );
  vi.stubGlobal('fetch', fetch);
  await expect(f.reader.rows(f.message)).rejects.toMatchObject({ status: 503 });
  await expect(f.reader.rows(f.message)).rejects.toBeInstanceOf(
    InvalidCatalogMessage,
  );
});
