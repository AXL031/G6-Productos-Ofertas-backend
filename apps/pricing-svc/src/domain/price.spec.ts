import {
  cents,
  changePrice,
  initializeProduct,
  insertValidity,
  nextVersion,
  PriceRuleError,
  replayInitialization,
  schedulePrice,
  scheduledStatus,
  updateTerms,
  validateInterval,
  validateTarget,
  validateTerms,
  type Initialization,
  type PriceDefinition,
  type PriceUpdate,
  type PriceValidity,
} from './price.js';

const at = (day: number) => new Date(Date.UTC(2030, 0, day));
const initial: Initialization = {
  productId: 'product',
  skuBase: '000123',
  precioRegular: '100.00',
  currency: 'PEN',
  channelId: null,
  motivoCambio: 'ALTA_PRODUCTO',
};
const snapshot = (overrides: Partial<PriceValidity> = {}): PriceValidity => ({
  precioRegular: '100.00',
  precioOferta: '80.00',
  currency: 'PEN',
  motivoCambio: 'fixture',
  usuarioId: 'actor',
  validFrom: at(1),
  validUntil: null,
  priceVersion: 1n,
  isCancelled: false,
  ...overrides,
});
const definition = (
  overrides: Partial<PriceDefinition> = {},
): PriceDefinition => ({
  target: { productId: 'product', sku: null },
  channelId: null,
  priceVersion: 1n,
  validities: [snapshot()],
  ...overrides,
});
const update: PriceUpdate = {
  accionPrecioOferta: 'CONSERVAR',
  currency: 'PEN',
  motivoCambio: 'actualización',
  usuarioId: 'actor-2',
};
const schedule = {
  tipoPrecio: 'OFERTA' as const,
  importe: '70.00',
  currency: 'PEN',
  motivoCambio: 'programación',
  usuarioId: 'actor',
  validFrom: at(3),
  validUntil: at(4),
};

describe('SPEC/HU-013: importes y contexto', () => {
  it.each(['0.01', '1', '1.2', '9999999999.99'])(
    'acepta importe %s sin floats',
    (value) => {
      expect(cents(value)).toBeGreaterThan(0n);
    },
  );
  it('representa exactamente el máximo numeric(12,2)', () => {
    expect(cents('9999999999.99')).toBe(999999999999n);
  });
  it.each([
    '0',
    '-1',
    '0.001',
    '10000000000',
    '1e2',
    'NaN',
    'Infinity',
    '',
    ' 1',
    '1.',
  ])('rechaza %s sin redondeo', (value) => {
    expect(() => cents(value)).toThrow('PRECIO_INVALIDO');
  });
  it.each(['0', '100.00', '100.01', '-1', '0.001'])(
    'rechaza oferta %s',
    (precioOferta) => {
      expect(() => validateTerms(snapshot({ precioOferta }))).toThrow(
        'OFERTA_INVALIDA',
      );
    },
  );
  it.each([null, '0.01', '99.99'])('acepta oferta %s', (precioOferta) => {
    expect(() => validateTerms(snapshot({ precioOferta }))).not.toThrow();
  });
  it('exige moneda y motivo sin restringir un catálogo de monedas no publicado', () => {
    expect(() => validateTerms(snapshot({ currency: 'USD' }))).not.toThrow();
    for (const currency of ['', 'PE', ' PEN ', '   ']) {
      expect(() => validateTerms(snapshot({ currency }))).toThrow('VALIDACION');
    }
    expect(() => validateTerms(snapshot({ motivoCambio: '  ' }))).toThrow(
      'MOTIVO_CAMBIO_REQUERIDO',
    );
  });
  it('conserva identidad opaca y exige exactamente un objetivo', () => {
    expect(() =>
      validateTarget({ productId: null, sku: '000123' }),
    ).not.toThrow();
    expect(() =>
      validateTarget({ productId: 'product', sku: null }),
    ).not.toThrow();
    expect(() => validateTarget({ productId: null, sku: '' })).toThrow(
      'SCOPE_PRECIO_INVALIDO',
    );
  });
});

