import { parseMutation } from './catalog-mutation.input.js';

describe('Contractual catalog mutation validation', () => {
  const product = {
    nombre: 'Fixture',
    descripcion: 'Description',
    categoriaId: 'cat',
    tipoProductoId: 'type',
    marcaId: 'brand',
    skuBase: '0000123',
    tieneVariantes: false,
    precioBaseInicial: 25,
  };
  it('preserves opaque SKU and nested kg/cm draft values', () => {
    expect(
      parseMutation(
        {
          ...product,
          perfilFisico: {
            pesoKg: 1.25,
            dimensionesCm: { largo: null, ancho: 10 },
          },
        },
        'createProduct',
      ),
    ).toMatchObject({
      skuBase: '0000123',
      perfilFisico: { pesoKg: 1.25, dimensionesCm: { ancho: 10 } },
    });
  });
  it.each([0, -1, NaN, Infinity])(
    'rejects invalid informed measurements %s',
    (value) => {
      expect(() =>
        parseMutation(
          { ...product, perfilFisico: { pesoKg: value } },
          'createProduct',
        ),
      ).toThrowError(
        expect.objectContaining({
          response: { code: 'PERFIL_FISICO_INVALIDO' },
          status: 422,
        }),
      );
    },
  );
  it.each(['skuBase', 'tieneVariantes', 'slug'])(
    'blocks structural product edits through additionalProperties: %s',
    (field) => {
      expect(() =>
        parseMutation({ [field]: 'spoof' }, 'updateProduct'),
      ).toThrowError(
        expect.objectContaining({
          status: 409,
          response: { code: 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO' },
        }),
      );
    },
  );
  it.each(['sku', 'variant_id', 'product_id', 'atributosIdentificadores'])(
    'blocks structural variant edits: %s',
    (field) => {
      expect(() =>
        parseMutation({ [field]: 'spoof' }, 'updateVariant'),
      ).toThrowError(expect.objectContaining({ status: 409 }));
    },
  );
  it('validates variant identification without concatenating values or generating SKU', () => {
    const value = {
      sku: '0000123',
      atributosIdentificadores: [
        {
          caracteristica_id: 'size',
          nombre: 'Size',
          valor_id: 'M',
          valor: 'M',
        },
      ],
      imagenUrl: 'https://example.test/image',
    };
    expect(parseMutation(value, 'createVariant')).toMatchObject({
      sku: '0000123',
      atributosIdentificadores: value.atributosIdentificadores,
    });
    expect(() =>
      parseMutation(
        { ...value, atributosIdentificadores: [] },
        'createVariant',
      ),
    ).toThrowError(
      expect.objectContaining({
        response: { code: 'ATRIBUTO_IDENTIFICADOR_INVALIDO' },
      }),
    );
  });
  it.each([undefined, null, '', 123, [], {}])(
    'requires an explicit variant SKU: %j',
    (sku) => {
      expect(() => parseMutation({ sku }, 'createVariant')).toThrowError(
        expect.objectContaining({
          status: 422,
          response: { code: 'SKU_INVALIDO' },
        }),
      );
    },
  );
  it('accepts a type correction syntactically and rejects empty/null types', () => {
    expect(
      parseMutation(
        { tipoProductoId: 'new-type', catalogVersion: 3 },
        'updateProduct',
      ),
    ).toEqual({ tipoProductoId: 'new-type', catalogVersion: 3 });
    for (const tipoProductoId of ['', null, 123])
      expect(() =>
        parseMutation({ tipoProductoId }, 'updateProduct'),
      ).toThrowError(
        expect.objectContaining({
          status: 400,
          response: { code: 'VALIDACION' },
        }),
      );
  });
  it.each([
    { catalogVersion: -1 },
    { catalogVersion: 1.5 },
    { catalogVersion: NaN },
    { catalogVersion: null },
    { imagenes: [{ url: 'not uri' }] },
  ])('rejects malformed product updates %j', (body) => {
    expect(() => parseMutation(body, 'updateProduct')).toThrow();
  });
  it('validates retry dependency and optional motive without accepting variant Pricing', () => {
    expect(
      parseMutation({ dependencia: 'INVENTARIO' }, 'retryProduct'),
    ).toEqual({ dependencia: 'INVENTARIO' });
    expect(() =>
      parseMutation({ dependencia: 'OTHER' }, 'retryProduct'),
    ).toThrow();
    expect(() => parseMutation({ motivo: null }, 'retryVariant')).toThrow();
  });
});
