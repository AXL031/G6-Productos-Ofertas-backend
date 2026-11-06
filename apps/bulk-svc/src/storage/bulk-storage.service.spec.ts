import { BulkStorageService } from './bulk-storage.service.js';

describe('BulkStorageService HTTP safety', () => {
  const original = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: process.env.BULK_STORAGE_BUCKET,
  };

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://storage.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-placeholder';
    process.env.BULK_STORAGE_BUCKET = 'bulk-private';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const [key, value] of Object.entries({
      SUPABASE_URL: original.url,
      SUPABASE_SERVICE_ROLE_KEY: original.key,
      BULK_STORAGE_BUCKET: original.bucket,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses private non-upsert upload and verifies stored bytes before returning the reference', async () => {
    const bytes = Buffer.from('CSV,niño,東京\r\n');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/storage/v1/bucket/bulk-private'))
          return Response.json({ public: false });
        if (init?.method === 'POST') return new Response(null, { status: 200 });
        if (url.endsWith('/exports/job/file.csv')) {
          if (
            calls.filter((call) => call.url.endsWith('/exports/job/file.csv'))
              .length === 1
          )
            return new Response(null, { status: 404 });
          return new Response(bytes, { status: 200 });
        }
        throw new Error(`Unexpected Storage request ${url}`);
      }),
    );
    const service = new BulkStorageService();
    await expect(
      service.put(bytes, 'text/csv; charset=utf-8', 'exports/job/file.csv'),
    ).resolves.toBe('supabase://bulk-private/exports/job/file.csv');
    expect(calls.map((call) => call.init?.method ?? 'GET')).toEqual([
      'GET',
      'GET',
      'POST',
      'GET',
    ]);
    expect(calls[2]?.init?.headers).toMatchObject({ 'x-upsert': 'false' });
    expect(
      calls.every((call) => call.init?.signal instanceof AbortSignal),
    ).toBe(true);
  });

  it('preserves idempotency when the same object already contains identical bytes', async () => {
    const bytes = Buffer.from('actual file bytes');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith('/storage/v1/bucket/bulk-private'))
          return Response.json({ public: false });
        return new Response(bytes, { status: 200 });
      }),
    );
    await expect(
      new BulkStorageService().put(bytes, 'application/octet-stream', 'stable'),
    ).resolves.toBe('supabase://bulk-private/stable');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('maps a timed-out request to a sanitized storage failure and aborts its fetch', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        observedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener('abort', () =>
            reject(observedSignal?.reason),
          );
        });
      }),
    );
    const request = new BulkStorageService().get(
      'supabase://bulk-private/exports/job.csv',
    );
    const assertion = expect(request).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(observedSignal?.aborted).toBe(true);
  });

  it('honors caller cancellation and rejects arbitrary download references before network access', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new BulkStorageService().get(
        'supabase://bulk-private/exports/job.csv',
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    fetchMock.mockClear();
    await expect(
      new BulkStorageService().get('supabase://other-bucket/file.csv'),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
