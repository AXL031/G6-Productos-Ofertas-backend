export interface ContractSchema {
  type?: string | string[];
  properties?: Record<string, ContractSchema>;
  required?: string[];
  allOf?: ContractSchema[];
  oneOf?: ContractSchema[];
  if?: ContractSchema;
  then?: ContractSchema;
  enum?: unknown[];
  const?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  pattern?: string;
  format?: string;
  description?: string;
  additionalProperties?: boolean | ContractSchema;
}
export interface MessageContract {
  exchange: string;
  routingKey: string;
  schema: ContractSchema;
}

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validDate(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match;
  return (
    Number(month) >= 1 &&
    Number(month) <= 12 &&
    Number(day) >= 1 &&
    Number(day) <=
      new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate() &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60 &&
    Number(offsetHour ?? 0) < 24 &&
    Number(offsetMinute ?? 0) < 60
  );
}

export function matchesSchema(value: unknown, schema: ContractSchema): boolean {
  if (
    schema.if &&
    schema.then &&
    matchesSchema(value, schema.if) &&
    !matchesSchema(value, schema.then)
  )
    return false;
  if (schema.allOf && !schema.allOf.every((item) => matchesSchema(value, item)))
    return false;
  if (
    schema.oneOf &&
    schema.oneOf.filter((item) => matchesSchema(value, item)).length !== 1
  )
    return false;
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      !types.some((type) =>
        type === 'null'
          ? value === null
          : type === 'object'
            ? record(value)
            : type === 'integer'
              ? Number.isSafeInteger(value)
              : typeof value === type,
      )
    )
      return false;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength)
      return false;
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength)
      return false;
    if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (
      schema.format === 'uuid' &&
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
    )
      return false;
    if (schema.format === 'date-time' && !validDate(value)) return false;
  }
  if (
    typeof value === 'number' &&
    schema.minimum !== undefined &&
    value < schema.minimum
  )
    return false;
  if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) continue;
      if (schema.additionalProperties === false) return false;
      if (
        record(schema.additionalProperties) &&
        !matchesSchema(item, schema.additionalProperties)
      )
        return false;
    }
    if (schema.required?.some((key) => !Object.hasOwn(value, key)))
      return false;
    if (
      Object.entries(schema.properties ?? {}).some(
        ([key, property]) =>
          Object.hasOwn(value, key) && !matchesSchema(value[key], property),
      )
    )
      return false;
  }
  return true;
}