describe('SPEC §3 / HU CA-02–04: inicialización del producto', () => {
  it('crea versión 1, precio anterior/variación nulos y ningún override de sku_base', () => {
    const result = initializeProduct(initial, at(1));
    expect(result).toMatchObject({
      tipoOperacion: 'CREACION',
      precioAnterior: null,
      variacionPorcentual: null,
    });
    expect(result.definition).toMatchObject({
      target: { productId: 'product', sku: null },
      channelId: null,
      priceVersion: 1n,
    });
    expect(result.definition.validities[0]).toMatchObject({
      precioOferta: null,
      motivoCambio: 'ALTA_PRODUCTO',
      priceVersion: 1n,
    });
    expect(initial.skuBase).toBe('000123');
  });
  it('rechaza precio, producto, SKU y fecha inválidos sin efectos', () => {
    expect(() =>
      initializeProduct({ ...initial, precioRegular: '0' }, at(1)),
    ).toThrow('PRECIO_INVALIDO');
    expect(() =>
      initializeProduct({ ...initial, productId: '' }, at(1)),
    ).toThrow('SCOPE_PRECIO_INVALIDO');
    expect(() => initializeProduct({ ...initial, skuBase: '' }, at(1))).toThrow(
      'SCOPE_PRECIO_INVALIDO',
    );
    expect(() => initializeProduct(initial, new Date(NaN))).toThrow(
      'VALIDACION',
    );
  });
  it('DEC-F-009: replay semántico devuelve exactamente la aceptación previa', () => {
    const result = initializeProduct(initial, at(1));
    expect(
      replayInitialization(
        { ...initial, precioRegular: '100' },
        { input: initial, result },
      ),
    ).toBe(result);
    // La aceptación original sigue vigente aunque haya cambios de precio posteriores.
    expect(result.definition.priceVersion).toBe(1n);
  });
  it.each([
    { precioRegular: '101' },
    { productId: 'other' },
    { skuBase: '123' },
    { currency: 'USD' },
  ])(
    'reutilizar operación con otro contenido produce conflicto: %j',
    (change) => {
      expect(() =>
        replayInitialization(
          { ...initial, ...change },
          { input: initial, result: 'READY' },
        ),
      ).toThrow('IDEMPOTENCY_CONFLICT');
    },
  );
});

describe('SPEC §5 / FLOW §4.3: edición y versión', () => {
  it('edita una vigencia finita conservando la siguiente programación y el fin original', () => {
    const future = snapshot({ validFrom: at(5), priceVersion: 2n });
    const before = definition({
      priceVersion: 2n,
      validities: [snapshot({ validUntil: at(5) }), future],
    });
    const result = changePrice(before, update, 2n, at(2)).definition;
    expect(result.validities[0].validUntil).toEqual(at(2));
    expect(result.validities[1]).toBe(future);
    expect(result.validities[2]).toMatchObject({
      validFrom: at(2),
      validUntil: at(5),
      priceVersion: 3n,
    });
    expect(() => changePrice(before, update, 2n, new Date(NaN))).toThrow(
      'VALIDACION',
    );
    expect(() => changePrice(definition(), update, 1n, at(1))).toThrow(
      'VIGENCIA_SUPERPUESTA',
    );
  });
  it('conserva oferta, cierra historia y avanza exactamente una versión con actor/motivo', () => {
    const before = definition();
    const result = changePrice(
      before,
      { ...update, precioRegular: '110' },
      1n,
      at(2),
    );
    expect(result.definition.priceVersion).toBe(2n);
    expect(result.definition.validities[0].validUntil).toEqual(at(2));
    expect(result.definition.validities[1]).toMatchObject({
      precioRegular: '110',
      precioOferta: '80.00',
      priceVersion: 2n,
      usuarioId: 'actor-2',
      motivoCambio: 'actualización',
    });
    expect(before.validities[0].validUntil).toBeNull();
    expect(before.priceVersion).toBe(1n);
  });
  it('rechaza versión obsoleta y replay del PATCH, sin tratar CAS como idempotencia de negocio', () => {
    const after = changePrice(definition(), update, 1n, at(2)).definition;
    expect(() => changePrice(after, update, 1n, at(3))).toThrow(
      'VERSION_CONFLICT',
    );
    expect(() => nextVersion(1n, 0n)).toThrow('VERSION_CONFLICT');
  });
  it('no pierde precisión bigint ni desborda PostgreSQL', () => {
    expect(nextVersion(9007199254740993n)).toBe(9007199254740994n);
    expect(nextVersion(9223372036854775806n)).toBe(9223372036854775807n);
    expect(() => nextVersion(9223372036854775807n)).toThrow('VERSION_CONFLICT');
    expect(() => nextVersion(0n)).toThrow('VERSION_CONFLICT');
  });
  it('establece y retira oferta, con clasificación RETIRO_OFERTA', () => {
    expect(
      updateTerms(snapshot(), {
        ...update,
        accionPrecioOferta: 'ESTABLECER',
        precioOferta: '79.99',
      }).terms.precioOferta,
    ).toBe('79.99');
    expect(
      updateTerms(snapshot(), { ...update, accionPrecioOferta: 'ELIMINAR' }),
    ).toMatchObject({
      terms: { precioOferta: null },
      tipoOperacion: 'RETIRO_OFERTA',
    });
    expect(
      updateTerms(snapshot({ precioOferta: null }), {
        ...update,
        accionPrecioOferta: 'ELIMINAR',
      }).tipoOperacion,
    ).toBe('MODIFICACION');
  });
  it('rechaza establecer sin importe y reducción regular incompatible con oferta conservada', () => {
    expect(() =>
      updateTerms(snapshot(), { ...update, accionPrecioOferta: 'ESTABLECER' }),
    ).toThrow('ACCION_OFERTA_INVALIDA');
    expect(() =>
      updateTerms(snapshot(), { ...update, precioRegular: '80' }),
    ).toThrow('OFERTA_INVALIDA');
    expect(() =>
      changePrice(definition({ validities: [] }), update, 1n, at(2)),
    ).toThrow('PRECIO_NO_ENCONTRADO');
  });
});

