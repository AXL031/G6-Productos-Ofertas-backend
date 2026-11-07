import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { HttpException, type ArgumentsHost } from '@nestjs/common';
import {
  parseCandidateYaml,
  candidateValidators,
  type JsonObject,
} from '../test/support/openapi-candidate.js';
import { parseHistoricalSelection } from './historical-recovery.service.js';
import { ProblemFilter } from './problem.filter.js';

describe('Historical OpenAPI 3.1 semantic contract (official offline metaschema)', () => {
  let document: JsonObject;
  beforeAll(async () => {
    document = await parseCandidateYaml(
      readFileSync(
        'apps/catalog-svc/contracts/recuperacion-historica.openapi.candidate.yaml',
        'utf8',
      ),
    );
  });
  it('pins unmodified official schema snapshots so CI needs no network', () => {
    const hashes = {
      'schema-2025-09-15':
        'd0a3955182364c7b5fdebfd0583ecad259a870b4a2fe86a1b0fe8785f8224fed',
      'schema-base-2025-09-15':
        '740186b45574c93647b1ca6184a96310efd384fbeed16bebd07f572eedfbddd4',
      'dialect-2024-11-10':
        '647f32dfff64949d5020a28ecd1af4ffeffb1e9c695f861a52255a8004e07460',
      'meta-2024-11-10':
        '80706a9a404affedbf84ac4dc1328c9ce0d2a00804cdfc4d95c0ddd0053121dd',
    };
    for (const [name, hash] of Object.entries(hashes)) {
      const source = readFileSync(
        'apps/catalog-svc/test/fixtures/openapi-3.1/' + name + '.json',
        'utf8',
      ).replaceAll('\r\n', '\n');
      expect(createHash('sha256').update(source).digest('hex')).toBe(hash);
    }
  });
  it('validates the actual YAML document including Schema Objects', () => {
    const { openapi } = candidateValidators(document);
    expect(openapi(document), JSON.stringify(openapi.errors)).toBe(true);
  });
  it('rejects an extra property on an OpenAPI Response even though YAML parses it', async () => {
    const invalid = await parseCandidateYaml(
      "openapi: 3.1.0\ninfo: {title: Regression, version: '1'}\npaths:\n  /x:\n    post:\n      responses:\n        '409': {description: IDEMPOTENCY_CONFLICT, PREPARACION_NO_REINTENTABLE o CAMBIO_ESTRUCTURAL_NO_PERMITIDO}\n",
    );
    const { openapi } = candidateValidators(invalid);
    expect(openapi(invalid)).toBe(false);
    expect(
      openapi.errors?.some(
        (error) => error.keyword === 'unevaluatedProperties',
      ),
    ).toBe(true);
  });
  it('agrees with the DTO when variants are supplied for Pricing-only', () => {
    const value = {
      solicitudId: randomUUID(),
      dependencias: ['PRICING'],
      moneda: 'USD',
      variantIds: [randomUUID()],
    };
    expect(() => parseHistoricalSelection(value)).toThrow();
    expect(
      candidateValidators(document).component('HistoricalRecoveryRequest')(
        value,
      ),
    ).toBe(false);
  });
  it('rejects invalid OpenAPI fixed fields and invalid JSON Schema keywords', () => {
    const components = document.components as JsonObject;
    const patches: JsonObject[] = [
      { openapi: '3.0.3' },
      { info: { title: 4, version: '1' } },
      {
        components: {
          ...components,
          schemas: {
            ...(components.schemas as JsonObject),
            Invalid: { type: 'array', minItems: -1 },
          },
        },
      },
    ];
    for (const patch of patches) {
      const changed = { ...document, ...patch };
      expect(candidateValidators(changed).openapi(changed)).toBe(false);
    }
  });
  it('fails unresolved references and unsupported YAML structures instead of accepting them silently', async () => {
    const changed = {
      ...document,
      components: {
        schemas: { Broken: { $ref: '#/components/schemas/Absent' } },
      },
    };
    expect(() => candidateValidators(changed)).toThrow(
      'Unresolved candidate reference',
    );
    await expect(parseCandidateYaml('a: 1\na: 2')).rejects.toThrow();
    await expect(parseCandidateYaml('a: &a 1\nb: *a')).rejects.toThrow();
    await expect(parseCandidateYaml('a: 1\n---\na: 2')).rejects.toThrow();
  });
  it.each([
    { dependencias: ['INVENTARIO'] },
    { dependencias: ['INVENTARIO'], variantIds: [] },
    { dependencias: ['INVENTARIO'], variantIds: [randomUUID()] },
    { dependencias: ['PRICING'], moneda: 'USD' },
    { dependencias: ['PRICING'], moneda: 'EUR', variantIds: [] },
    {
      dependencias: ['PRICING', 'INVENTARIO'],
      moneda: 'PEN',
      variantIds: [randomUUID()],
    },
  ])(
    'accepts a structurally valid selection matching the DTO %j',
    (selection) => {
      const value = { solicitudId: randomUUID(), ...selection };
      expect(
        candidateValidators(document).component('HistoricalRecoveryRequest')(
          value,
        ),
      ).toBe(true);
      expect(() => parseHistoricalSelection(value)).not.toThrow();
    },
  );
  it.each([
    {},
    { solicitudId: 'invalid', dependencias: ['INVENTARIO'] },
    { dependencias: [] },
    { dependencias: ['INVENTARIO', 'INVENTARIO'] },
    { dependencias: ['OTHER'] },
    { dependencias: ['PRICING'] },
    { dependencias: ['PRICING'], moneda: 'usd' },
    { dependencias: ['PRICING'], moneda: null },
    { dependencias: ['INVENTARIO'], moneda: 'USD' },
    { dependencias: ['INVENTARIO'], precio_regular: 10 },
    { dependencias: ['INVENTARIO'], variantIds: ['bad-id'] },
    { dependencias: ['INVENTARIO'], variantIds: [null] },
    { dependencias: ['INVENTARIO'], variantIds: null },
  ])(
    'rejects invalid HTTP structure in both schema and DTO %j',
    (selection) => {
      const value = { solicitudId: randomUUID(), ...selection };
      // This first case intentionally lacks required dependencies.
      expect(
        candidateValidators(document).component('HistoricalRecoveryRequest')(
          value,
        ),
      ).toBe(false);
      expect(() => parseHistoricalSelection(value)).toThrow();
    },
  );
  it('documents additional ICU and normalized-identity business validation without inventing maxItems', () => {
    const request = candidateValidators(document).component(
      'HistoricalRecoveryRequest',
    );
    const child = 'abcdefab-1234-4234-8234-abcdefabcdef';
    for (const value of [
      { solicitudId: randomUUID(), dependencias: ['PRICING'], moneda: 'ZZZ' },
      {
        solicitudId: randomUUID(),
        dependencias: ['INVENTARIO'],
        variantIds: [child, child.toUpperCase()],
      },
    ]) {
      expect(request(value)).toBe(true);
      expect(() => parseHistoricalSelection(value)).toThrow();
    }
    const many = {
      solicitudId: randomUUID(),
      dependencias: ['INVENTARIO'],
      variantIds: Array.from({ length: 1024 }, () => randomUUID()),
    };
    expect(request(many)).toBe(true);
    expect(parseHistoricalSelection(many).variantIds).toHaveLength(1024);
  });
  it.each([
    [400, 'VALIDACION'],
    [401, 'TOKEN_INVALIDO'],
    [403, 'SCOPE_INSUFICIENTE'],
    [404, 'PRODUCTO_NO_ENCONTRADO'],
    [404, 'VARIANTE_NO_ENCONTRADA'],
    [409, 'IDEMPOTENCY_CONFLICT'],
    [409, 'PREPARACION_NO_REINTENTABLE'],
    [409, 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO'],
    [413, 'VALIDACION'],
    [500, 'ERROR_INTERNO'],
    [503, 'SERVICIO_NO_DISPONIBLE'],
  ] as const)(
    'validates the real Problem renderer for HTTP %s / %s',
    (status, code) => {
      const response = {
        status: vi.fn().mockReturnThis(),
        type: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        getHeader: vi.fn(),
        json: vi.fn(),
      };
      const request = { headers: { 'x-correlation-id': randomUUID() } };
      new ProblemFilter().catch(new HttpException({ code }, status), {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => response,
        }),
      } as ArgumentsHost);
      const value = response.json.mock.calls[0][0] as JsonObject;
      const path =
        '/paths/~1api~1v1~1productos~1{productoId}~1preparacion~1recuperar-historica/post/responses/' +
        status +
        '/content/application~1problem+json/schema';
      expect(candidateValidators(document).at(path)(value)).toBe(true);
      expect(response.status).toHaveBeenCalledWith(status);
      expect(response.type).toHaveBeenCalledWith('application/problem+json');
    },
  );
});
