import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkStorageService } from './bulk-storage.service.js';

const bucketUrl = 'http://storage.local/storage/v1/bucket/bulk-h4-local';
const objectUrl =
  'http://storage.local/storage/v1/object/bulk-h4-local/imports/test.csv';
const bytes = Buffer.from('bulk storage test bytes');
const contentRef = 'supabase://bulk-h4-local/imports/test.csv';

function fetchMock(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.mocked(fetch);
}

function privateBucketResponse(): Response {
  return new Response(JSON.stringify({ public: false }), { status: 200 });
}

async function expectStorageUnavailable(): Promise<void> {
  await expect(
    new BulkStorageService().put(bytes, 'text/csv', 'imports/test.csv'),
  ).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
    message: 'El almacenamiento privado no pudo aceptar el archivo.',
  });
}

describe('BulkStorageService', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'http://storage.local');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'local-test-key');
    vi.stubEnv('BULK_STORAGE_BUCKET', 'bulk-h4-local');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uploads when Storage reports a missing object as 400 NoSuchKey/404', async () => {
    fetchMock()
      .mockResolvedValueOnce(privateBucketResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statusCode: '404',
            code: 'NoSuchKey',
            message: 'Object not found',
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      new BulkStorageService().put(bytes, 'text/csv', 'imports/test.csv'),
    ).resolves.toBe(contentRef);

    expect(fetchMock()).toHaveBeenCalledTimes(3);
    expect(fetchMock().mock.calls[0][0]).toBe(bucketUrl);
    expect(fetchMock().mock.calls[1][0]).toBe(objectUrl);
    expect(fetchMock().mock.calls[2][0]).toBe(objectUrl);
    expect(fetchMock().mock.calls[2][1]?.method).toBe('POST');
  });

  it('continues to upload when the object lookup returns HTTP 404', async () => {
    fetchMock()
      .mockResolvedValueOnce(privateBucketResponse())
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      new BulkStorageService().put(bytes, 'text/csv', 'imports/test.csv'),
    ).resolves.toBe(contentRef);
    expect(fetchMock().mock.calls[2][1]?.method).toBe('POST');
  });

  it.each([
    [
      'HTTP 400 for another error',
      new Response('{"code":"InvalidKey"}', { status: 400 }),
    ],
    [
      'HTTP 400 with an incomplete NoSuchKey body',
      new Response('{"code":"NoSuchKey"}', { status: 400 }),
    ],
    [
      'HTTP 400 with a numeric statusCode',
      new Response('{"code":"NoSuchKey","statusCode":404}', {
        status: 400,
      }),
    ],
    ['HTTP 401', new Response(null, { status: 401 })],
    ['HTTP 403', new Response(null, { status: 403 })],
    ['HTTP 409', new Response(null, { status: 409 })],
    ['HTTP 503', new Response('private diagnostic', { status: 503 })],
  ])('does not upload after %s', async (_label, lookupResponse) => {
    fetchMock()
      .mockResolvedValueOnce(privateBucketResponse())
      .mockResolvedValueOnce(lookupResponse);

    await expectStorageUnavailable();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(
      fetchMock().mock.calls.some(([, init]) => init?.method === 'POST'),
    ).toBe(false);
  });

  it('does not upload after a network failure during object lookup', async () => {
    fetchMock()
      .mockResolvedValueOnce(privateBucketResponse())
      .mockRejectedValueOnce(new Error('private URL and key diagnostic'));

    await expectStorageUnavailable();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(
      fetchMock().mock.calls.some(([, init]) => init?.method === 'POST'),
    ).toBe(false);
  });

  it('returns the reference without overwriting an identical existing object', async () => {
    fetchMock()
      .mockResolvedValueOnce(privateBucketResponse())
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    await expect(
      new BulkStorageService().put(bytes, 'text/csv', 'imports/test.csv'),
    ).resolves.toBe(contentRef);
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it('rejects an existing object with different bytes without overwriting it', async () => {
    fetchMock()
      .mockResolvedValueOnce(privateBucketResponse())
      .mockResolvedValueOnce(new Response('different bytes', { status: 200 }));

    await expectStorageUnavailable();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(
      fetchMock().mock.calls.some(([, init]) => init?.method === 'POST'),
    ).toBe(false);
  });

  it('rejects a public bucket before looking up or uploading an object', async () => {
    fetchMock().mockResolvedValueOnce(
      new Response(JSON.stringify({ public: true }), { status: 200 }),
    );

    await expectStorageUnavailable();
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it('accepts a concurrent upload only after confirming identical stored bytes', async () => {
    fetchMock()
      .mockResolvedValueOnce(privateBucketResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ statusCode: '404', code: 'NoSuchKey' }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(new Response('conflict', { status: 409 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    await expect(
      new BulkStorageService().put(bytes, 'text/csv', 'imports/test.csv'),
    ).resolves.toBe(contentRef);
    expect(fetchMock()).toHaveBeenCalledTimes(4);
    expect(fetchMock().mock.calls[2][1]?.method).toBe('POST');
    expect(fetchMock().mock.calls[3][0]).toBe(objectUrl);
  });
});
