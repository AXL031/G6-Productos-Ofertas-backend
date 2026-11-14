import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { CatalogTelemetry, catalogRequestLog } from './catalog-telemetry.js';
import { SanitizedLogger } from './sanitized-logger.js';

describe('Catalog operational signals', () => {
  afterEach(() => vi.restoreAllMocks());
  it('counts bounded signals and only records valid technical identifiers', () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const telemetry = new CatalogTelemetry(),
      id = randomUUID();
    telemetry.record('INBOX_STALE', {
      correlationId: id,
      messageId: 'Bearer secret',
    });
    expect(telemetry.snapshot()).toEqual({ INBOX_STALE: 1 });
    expect(JSON.stringify(output.mock.calls)).toContain(id);
    expect(JSON.stringify(output.mock.calls)).not.toContain('Bearer secret');
    expect(Object.isFrozen(telemetry.snapshot())).toBe(true);
  });
  it('logs request status, duration and correlation without path, headers or payload', () => {
    const lines: string[] = [],
      logger = new SanitizedLogger('test', [], (line) => lines.push(line)),
      id = randomUUID();
    const response = Object.assign(new EventEmitter(), {
      statusCode: 503,
      getHeader: () => id,
    });
    const next = vi.fn();
    catalogRequestLog(logger)(
      {
        method: 'GET',
        originalUrl: '/private?token=secret',
        headers: { authorization: 'Bearer private' },
      } as Request,
      response as unknown as Response,
      next,
    );
    expect(lines).toHaveLength(0);
    response.emit('finish');
    expect(next).toHaveBeenCalledOnce();
    expect(JSON.parse(lines[0])).toMatchObject({
      message: {
        code: 'HTTP_REQUEST_COMPLETED',
        status: 503,
        correlationId: id,
      },
    });
    expect(lines[0]).not.toMatch(/private|secret|authorization|originalUrl/);
  });
});
