import { ConsoleLogger, type LoggerService } from '@nestjs/common';

const MESSAGES = new Set([
  'pricing-svc iniciado.',
  'Configuración inválida: revisar NODE_ENV, PRICING_SVC_PORT/PORT y DATABASE_URL/TLS.',
  'No se pudo iniciar pricing-svc.',
  'Conexión PostgreSQL inactiva no disponible.',
  'Publicación AMQP de Pricing pendiente de recuperación.',
]);
const CONTEXTS = new Set([
  'Bootstrap',
  'PricingReadiness',
  'PricingDatabase',
  'PricingOutboxRelay',
  'NestFactory',
  'NestApplication',
]);

// Lista cerrada: ningún contenido externo/dinámico se serializa ni inspecciona.
function controlled(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : '[REDACTED]';
}

export class SafeLogger implements LoggerService {
  constructor(
    private readonly environment: string = 'unknown',
    private readonly destination: LoggerService = new ConsoleLogger({
      json: true,
    }),
  ) {}

  http(correlationId: string, status: number, durationMs: number): void {
    this.destination.log({
      service: 'pricing-svc',
      environment: controlled(
        this.environment,
        new Set(['development', 'test', 'production', 'unknown']),
      ),
      message: 'Consulta HTTP de Pricing finalizada.',
      correlation_id:
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          correlationId,
        )
          ? correlationId
          : '[REDACTED]',
      status:
        Number.isInteger(status) && status >= 100 && status <= 599
          ? status
          : 500,
      duration_ms:
        Number.isFinite(durationMs) && durationMs >= 0
          ? Math.round(durationMs)
          : 0,
    });
  }

  private write(
    level: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal',
    message: unknown,
    optional: unknown[],
  ): void {
    const record = {
      service: 'pricing-svc',
      environment: controlled(
        this.environment,
        new Set(['development', 'test', 'production', 'unknown']),
      ),
      message: controlled(message, MESSAGES),
      context: optional.map((value) => controlled(value, CONTEXTS)),
    };
    this.destination[level]?.(record);
  }
  log(message: unknown, ...optional: unknown[]): void {
    this.write('log', message, optional);
  }
  error(message: unknown, ...optional: unknown[]): void {
    this.write('error', message, optional);
  }
  warn(message: unknown, ...optional: unknown[]): void {
    this.write('warn', message, optional);
  }
  debug(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }
  verbose(message: unknown, ...optional: unknown[]): void {
    this.write('verbose', message, optional);
  }
  fatal(message: unknown, ...optional: unknown[]): void {
    this.write('fatal', message, optional);
  }
}