describe('HU CA-09: intervalos [inicio, fin), programación y estados', () => {
  it('admite adyacencia y conserva precio actual hasta el inicio futuro', () => {
    const result = schedulePrice(definition(), schedule, at(2));
    expect(result.priceVersion).toBe(2n);
    expect(result.validities[0]).toMatchObject({
      precioOferta: '80.00',
      validUntil: at(3),
    });
    expect(result.validities[1]).toMatchObject({
      precioOferta: '70.00',
      validFrom: at(3),
      validUntil: at(4),
      priceVersion: 2n,
    });
    expect(() =>
      insertValidity(
        [snapshot({ validUntil: at(3) })],
        snapshot({ validFrom: at(3), priceVersion: 2n }),
      ),
    ).not.toThrow();
  });
  it('programa regular y conserva oferta válida', () => {
    expect(
      schedulePrice(
        definition(),
        { ...schedule, tipoPrecio: 'REGULAR', importe: '120' },
        at(2),
      ).validities[1],
    ).toMatchObject({ precioRegular: '120', precioOferta: '80.00' });
  });
  it.each([at(1), at(2)])(
    'rechaza comienzo pasado o exactamente ahora: %s',
    (validFrom) => {
      expect(() =>
        schedulePrice(definition(), { ...schedule, validFrom }, at(2)),
      ).toThrow('VALIDACION');
    },
  );
  it('rechaza intervalo vacío/invertido/NaN', () => {
    for (const until of [at(1), at(2), new Date(NaN)]) {
      expect(() => validateInterval(at(2), until)).toThrow('VALIDACION');
    }
  });
  it('rechaza solapamiento idéntico, contenido o contra futuro; nunca recorta una vigencia finita', () => {
    const finite = snapshot({ validUntil: at(5) });
    for (const incoming of [
      snapshot(),
      snapshot({ validFrom: at(2), validUntil: at(3) }),
      snapshot({ validFrom: at(4) }),
    ]) {
      expect(() => insertValidity([finite], incoming)).toThrow(
        'VIGENCIA_SUPERPUESTA',
      );
    }
    const future = snapshot({ validFrom: at(5), priceVersion: 2n });
    expect(() =>
      schedulePrice(
        definition({
          validities: [snapshot({ validUntil: at(5) }), future],
          priceVersion: 2n,
        }),
        { ...schedule, validUntil: at(6) },
        at(2),
      ),
    ).toThrow('VIGENCIA_SUPERPUESTA');
  });
  it('ignora canceladas en exclusión y rechaza oferta inválida antes de crear el plan', () => {
    expect(
      insertValidity([snapshot()], snapshot({ isCancelled: true }))[0]
        .validUntil,
    ).toBeNull();
    expect(() => insertValidity([], snapshot({ priceVersion: 0n }))).toThrow(
      'VERSION_CONFLICT',
    );
    expect(
      insertValidity([snapshot({ isCancelled: true })], snapshot()),
    ).toHaveLength(2);
    expect(() =>
      schedulePrice(definition(), { ...schedule, importe: '100' }, at(2)),
    ).toThrow('OFERTA_INVALIDA');
    expect(() =>
      schedulePrice(definition({ validities: [] }), schedule, at(2)),
    ).toThrow('PRECIO_NO_ENCONTRADO');
  });
  it('transiciona con límites exactos e idempotencia; estados terminales no reviven', () => {
    const validity = snapshot({ validFrom: at(3), validUntil: at(4) });
    expect(scheduledStatus('SCHEDULED', validity, at(2))).toBe('SCHEDULED');
    expect(scheduledStatus('SCHEDULED', validity, at(3))).toBe('ACTIVE');
    expect(scheduledStatus('ACTIVE', validity, at(3))).toBe('ACTIVE');
    expect(scheduledStatus('SCHEDULED', validity, at(4))).toBe('HISTORICAL');
    expect(scheduledStatus('HISTORICAL', validity, at(2))).toBe('HISTORICAL');
    expect(scheduledStatus('CANCELLED', validity, at(3))).toBe('CANCELLED');
    expect(
      scheduledStatus('SCHEDULED', { ...validity, isCancelled: true }, at(3)),
    ).toBe('CANCELLED');
    expect(scheduledStatus('ACTIVE', snapshot(), at(50))).toBe('ACTIVE');
  });
  it('revierte ACTIVE a SCHEDULED cuando la fecha aún precede validFrom', () => {
    const validity = snapshot({ validFrom: at(3), validUntil: at(4) });
    expect(scheduledStatus('ACTIVE', validity, at(2))).toBe('SCHEDULED');
  });
  it('los errores no adjuntan importes ni contexto sensible', () => {
    try {
      cents('secret-fixture');
    } catch (error) {
      expect(error).toBeInstanceOf(PriceRuleError);
      expect(String(error)).not.toContain('secret-fixture');
    }
  });
});
