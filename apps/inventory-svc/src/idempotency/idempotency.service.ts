import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

@Injectable()
export class IdempotencyService {
  /**
   * Generates a deterministic SHA-256 hex string (64 chars)
   * representing the semantic content of a request.
   */
  computeFingerprint(payload: unknown): string {
    const canonical = this.canonicalize(payload);
    return createHash('sha256').update(canonical).digest('hex').toLowerCase();
  }

  /**
   * Verifies if an incoming request has the exact same semantic fingerprint
   * as a previously registered operation.
   */
  isMatchingFingerprint(
    storedFingerprint: string | null | undefined,
    incomingFingerprint: string,
  ): boolean {
    if (!storedFingerprint) return false;
    return (
      storedFingerprint.toLowerCase() === incomingFingerprint.toLowerCase()
    );
  }

  private canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      // Check if this is an array of inventory lines with 'sku' property
      const isLineArray =
        value.length > 0 &&
        typeof value[0] === 'object' &&
        value[0] !== null &&
        'sku' in value[0];
      let arrayToNormalize = [...value];
      if (isLineArray) {
        arrayToNormalize.sort((a, b) => {
          const skuA = String(a.sku ?? '');
          const skuB = String(b.sku ?? '');
          if (skuA !== skuB) return skuA.localeCompare(skuB);
          const locA = String(a.location_id ?? '');
          const locB = String(b.location_id ?? '');
          return locA.localeCompare(locB);
        });
      }
      return (
        '[' +
        arrayToNormalize.map((item) => this.canonicalize(item)).join(',') +
        ']'
      );
    }

    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const parts = sortedKeys.map((key) => {
      return JSON.stringify(key) + ':' + this.canonicalize(obj[key]);
    });
    return '{' + parts.join(',') + '}';
  }
}
