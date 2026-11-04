import { describe, expect, it } from 'vitest';
import { parseFilters } from './audit-query.js';
describe('Filtros contractuales de auditoría', () => {
  it('conserva filtros y paginación explícitos', () => {
    expect(
      parseFilters({
        sku: 'SKU',
        desde: '2026-01-01T00:00:00Z',
        hasta: '2026-01-31T23:59:59Z',
        pagina: '2',
        tamanio: '10',
      }),
    ).toMatchObject({ page: 2, size: 10, filters: { sku: 'SKU' } });
  });
  it.each([
    { pagina: '0' },
    { tamanio: '201' },
    { pagina: ['1', '2'] },
    { sku: ['a', 'b'] },
    { batchId: 'invalid' },
    { desde: '2026-02-30T00:00:00Z' },
    { desde: '2026-01-02T00:00:00Z', hasta: '2026-01-01T00:00:00Z' },
    { unknown: 'query' },
    { desde: '2026-01-01' },
  ])('rechaza consultas inválidas antes de SQL: %j', (query) =>
    expect(() => parseFilters(query)).toThrow(),
  );
});
