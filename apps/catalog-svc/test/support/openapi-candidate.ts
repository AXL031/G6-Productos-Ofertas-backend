import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  Ajv2020,
  type AnySchema,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { format, type Parser } from 'prettier';
import { parsers, printers } from 'prettier/plugins/yaml';

const addFormats = createRequire(import.meta.url)(
  'ajv-formats',
) as FormatsPlugin;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
interface YamlNode {
  type: string;
  value?: string;
  children?: YamlNode[];
  anchor?: unknown;
  tag?: unknown;
}

/** Decode the existing Prettier YAML parser's AST, not a second YAML parser.
 * The candidate is JSON-compatible YAML; tags, aliases, duplicate keys and
 * multiple documents fail closed instead of silently changing the contract. */
export async function parseCandidateYaml(source: string): Promise<JsonObject> {
  let parsed: unknown;
  const capture: Parser<unknown> = {
    ...parsers.yaml,
    parse: async (text, options) => {
      const ast: unknown = await parsers.yaml.parse(text, options);
      parsed = ast;
      return ast;
    },
  };
  // Prettier supplies complete ParserOptions through its public plugin API.
  await format(source, {
    parser: 'catalog-yaml-ast',
    plugins: [{ parsers: { 'catalog-yaml-ast': capture }, printers }],
  });
  const root = parsed as YamlNode;
  if (root.children?.length !== 1 || root.children[0].type !== 'document')
    throw new Error('One YAML document required');
  const body = root.children[0].children?.find(
    (node) => node.type === 'documentBody',
  );
  if (body?.children?.length !== 1) throw new Error('One YAML body required');
  function decode(node: YamlNode): JsonValue {
    if (node.anchor || node.tag)
      throw new Error('YAML anchors/tags are not candidate JSON');
    const children = node.children ?? [];
    if (node.type === 'mapping' || node.type === 'flowMapping') {
      const result: JsonObject = Object.create(null);
      for (const item of children) {
        const [keyNode, valueNode] = item.children ?? [];
        if (!keyNode || !valueNode) throw new Error('Invalid YAML mapping');
        const key = decode(keyNode);
        if (typeof key !== 'string' || Object.hasOwn(result, key))
          throw new Error('String and unique YAML keys required');
        result[key] = decode(valueNode);
      }
      return result;
    }
    if (node.type === 'sequence' || node.type === 'flowSequence')
      return children.map(decode);
    if (
      [
        'mappingKey',
        'mappingValue',
        'sequenceItem',
        'flowSequenceItem',
      ].includes(node.type)
    ) {
      if (children.length > 1) throw new Error('Invalid YAML item');
      return children.length ? decode(children[0]) : null;
    }
    if (node.type === 'plain' && typeof node.value === 'string') {
      if (
        /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(
          node.value,
        )
      )
        return JSON.parse(node.value) as JsonValue;
      return node.value;
    }
    if (
      ['quoteSingle', 'quoteDouble', 'blockFolded', 'blockLiteral'].includes(
        node.type,
      ) &&
      typeof node.value === 'string'
    )
      return node.value;
    throw new Error('Unsupported candidate YAML node: ' + node.type);
  }
  const value = decode(body.children[0]);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('OpenAPI object required');
  return value;
}

/** Official OAS 3.1 structure + OAS dialect/Draft 2020-12, vendored/offline.
 * Ajv/ajv-formats are already locked development dependencies of Nest CLI. */
export function candidateValidators(document: JsonObject): {
  openapi: ValidateFunction;
  component: (name: string) => ValidateFunction;
  at: (pointer: string) => ValidateFunction;
} {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  // RFC 9110 token media ranges and optional token/quoted-string parameters.
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  ajv.addFormat(
    'media-range',
    new RegExp(
      '^(?:\\*/\\*|' +
        token +
        '/(?:\\*|' +
        token +
        '))(?:\\s*;\\s*' +
        token +
        '=(?:' +
        token +
        '|"(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*"))*$',
    ),
  );
  const schema = (name: string) =>
    JSON.parse(
      readFileSync(
        resolve('apps/catalog-svc/test/fixtures/openapi-3.1', name + '.json'),
        'utf8',
      ),
    ) as JsonObject;
  const dialectAjv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(dialectAjv);
  dialectAjv.addMetaSchema(schema('meta-2024-11-10'));
  dialectAjv.addMetaSchema(schema('dialect-2024-11-10'));
  const dialect = dialectAjv.getSchema(
    'https://spec.openapis.org/oas/3.1/dialect/2024-11-10',
  );
  if (!dialect) throw new Error('Missing fixed OAS dialect');
  ajv.addKeyword({
    keyword: 'oasSchemaObject',
    validate: (_rule: boolean, value: unknown) => dialect(value),
    errors: false,
  });
  const structural = schema('schema-2025-09-15');
  const base = schema('schema-base-2025-09-15');
  // Bind the official schema-base's default dialect explicitly. Ajv 8.20's
  // nested dynamic "meta" scope otherwise mistakes Parameter schemas for
  // Parameters. A separate evaluator preserves the OAS Schema Object rules.
  function bindMeta(value: JsonValue): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(bindMeta);
      return;
    }
    if (value.$dynamicRef === '#meta') {
      delete value.$dynamicRef;
      value.$ref = '#/$defs/schema';
    }
    Object.values(value).forEach(bindMeta);
  }
  bindMeta(structural);
  const definitions = structural.$defs as JsonObject;
  const baseDefinitions = base.$defs as JsonObject;
  definitions.dialect = baseDefinitions.dialect;
  definitions.schema = {
    type: ['object', 'boolean'],
    oasSchemaObject: true,
    properties: { $schema: { $ref: '#/$defs/dialect' } },
  };
  (structural.properties as JsonObject).jsonSchemaDialect = (
    base.properties as JsonObject
  ).jsonSchemaDialect;
  const openapi = ajv.compile(structural as AnySchema);
  // The document is the local resolution root for its Schema Object references.
  ajv.addSchema(document as AnySchema, 'catalog-candidate');
  function references(value: JsonValue): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(references);
      return;
    }
    if (typeof value.$ref === 'string') {
      if (!value.$ref.startsWith('#/'))
        throw new Error('Candidate references must be local');
      let target: JsonValue | undefined = document;
      for (const segment of value.$ref.slice(2).split('/')) {
        const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
        target =
          target && typeof target === 'object' && !Array.isArray(target)
            ? target[key]
            : undefined;
      }
      if (target === undefined)
        throw new Error('Unresolved candidate reference: ' + value.$ref);
    }
    Object.values(value).forEach(references);
  }
  references(document);
  const at = (pointer: string) => {
    const validator = ajv.getSchema('catalog-candidate#' + pointer);
    if (!validator) throw new Error('Missing candidate schema: ' + pointer);
    return validator;
  };
  return {
    openapi,
    component: (name) => at('/components/schemas/' + name),
    at,
  };
}
