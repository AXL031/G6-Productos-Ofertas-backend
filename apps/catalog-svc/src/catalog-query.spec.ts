import { parseProductQuery } from './catalog-query.js';

describe('Commercial query contract', () => {
  it('uses contractual defaults and preserves opaque filters', () => {
    expect(
      parseProductQuery({
        canal: 'MARKETPLACE',
        q: 'a',
        categoriaId: 'CAT-01',
      }),
    ).toMatchObject({
      pagina: 1,
      tamanio: 20,
      orden: 'NOMBRE_ASC',
      q: 'a',
      categoriaId: 'CAT-01',
    });
  });
  it.each([
    {},
    { canal: 'unknown' },
    { canal: ['MARKETPLACE'] },
    { pagina: '0' },
    { tamanio: '101' },
    { pagina: '1.5' },
    { tamanio: ['2'] },
    { orden: 'PRECIO_ASC' },
    { precioMin: '-1' },
    { precioMin: '0x10' },
    { precioMin: '0b10' },
    { precioMax: 'NaN' },
    { precioMin: '3', precioMax: '2' },
    { estado: 'ACTIVA' },
    { admin: 'true' },
  ])('rejects malformed parameters %j', (input) => {
    const query = Object.keys(input).length
      ? { canal: 'MARKETPLACE', ...input }
      : {};
    expect(() => parseProductQuery(query)).toThrow();
  });
  it('does not accept list filters on detail', () => {
    expect(() =>
      parseProductQuery({ canal: 'MARKETPLACE', q: 'x' }, true),
    ).toThrow();
  });
  it('keeps the human global context absent and never defaults it to a channel', () => {
    expect(parseProductQuery({}, false, false).canal).toBeUndefined();
    expect(parseProductQuery({}, true, false).canal).toBeUndefined();
    expect(() => parseProductQuery({ canal: '' }, false, false)).toThrow();
    expect(() => parseProductQuery({ canal: 'OTHER' }, true, false)).toThrow();
  });
});
