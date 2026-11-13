import type { INestApplication } from '@nestjs/common';
import { CONTRACT_ROUTES } from './contract-routes.js';

export function configureGatewayCors(
  app: INestApplication,
  configuredOrigins?: string,
): void {
  if (!configuredOrigins?.trim()) return;
  const origins = configuredOrigins.split(',').map((entry) => {
    const value = entry.trim();
    const url = URL.parse(value);
    if (
      !url ||
      !['http:', 'https:'].includes(url.protocol) ||
      value !== url.origin ||
      url.hostname.includes('*')
    )
      throw new Error('Invalid GATEWAY_CORS_ALLOWED_ORIGINS');
    return url.origin;
  });
  app.enableCors({
    origin: origins,
    methods: [...new Set(CONTRACT_ROUTES.map((route) => route.method))],
    allowedHeaders: [
      ...new Set([
        'authorization',
        'content-type',
        'x-correlation-id',
        'idempotency-key',
        ...CONTRACT_ROUTES.flatMap((route) =>
          route.headers.map((header) => header.name),
        ),
      ]),
    ],
    exposedHeaders: ['Content-Disposition', 'Location', 'X-Correlation-Id'],
  });
}
