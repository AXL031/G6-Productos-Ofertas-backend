import { Injectable } from '@nestjs/common';
import { BulkDomainError } from '../domain/bulk.domain-error.js';
import { matchesBulkStorageReference } from './bulk-storage-reference.js';

const STORAGE_REQUEST_TIMEOUT_MS = 10_000;

async function withStorageRequest<T>(
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException('Storage request timed out', 'TimeoutError'),
      ),
    STORAGE_REQUEST_TIMEOUT_MS,
  );
  timer.unref();
  const requestSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    requestSignal.throwIfAborted();
    return await operation(requestSignal);
  } finally {
    clearTimeout(timer);
  }
}

async function isMissingObjectResponse(response: Response): Promise<boolean> {
  if (response.status === 404) return true;
  if (response.status !== 400) return false;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return false;
  }

  return (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Object.hasOwn(payload, 'code') &&
    Object.hasOwn(payload, 'statusCode') &&
    Reflect.get(payload, 'code') === 'NoSuchKey' &&
    Reflect.get(payload, 'statusCode') === '404'
  );
}

/** Private Supabase Storage adapter. It never provisions buckets or policies. */
@Injectable()
export class BulkStorageService {
  private config(): { url: string; key: string; bucket: string } {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.BULK_STORAGE_BUCKET;
    if (!url || !key || !bucket)
      throw new BulkDomainError(
        'STORAGE_UNAVAILABLE',
        'El almacenamiento privado de Bulk no está configurado.',
      );
    return { url: url.replace(/\/$/, ''), key, bucket };
  }

  async put(
    bytes: Buffer,
    contentType: string,
    objectName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { url, key, bucket } = this.config();
    try {
      const headers = { apikey: key, authorization: `Bearer ${key}` };
      const metadata = await withStorageRequest(
        signal,
        async (requestSignal) => {
          const bucketResponse = await fetch(
            `${url}/storage/v1/bucket/${encodeURIComponent(bucket)}`,
            { headers, signal: requestSignal },
          );
          if (!bucketResponse.ok) throw new Error('bucket unavailable');
          return (await bucketResponse.json()) as unknown;
        },
      );
      if (
        !metadata ||
        typeof metadata !== 'object' ||
        Reflect.get(metadata, 'public') !== false
      )
        throw new Error('bucket must be private');
      const objectUrl = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectName.split('/').map(encodeURIComponent).join('/')}`;
      const existing = await withStorageRequest(
        signal,
        async (requestSignal) => {
          const response = await fetch(objectUrl, {
            headers,
            signal: requestSignal,
          });
          if (response.ok)
            return {
              found: true,
              bytes: Buffer.from(await response.arrayBuffer()),
            };
          return {
            found: false,
            bytes: null,
            missing: await isMissingObjectResponse(response),
          };
        },
      );
      if (existing.found) {
        if (!existing.bytes?.equals(bytes))
          throw new Error('idempotent object conflict');
        return `supabase://${bucket}/${objectName}`;
      }
      if (!existing.missing) throw new Error('object lookup failed');
      const uploaded = await withStorageRequest(
        signal,
        async (requestSignal) => {
          const response = await fetch(objectUrl, {
            method: 'POST',
            headers: {
              ...headers,
              'content-type': contentType,
              'x-upsert': 'false',
            },
            body: new Uint8Array(bytes),
            signal: requestSignal,
          });
          const raced = await fetch(objectUrl, {
            headers,
            signal: requestSignal,
          });
          if (!raced.ok) throw new Error('upload failed');
          const storedBytes = Buffer.from(await raced.arrayBuffer());
          if (!response.ok && storedBytes.length === 0 && bytes.length > 0)
            throw new Error('upload failed');
          return storedBytes.equals(bytes);
        },
      );
      if (!uploaded) throw new Error('upload failed or object conflict');
      return `supabase://${bucket}/${objectName}`;
    } catch (error) {
      if (error instanceof BulkDomainError) throw error;
      throw new BulkDomainError(
        'STORAGE_UNAVAILABLE',
        'El almacenamiento privado no pudo aceptar el archivo.',
        { cause: error },
      );
    }
  }

  async get(contentRef: string, signal?: AbortSignal): Promise<Buffer> {
    const { url, key, bucket } = this.config();
    const prefix = `supabase://${bucket}/`;
    if (!matchesBulkStorageReference(contentRef, bucket))
      throw new BulkDomainError(
        'STORAGE_UNAVAILABLE',
        'La referencia privada no corresponde al bucket configurado.',
      );
    const objectName = contentRef.slice(prefix.length);
    try {
      return await withStorageRequest(signal, async (requestSignal) => {
        const response = await fetch(
          `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectName.split('/').map(encodeURIComponent).join('/')}`,
          {
            headers: { apikey: key, authorization: `Bearer ${key}` },
            signal: requestSignal,
          },
        );
        if (!response.ok) throw new Error('download failed');
        return Buffer.from(await response.arrayBuffer());
      });
    } catch (error) {
      throw new BulkDomainError(
        'STORAGE_UNAVAILABLE',
        'El archivo privado no está disponible.',
        { cause: error },
      );
    }
  }

  async remove(contentRef: string): Promise<void> {
    const { url, key, bucket } = this.config();
    if (!matchesBulkStorageReference(contentRef, bucket))
      throw new BulkDomainError(
        'STORAGE_UNAVAILABLE',
        'La referencia privada no corresponde al bucket configurado.',
      );
    const objectName = contentRef.slice(`supabase://${bucket}/`.length);
    try {
      await withStorageRequest(undefined, async (signal) => {
        const response = await fetch(
          `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectName.split('/').map(encodeURIComponent).join('/')}`,
          {
            method: 'DELETE',
            headers: { apikey: key, authorization: `Bearer ${key}` },
            signal,
          },
        );
        if (!response.ok && response.status !== 404)
          throw new Error('object cleanup failed');
      });
    } catch (error) {
      throw new BulkDomainError(
        'STORAGE_UNAVAILABLE',
        'No se pudo retirar un objeto de exportación sin manifiesto.',
        { cause: error },
      );
    }
  }
}
