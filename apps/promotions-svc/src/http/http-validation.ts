import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { validInstant } from '../domain/date-time.js';
export interface HttpSchema {
  type?: string | string[];
  properties?: Record<string, HttpSchema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  allOf?: HttpSchema[];
  oneOf?: HttpSchema[];
  if?: HttpSchema;
  then?: HttpSchema;
  items?: HttpSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  format?: string;
  pattern?: string;
  default?: unknown;
  additionalProperties?: boolean | HttpSchema;
  readOnly?: boolean;
}
export interface HttpOperation {
  method: string;
  path: string;
  security: string[];
  scope?: string;
  audience?: string;
  clients?: string[];
  query: Record<string, { required: boolean; schema: HttpSchema }>;
  body?: HttpSchema;
  response: HttpSchema;
  errors: Record<string, string[]>;
}
export class PromotionsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
export function valid(value: unknown, s: HttpSchema): boolean {
  if (s.allOf && !s.allOf.every((v) => valid(value, v))) return false;
  if (s.oneOf && s.oneOf.filter((v) => valid(value, v)).length !== 1)
    return false;
  if (s.if && s.then && valid(value, s.if) && !valid(value, s.then))
    return false;
  if (
    ('const' in s && value !== s.const) ||
    (s.enum && !s.enum.includes(value))
  )
    return false;
  const types = s.type ? (Array.isArray(s.type) ? s.type : [s.type]) : [];
  if (
    types.length &&
    !types.some((t) =>
      t === 'null'
        ? value === null
        : t === 'array'
          ? Array.isArray(value)
          : t === 'object'
            ? object(value)
            : t === 'integer'
              ? typeof value === 'number' && Number.isSafeInteger(value)
              : t === 'number'
                ? typeof value === 'number' && Number.isFinite(value)
                : typeof value === t,
    )
  )
    return false;
  if (typeof value === 'string') {
    if (
      (s.minLength !== undefined && [...value].length < s.minLength) ||
      (s.maxLength !== undefined && [...value].length > s.maxLength) ||
      (s.pattern && !new RegExp(s.pattern).test(value))
    )
      return false;
    if (
      (s.format === 'uuid' && !isUuid(value)) ||
      (s.format === 'date-time' && !validInstant(value))
    )
      return false;
  }
  if (
    typeof value === 'number' &&
    ((s.minimum !== undefined && value < s.minimum) ||
      (s.maximum !== undefined && value > s.maximum) ||
      (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum))
  )
    return false;
  if (
    Array.isArray(value) &&
    ((s.minItems !== undefined && value.length < s.minItems) ||
      (s.maxItems !== undefined && value.length > s.maxItems) ||
      (s.items && !value.every((v) => valid(v, s.items!))) ||
      (s.uniqueItems &&
        new Set(value.map((v) => JSON.stringify(v))).size !== value.length))
  )
    return false;
  if (object(value)) {
    if (s.required?.some((k) => !Object.hasOwn(value, k))) return false;
    for (const [k, v] of Object.entries(value)) {
      if (s.properties?.[k]) {
        if (!valid(v, s.properties[k])) return false;
      } else if (s.additionalProperties === false) return false;
      else if (
        object(s.additionalProperties) &&
        !valid(v, s.additionalProperties)
      )
        return false;
    }
  }
  return true;
}
export function queryInput(
  input: Request['query'],
  operation: HttpOperation,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(operation.query)) {
    let value: unknown = input[name];
    if (value === undefined) {
      if (p.required) throw new PromotionsHttpError(400, 'VALIDACION');
      if (p.schema.default !== undefined) output[name] = p.schema.default;
      continue;
    }
    if (typeof value !== 'string')
      throw new PromotionsHttpError(400, 'VALIDACION');
    if (p.schema.type === 'integer')
      value = /^\d+$/.test(value) ? Number(value) : NaN;
    else if (p.schema.type === 'boolean')
      value = value === 'true' ? true : value === 'false' ? false : null;
    if (!valid(value, p.schema))
      throw new PromotionsHttpError(400, 'VALIDACION');
    output[name] = value;
  }
  return output;
}
const correlations = new WeakMap<Request, string>();
export function correlationId(request: Request): string {
  const existing = correlations.get(request);
  if (existing) return existing;
  const v = request.header('X-Correlation-Id');
  const id = isUuid(v) ? v : randomUUID();
  correlations.set(request, id);
  return id;
}
