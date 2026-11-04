import { describe, expect, it } from 'vitest';
import { bulkAmqpUserId, configuredBulkAmqpUrl } from './bulk-rabbitmq.js';

describe('Bulk AMQP identity', () => {
  it('decodes the username used by the AMQP URL', () => {
    expect(bulkAmqpUserId('amqp://bulk%2Bsvc:secret@localhost/g6-vhost')).toBe(
      'bulk+svc',
    );
  });

  it('uses amqplib’s guest default when the URL omits both credentials', () => {
    expect(bulkAmqpUserId('amqp://localhost/g6-vhost')).toBe('guest');
  });

  it('rejects an AMQP URL without a username', () => {
    expect(() => bulkAmqpUserId('amqp://:secret@localhost/g6-vhost')).toThrow(
      'BULK_AMQP_URL debe incluir un usuario AMQP.',
    );
  });

  it('rejects malformed encoded usernames', () => {
    expect(() =>
      bulkAmqpUserId('amqp://bulk%ZZ:secret@localhost/g6-vhost'),
    ).toThrow('BULK_AMQP_URL debe incluir una identidad AMQP válida.');
  });

  it('keeps AMQP disabled when its flag is false', () => {
    expect(
      configuredBulkAmqpUrl({
        BULK_AMQP_ENABLED: 'false',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
