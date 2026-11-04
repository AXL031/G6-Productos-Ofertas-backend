import { ConsoleLogger, LoggerService } from '@nestjs/common';

const SENSITIVE_KEY =
  /(password|passwd|secret|token|key|authorization|cookie|credential|database[_-]?url|rabbitmq[_-]?url|dsn|bearer)/i;

const KEY_VALUE_PAIR =
  /([A-Za-z0-9_.-]*(?:password|passwd|secret|token|key|authorization|credential|dsn|url)[A-Za-z0-9_.-]*\s*[=:]\s*)([^\s,;&]+)/gi;

const URL_CREDENTIALS = /(:\/\/[^/@\s:]+:)[^@/\s]+(@)/g;

const BEARER_TOKEN = /(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi;

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;

const MAX_DEPTH = 6;
const MASK = '***';
const DEPTH_TRUNCATED = '[truncado]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeText(text: string): string {
  return text
    .replace(PEM_BLOCK, MASK)
    .replace(BEARER_TOKEN, `$1${MASK}`)
    .replace(KEY_VALUE_PAIR, `$1${MASK}`)
    .replace(URL_CREDENTIALS, `$1${MASK}$2`);
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return sanitizeText(value);
  }
  if (value instanceof Error) {
    return sanitizeText(value.message);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      return DEPTH_TRUNCATED;
    }
    return value.map((item) => sanitize(item, depth + 1));
  }
  if (isPlainObject(value)) {
    if (depth >= MAX_DEPTH) {
      return DEPTH_TRUNCATED;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? MASK : sanitize(item, depth + 1);
    }
    return result;
  }
  return value;
}

function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map((arg) => sanitize(arg));
}

/**
 * Logger que redacta secretos (URLs de conexión, contraseñas, tokens Bearer,
 * bloques PEM y claves sensibles) antes de delegar en el logger destino.
 * No expone material de G7, Supabase ni RabbitMQ en los registros.
 */
export class SanitizedLogger implements LoggerService {
  constructor(private readonly target: LoggerService = new ConsoleLogger()) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.target.log(sanitize(message), ...sanitizeArgs(optionalParams));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.target.error(sanitize(message), ...sanitizeArgs(optionalParams));
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.target.warn(sanitize(message), ...sanitizeArgs(optionalParams));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.target.debug?.(sanitize(message), ...sanitizeArgs(optionalParams));
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.target.verbose?.(sanitize(message), ...sanitizeArgs(optionalParams));
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.target.fatal?.(sanitize(message), ...sanitizeArgs(optionalParams));
  }
}
