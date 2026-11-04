import { httpContracts } from '../../http/http-contract.generated.js';
import { isUuid } from '../../http/http-validation.js';
import type { PromotionsReadiness } from '../../health/promotions-readiness.service.js';

export const PROMOTIONS_OPERATION_LOGGER = Symbol(
  'PROMOTIONS_OPERATION_LOGGER',
);
// Only fixed operation identifiers, bounded numbers and validated correlation
// UUIDs cross this boundary. No request object, exception, URL, claims or payload.
export class PromotionsOperationLogger {
  constructor(
    private readonly write: (line: string) => void = (line) => {
      process.stdout.write(line + '\n');
    },
  ) {}
  http(
    operation: string,
    status: number,
    correlation: string,
    duration: number,
    code?: string,
  ): void {
    if (
      !Object.hasOwn(httpContracts, operation) ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      !isUuid(correlation)
    )
      return;
    const allowedCode =
      code && httpContracts[operation].errors[String(status)]?.includes(code)
        ? code
        : undefined;
    this.emit({
      timestamp: new Date().toISOString(),
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      service: 'promotions-svc',
      operation,
      status,
      correlation_id: correlation,
      duration_ms: Number.isFinite(duration)
        ? Math.min(300000, Math.max(0, Math.round(duration)))
        : 0,
      ...(allowedCode ? { code: allowedCode } : {}),
    });
  }
  readiness(result: PromotionsReadiness): void {
    const statuses = ['up', 'down', 'disabled', 'not_implemented'];
    if (
      !['ready', 'not_ready'].includes(result.status) ||
      !statuses.includes(result.dependencies.database) ||
      !statuses.includes(result.dependencies.broker)
    )
      return;
    this.emit({
      timestamp: new Date().toISOString(),
      level: result.status === 'ready' ? 'info' : 'warn',
      service: 'promotions-svc',
      code:
        result.status === 'ready'
          ? 'DEPENDENCIES_READY'
          : 'DEPENDENCIES_NOT_READY',
      database: result.dependencies.database,
      broker: result.dependencies.broker,
    });
  }
  private emit(value: Record<string, unknown>): void {
    try {
      this.write(JSON.stringify(value));
    } catch {
      /* Telemetry cannot change a business result. */
    }
  }
}
