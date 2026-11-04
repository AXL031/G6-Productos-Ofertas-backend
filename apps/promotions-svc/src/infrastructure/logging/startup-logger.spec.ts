import { PromotionsConfigurationError } from '../config/promotions-config.js';
import { PromotionsStartupLogger } from './startup-logger.js';

describe('Promotions startup logging', () => {
  it('writes structured startup events', () => {
    const write = vi.fn();
    new PromotionsStartupLogger(write).started();
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({
      service: 'promotions-svc',
      level: 'info',
      code: 'APPLICATION_STARTED',
    });
  });

  it('reports invalid variable names without logging configuration values', () => {
    const write = vi.fn();
    new PromotionsStartupLogger(write).failed(
      new PromotionsConfigurationError(['PGPASSWORD', 'RABBITMQ_URL']),
    );
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({
      code: 'CONFIGURATION_INVALID',
      variables: ['PGPASSWORD', 'RABBITMQ_URL'],
    });
  });

  it('discards raw exceptions including credentials, tokens and stacks', () => {
    const write = vi.fn();
    const error = new Error(
      'amqp://user:secret@host Authorization: Bearer token',
    );
    error.stack = 'password=private-value';
    const logger = new PromotionsStartupLogger(write);
    logger.failed(error);
    logger.failed({ PGPASSWORD: 'another-secret', cause: error });
    for (const [line] of write.mock.calls) {
      expect(JSON.parse(line)).toMatchObject({
        code: 'APPLICATION_START_FAILED',
      });
      expect(line).not.toMatch(/secret|token|private-value|password|amqp/i);
    }
  });
});
