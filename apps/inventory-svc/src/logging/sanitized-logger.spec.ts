import { describe, it, expect } from 'vitest';
import type { LoggerService } from '@nestjs/common';
import { sanitize, sanitizeText, SanitizedLogger } from './sanitized-logger.js';

describe('sanitizeText — redacción de secretos', () => {
  it('redacta la contraseña embebida en una URL de conexión', () => {
    const result = sanitizeText(
      'postgres://inventory:s3cr3t-password@db.internal:5432/inventory',
    );

    expect(result).not.toContain('s3cr3t-password');
    expect(result).toContain('postgres://inventory:***@');
  });

  it('redacta el valor de DATABASE_URL y RABBITMQ_URL en texto clave=valor', () => {
    const result = sanitizeText(
      'DATABASE_URL=postgres://u:p@host/db RABBITMQ_URL=amqp://user:pass@broker/vhost',
    );

    expect(result).not.toContain('postgres://u:p@host/db');
    expect(result).not.toContain('amqp://user:pass@broker/vhost');
  });

  it('redacta tokens Bearer', () => {
    const result = sanitizeText(
      'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.signature',
    );

    expect(result).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(result).toContain('***');
  });

  it('redacta bloques PEM completos', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const result = sanitizeText(`Clave cargada: ${pem}`);

    expect(result).not.toContain('MIIEvQIBADANBgkq');
    expect(result).not.toContain('BEGIN PRIVATE KEY');
    expect(result).toContain('***');
  });

  it('no altera texto sin secretos', () => {
    expect(sanitizeText('inventory-svc escuchando en el puerto 3005')).toBe(
      'inventory-svc escuchando en el puerto 3005',
    );
  });
});

describe('sanitize — objetos y errores', () => {
  it('enmascara claves sensibles en objetos anidados', () => {
    const result = sanitize({
      ok: true,
      db: { DATABASE_URL: 'postgres://u:p@host/db', host: 'localhost' },
      RABBITMQ_URL: 'amqp://u:p@broker',
    }) as Record<string, any>;

    expect(result.db.DATABASE_URL).toBe('***');
    expect(result.db.host).toBe('localhost');
    expect(result.RABBITMQ_URL).toBe('***');
    expect(result.ok).toBe(true);
  });

  it('sanitiza el mensaje de un Error', () => {
    const result = sanitize(new Error('fallo con postgres://u:s3cr3t@host/db'));

    expect(String(result)).not.toContain('s3cr3t');
  });
});

describe('SanitizedLogger', () => {
  function createCapturingTarget(): {
    target: LoggerService;
    calls: unknown[][];
  } {
    const calls: unknown[][] = [];
    const target: LoggerService = {
      log: (...args: unknown[]) => calls.push(args),
      error: (...args: unknown[]) => calls.push(args),
      warn: (...args: unknown[]) => calls.push(args),
      debug: (...args: unknown[]) => calls.push(args),
      verbose: (...args: unknown[]) => calls.push(args),
      fatal: (...args: unknown[]) => calls.push(args),
    };
    return { target, calls };
  }

  it('redacta secretos antes de delegar en el logger destino', () => {
    const { target, calls } = createCapturingTarget();
    const logger = new SanitizedLogger(target);

    logger.log('arranque', { DATABASE_URL: 'postgres://u:s3cr3t@host/db' });

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).toContain('***');
  });

  it('redacta secretos en error/warn', () => {
    const { target, calls } = createCapturingTarget();
    const logger = new SanitizedLogger(target);

    logger.error('fallo', { PGPASSWORD: 'super-secreto' });
    logger.warn('amqp://user:pass@broker/vhost');

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain('super-secreto');
    expect(serialized).not.toContain('user:pass@broker');
  });
});
