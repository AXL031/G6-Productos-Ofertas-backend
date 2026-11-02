import { Injectable } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { isCorrelationId } from './correlation.js';
import { SanitizedLogger } from './sanitized-logger.js';

export type CatalogSignal =
  | 'AMQP_RECOVERY_BLOCKED'
  | 'AMQP_CONNECTED'
  | 'AMQP_CONNECTION_FAILURE'
  | 'AMQP_CHANNEL_FAILURE'
  | 'AMQP_CONSUMER_FAILURE'
  | 'AMQP_CONSUMER_CANCELLED'
  | 'AMQP_CYCLE_PENDING'
  | 'AMQP_SHUTDOWN_PENDING'
  | 'OUTBOX_PUBLISHED'
  | 'OUTBOX_PENDING'
  | 'INBOX_APPLIED'
  | 'INBOX_STALE'
  | 'INBOX_TERMINAL'
  | 'INBOX_DUPLICATE'
  | 'MASTER_BARRIER_UNPROVEN_FINAL'
  | 'MASTER_BARRIER_BLOCKED_ASSOCIATION'
  | 'MASTER_BARRIER_OPERATION_CONFLICT'
  | 'MASTER_BARRIER_FINAL_PENDING'
  | 'AMQP_RETRY_CONFIRMED'
  | 'AMQP_DLQ_CONFIRMED';

/** Internal process indicators, not a new public metrics contract or health claim. */
@Injectable()
export class CatalogTelemetry {
  private readonly counts = new Map<string, number>();
  async measure<T>(
    stage:
      | 'DEMO_CANDIDATES_SQL'
      | 'DEMO_ENRICHMENT_SQL'
      | 'DEMO_PRICING'
      | 'DEMO_LIST_TOTAL',
    work: () => Promise<T>,
    correlationId?: string,
  ): Promise<T> {
    const started = performance.now();
    let success = false;
    try {
      const result = await work();
      success = true;
      return result;
    } finally {
      new SanitizedLogger('runtime').log({
        code: 'CATALOG_LIST_STAGE',
        stage,
        success,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        correlationId: isCorrelationId(correlationId)
          ? correlationId
          : undefined,
      });
    }
  }
  record(
    code: CatalogSignal,
    ids: {
      correlationId?: string;
      operationId?: string;
      messageId?: string;
    } = {},
  ): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
    const safeIds = Object.fromEntries(
      Object.entries(ids).filter(([, value]) => isCorrelationId(value)),
    );
    new SanitizedLogger('runtime').log({ code, ...safeIds });
  }
  snapshot(): Readonly<Record<string, number>> {
    return Object.freeze(Object.fromEntries(this.counts));
  }
}

/** No raw URL, query, body, headers, subject or driver error enters the request log. */
export function catalogRequestLog(logger: SanitizedLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = performance.now();
    res.once('finish', () =>
      logger.log({
        code: 'HTTP_REQUEST_COMPLETED',
        method: [
          'GET',
          'POST',
          'PATCH',
          'DELETE',
          'PUT',
          'HEAD',
          'OPTIONS',
        ].includes(req.method)
          ? req.method
          : 'OTHER',
        status: res.statusCode,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        correlationId: isCorrelationId(res.getHeader('X-Correlation-Id'))
          ? res.getHeader('X-Correlation-Id')
          : undefined,
      }),
    );
    next();
  };
}
