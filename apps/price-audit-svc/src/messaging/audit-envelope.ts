import { validAuditTimestamp } from '../domain/audit-timestamp.js';
import { uuid } from '../domain/audit.js';
import { AuditHttpError } from '../http/audit-http.error.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Shared within this service by its H4 and H5 transport adapters.
export function decodeAuditEnvelope(
  content: Uint8Array,
  properties: {
    contentType?: unknown;
    messageId?: unknown;
    correlationId?: unknown;
  },
) {
  if (
    content.length > 1024 * 1024 ||
    properties.contentType !== 'application/json'
  )
    throw new AuditHttpError(400, 'VALIDACION');
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(content),
    );
  } catch {
    throw new AuditHttpError(400, 'VALIDACION');
  }
  if (
    !record(body) ||
    body.name !== 'pricing.price.changed' ||
    body.producer !== 'pricing-svc' ||
    body.kind !== 'event' ||
    body.schema_version !== 1 ||
    typeof body.message_id !== 'string' ||
    !uuid.test(body.message_id) ||
    typeof body.correlation_id !== 'string' ||
    !uuid.test(body.correlation_id) ||
    !validAuditTimestamp(body.occurred_at) ||
    !record(body.data) ||
    (body.operation_id !== undefined &&
      body.operation_id !== null &&
      (typeof body.operation_id !== 'string' ||
        !uuid.test(body.operation_id))) ||
    (body.causation_id !== undefined &&
      body.causation_id !== null &&
      typeof body.causation_id !== 'string') ||
    (properties.messageId !== undefined &&
      properties.messageId !== body.message_id) ||
    (properties.correlationId !== undefined &&
      properties.correlationId !== body.correlation_id)
  )
    throw new AuditHttpError(400, 'VALIDACION');
  return {
    id: body.message_id,
    correlationId: body.correlation_id,
    payload: body,
    data: body.data,
    occurredAt: new Date(body.occurred_at),
  };
}
