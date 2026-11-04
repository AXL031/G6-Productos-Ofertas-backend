import { LoggerService } from '@nestjs/common';

const sensitiveKey =
  /password|passwd|secret|token|authorization|cookie|credential|key|url|dsn|headers|payload|body|query|parameters|detail|stack|path/i;

export function sanitize(
  value: unknown,
  secrets: readonly string[] = [],
  depth = 0,
): unknown {
  if (depth > 6) return '[truncated]';
  if (value instanceof Error) return { name: 'Error', message: '[redacted]' };
  if (typeof value === 'string') {
    if (/\n\s*at\s|(?:[A-Z]:\\|\/Users\/|\/home\/)/.test(value))
      return '[redacted-stack]';
    // JSON serialized by an adapter must receive the same key redaction as objects.
    if (/^\s*[[{]/.test(value)) {
      try {
        return JSON.stringify(sanitize(JSON.parse(value), secrets, depth + 1));
      } catch {
        // Fall back to text redaction for malformed JSON.
      }
    }
    let text = value;
    for (const secret of secrets
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join('[redacted]');
    }
    return text
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[redacted-url]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, '[redacted-token]')
      .replace(
        /([\w.-]*(?:password|passwd|secret|token|authorization|cookie|credential|key|dsn)[\w.-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        '$1[redacted]',
      );
  }
  if (Array.isArray(value))
    return value.map((item) => sanitize(item, secrets, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key)
          ? '[redacted]'
          : sanitize(item, secrets, depth + 1),
      ]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol')
    return '[redacted]';
  return value;
}

export class SanitizedLogger implements LoggerService {
  constructor(
    private readonly environment: string,
    private readonly secrets: readonly string[] = [],
    private readonly write: (line: string) => void = (line) =>
      process.stdout.write(line + '\n'),
  ) {}

  private emit(level: string, message: unknown, context: unknown[]): void {
    this.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        service: 'catalog-svc',
        environment: sanitize(this.environment, this.secrets),
        message: sanitize(message, this.secrets),
        context: sanitize(context, this.secrets),
      }),
    );
  }

  log(message: unknown, ...context: unknown[]): void {
    this.emit('info', message, context);
  }
  error(message: unknown, ...context: unknown[]): void {
    this.emit('error', message, context);
  }
  warn(message: unknown, ...context: unknown[]): void {
    this.emit('warn', message, context);
  }
  debug(message: unknown, ...context: unknown[]): void {
    this.emit('debug', message, context);
  }
  verbose(message: unknown, ...context: unknown[]): void {
    this.emit('trace', message, context);
  }
  fatal(message: unknown, ...context: unknown[]): void {
    this.emit('fatal', message, context);
  }
}
