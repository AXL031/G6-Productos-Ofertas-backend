import { Injectable } from '@nestjs/common';
import { BulkDomainError } from '../domain/bulk.domain-error.js';
import { matchesBulkStorageReference } from './bulk-storage-reference.js';

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
  ): Promise<string> {
    const { url, key, bucket } = this.config();
    try {
      const headers = { apikey: key, authorization: `Bearer ${key}` };
      const bucketResponse = await fetch(
        `${url}/storage/v1/bucket/${encodeURIComponent(bucket)}`,
        { headers },
      );
      if (!bucketResponse.ok) throw new Error('bucket unavailable');
      const metadata: unknown = await bucketResponse.json();
      if (
        !metadata ||
        typeof metadata !== 'object' ||
        Reflect.get(metadata, 'public') !== false
      )
        throw new Error('bucket must be private');
      const objectUrl = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectName.split('/').map(encodeURIComponent).join('/')}`;
      const existing = await fetch(objectUrl, { headers });
      if (existing.ok) {
        const existingBytes = Buffer.from(await existing.arrayBuffer());
        if (!existingBytes.equals(bytes))
          throw new Error('idempotent object conflict');
        return `supabase://${bucket}/${objectName}`;
      }
      if (existing.status !== 404) throw new Error('object lookup failed');
      const response = await fetch(objectUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': contentType,
          'x-upsert': 'false',
        },
        body: new Uint8Array(bytes),
      });
      if (!response.ok) {
        const raced = await fetch(objectUrl, { headers });
        if (!raced.ok || !Buffer.from(await raced.arrayBuffer()).equals(bytes))
          throw new Error('upload failed or object conflict');
      }
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

  async get(contentRef: string): Promise<Buffer> {
    const { url, key, bucket } = this.config();
    const prefix = `supabase://${bucket}/`;
    if (!matchesBulkStorageReference(contentRef, bucket))
      throw new BulkDomainError(
        'STORAGE_UNAVAILABLE',
        'La referencia privada no corresponde al bucket configurado.',
      );
    const objectName = contentRef.slice(prefix.length);
    try {
      const response = await fetch(
        `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectName.split('/').map(encodeURIComponent).join('/')}`,
        {
          headers: { apikey: key, authorization: `Bearer ${key}` },
        },
      );
      if (!response.ok) throw new Error('download failed');
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new BulkDomainError(
        'STORAGE_UNAVAILABLE',
        'El archivo privado no está disponible.',
        { cause: error },
      );
    }
  }
}
