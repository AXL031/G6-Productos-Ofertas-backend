import {
  crearAsociacionTipoCaracteristica,
  eliminarLogicamente,
  mapearConflictoUnicoTaxonomy,
  normalizarNombreMarca,
  proponerSlugCategoria,
  validarActualizacionCaracteristica,
  validarBajaCategoria,
  validarDefinicionCaracteristica,
  validarJerarquiaCategoria,
  validarNuevaAsociacionTipoCaracteristica,
  validarReactivacionCategoria,
  validarResultadoBajaSegura,
  validarSlugConfirmado,
  validarUnicidadNombreMarca,
  validarValorCaracteristica,
  validarValorCapturado,
  type CategoriaMaestra,
  type CaracteristicaMaestra,
} from './taxonomy-invariants.js';

const raiz: CategoriaMaestra = {
  id: 'root',
  categoriaPadreId: null,
  estado: 'ACTIVO',
};

const caracteristicaLista: CaracteristicaMaestra = {
  id: 'color',
  tipo: 'LISTA',
  unidadMedida: null,
  estado: 'ACTIVO',
};

describe('Taxonomy invariants (#36)', () => {
  describe('jerarquía de categorías', () => {
    it('permite raíz y segundo nivel, y rechaza el tercer nivel', () => {
      expect(() => validarJerarquiaCategoria('root', null, [])).not.toThrow();
      expect(() =>
        validarJerarquiaCategoria('child', 'root', [raiz]),
      ).not.toThrow();

      const child: CategoriaMaestra = {
        id: 'child',
        categoriaPadreId: 'root',
        estado: 'ACTIVO',
      };
      expect(() =>
        validarJerarquiaCategoria('grandchild', 'child', [raiz, child]),
      ).toThrow(
        expect.objectContaining({ code: 'PROFUNDIDAD_CATEGORIA_EXCEDIDA' }),
      );
    });

    it('rechaza autorreferencia, ciclos y padres inexistentes o inactivos', () => {
      expect(() => validarJerarquiaCategoria('root', 'root', [raiz])).toThrow(
        expect.objectContaining({ code: 'CATEGORIA_INVALIDA' }),
      );

      const child = {
        id: 'child',
        categoriaPadreId: 'root',
        estado: 'ACTIVO',
      } as const;
      expect(() =>
        validarJerarquiaCategoria('root', 'child', [raiz, child]),
      ).toThrow(expect.objectContaining({ code: 'CATEGORIA_INVALIDA' }));
      expect(() =>
        validarJerarquiaCategoria('child', 'missing', [raiz]),
      ).toThrow(expect.objectContaining({ code: 'CATEGORIA_NO_ENCONTRADA' }));
      expect(() =>
        validarJerarquiaCategoria('child', 'inactive', [
          { ...raiz, id: 'inactive', estado: 'INACTIVO' },
        ]),
      ).toThrow(expect.objectContaining({ code: 'CATEGORIA_PADRE_INACTIVA' }));
    });

    it('no permite mover una rama si algún descendiente excedería dos niveles', () => {
      const categorias: CategoriaMaestra[] = [
        { ...raiz, id: 'root-a' },
        { ...raiz, id: 'root-b' },
        { id: 'branch', categoriaPadreId: 'root-a', estado: 'ACTIVO' },
      ];
      expect(() =>
        validarJerarquiaCategoria('root-a', 'root-b', categorias),
      ).toThrow(
        expect.objectContaining({ code: 'PROFUNDIDAD_CATEGORIA_EXCEDIDA' }),
      );
    });

    it('rechaza la baja lógica de un padre con hijos activos', () => {
      expect(() =>
        validarBajaCategoria('root', [
          raiz,
          { id: 'child', categoriaPadreId: 'root', estado: 'ACTIVO' },
        ]),
      ).toThrow(
        expect.objectContaining({
          code: 'CATEGORIA_CON_SUBCATEGORIAS_ACTIVAS',
        }),
      );
      expect(() =>
        validarBajaCategoria('root', [
          raiz,
          {
            id: 'child',
            categoriaPadreId: 'root',
            estado: 'PENDING_DEACTIVATION',
          },
        ]),
      ).toThrow(
        expect.objectContaining({
          code: 'CATEGORIA_CON_SUBCATEGORIAS_ACTIVAS',
        }),
      );
      expect(() => validarBajaCategoria('root', [raiz])).not.toThrow();
    });

    it('exige padre activo al reactivar hijos y permite reactivar el padre antes', () => {
      const categorias: CategoriaMaestra[] = [
        { ...raiz, estado: 'INACTIVO' },
        { id: 'child', categoriaPadreId: 'root', estado: 'INACTIVO' },
      ];
      expect(() => validarReactivacionCategoria('child', categorias)).toThrow(
        expect.objectContaining({ code: 'CATEGORIA_PADRE_INACTIVA' }),
      );
      expect(() =>
        validarReactivacionCategoria('root', categorias),
      ).not.toThrow();
    });
  });

  describe('marcas', () => {
    it('normaliza trim, espacios y mayúsculas', () => {
      expect(normalizarNombreMarca('  Acme   Sports ')).toBe('acme sports');
    });

    it('rechaza nombres duplicados incluso si la marca existente está inactiva', () => {
      expect(() =>
        validarUnicidadNombreMarca(' ACME ', [
          { id: 'old', nombre: 'Acme', estado: 'INACTIVO' },
        ]),
      ).toThrow(expect.objectContaining({ code: 'MARCA_DUPLICADA' }));
      expect(() =>
        validarUnicidadNombreMarca(
          'Acme',
          [{ id: 'same', nombre: 'Acme', estado: 'ACTIVO' }],
          'same',
        ),
      ).not.toThrow();
    });
  });

  describe('características y asociaciones', () => {
    it('valida tipos permitidos y unidad requerida solo para NUMERO', () => {
      expect(() =>
        validarDefinicionCaracteristica('NUMERO', 'cm'),
      ).not.toThrow();
      expect(() => validarDefinicionCaracteristica('NUMERO', null)).toThrow(
        expect.objectContaining({ code: 'VALOR_NUMERICO_INVALIDO' }),
      );
      expect(() => validarDefinicionCaracteristica('LISTA', 'cm')).toThrow(
        expect.objectContaining({ code: 'VALIDACION' }),
      );
    });

    it('mantiene inmutable el tipo y valida valores capturados por tipo', () => {
      expect(() =>
        validarActualizacionCaracteristica(caracteristicaLista, 'LISTA', null),
      ).not.toThrow();
      expect(() =>
        validarActualizacionCaracteristica(caracteristicaLista, 'TEXTO', null),
      ).toThrow(
        expect.objectContaining({ code: 'TIPO_CARACTERISTICA_INMUTABLE' }),
      );
      expect(() =>
        validarActualizacionCaracteristica(
          caracteristicaLista,
          undefined,
          'cm',
        ),
      ).toThrow(expect.objectContaining({ code: 'VALIDACION' }));

      expect(() =>
        validarValorCapturado(
          { ...caracteristicaLista, tipo: 'NUMERO', unidadMedida: 'kg' },
          '12.5',
          [],
        ),
      ).not.toThrow();
      expect(() =>
        validarValorCapturado(
          { ...caracteristicaLista, tipo: 'NUMERO', unidadMedida: 'kg' },
          '12kg',
          [],
        ),
      ).toThrow(expect.objectContaining({ code: 'VALOR_NUMERICO_INVALIDO' }));
      expect(() =>
        validarValorCapturado(caracteristicaLista, 'retired-value', [
          {
            id: 'retired-value',
            caracteristicaId: 'color',
            nombre: 'Rojo',
            estado: 'INACTIVO',
          },
        ]),
      ).toThrow(expect.objectContaining({ code: 'VALIDACION' }));
    });

    it('limita valores permitidos a LISTA, evita repetidos y limita activos', () => {
      expect(() =>
        validarValorCaracteristica(caracteristicaLista, 'Rojo', []),
      ).not.toThrow();
      expect(() =>
        validarValorCaracteristica(caracteristicaLista, 'rojo', [
          {
            id: 'red',
            caracteristicaId: 'color',
            nombre: 'Rojo',
            estado: 'INACTIVO',
          },
        ]),
      ).toThrow(expect.objectContaining({ code: 'VALIDACION' }));
      expect(() =>
        validarValorCaracteristica(
          { ...caracteristicaLista, tipo: 'TEXTO' },
          'Rojo',
          [],
        ),
      ).toThrow(expect.objectContaining({ code: 'VALIDACION' }));

      const valores = Array.from({ length: 50 }, (_, indice) => ({
        id: `color-${indice}`,
        caracteristicaId: 'color',
        nombre: `Color ${indice}`,
        estado: 'ACTIVO' as const,
      }));
      expect(() =>
        validarValorCaracteristica(caracteristicaLista, 'Nuevo', valores),
      ).toThrow(
        expect.objectContaining({ code: 'VALOR_LISTA_LIMITE_EXCEDIDO' }),
      );
    });

    it('guarda obligatoria únicamente en la asociación tipo-característica', () => {
      const asociacion = crearAsociacionTipoCaracteristica(
        'shoe',
        'size',
        true,
      );
      expect(asociacion).toEqual({
        tipoProductoId: 'shoe',
        caracteristicaId: 'size',
        obligatoria: true,
        estado: 'ACTIVO',
      });
      expect(asociacion).not.toHaveProperty('required');
    });

    it('solo asocia tipos y características activas, sin duplicados y respetando el límite', () => {
      const tipo = { id: 'shoe', estado: 'ACTIVO' as const };
      expect(() =>
        validarNuevaAsociacionTipoCaracteristica(tipo, caracteristicaLista, []),
      ).not.toThrow();
      expect(() =>
        validarNuevaAsociacionTipoCaracteristica(
          { ...tipo, estado: 'INACTIVO' },
          caracteristicaLista,
          [],
        ),
      ).toThrow(expect.objectContaining({ code: 'TIPO_PRODUCTO_INVALIDO' }));
      expect(() =>
        validarNuevaAsociacionTipoCaracteristica(
          tipo,
          { ...caracteristicaLista, estado: 'INACTIVO' },
          [],
        ),
      ).toThrow(expect.objectContaining({ code: 'VALIDACION' }));

      const asociacion = crearAsociacionTipoCaracteristica(
        'shoe',
        'color',
        false,
      );
      expect(() =>
        validarNuevaAsociacionTipoCaracteristica(tipo, caracteristicaLista, [
          asociacion,
        ]),
      ).toThrow(expect.objectContaining({ code: 'ASOCIACION_DUPLICADA' }));

      const asociaciones = Array.from({ length: 20 }, (_, indice) => ({
        ...crearAsociacionTipoCaracteristica(
          'shoe',
          `attribute-${indice}`,
          false,
        ),
      }));
      expect(() =>
        validarNuevaAsociacionTipoCaracteristica(
          tipo,
          caracteristicaLista,
          asociaciones,
        ),
      ).toThrow(
        expect.objectContaining({ code: 'LIMITE_CARACTERISTICAS_EXCEDIDO' }),
      );
    });
  });

  describe('slugs y transiciones', () => {
    it('propone un sufijo visible y exige confirmar la propuesta', () => {
      const propuesta = proponerSlugCategoria('Fútbol', new Set(['futbol']));
      expect(propuesta).toEqual({ slug: 'futbol-2', colisionResuelta: true });
      expect(() =>
        validarSlugConfirmado(propuesta.slug, new Set(['futbol'])),
      ).not.toThrow();
    });

    it('traduce la carrera de unicidad de slug a conflicto contractual sin generar otro slug', () => {
      const propuesta = proponerSlugCategoria('Fútbol', new Set());
      const slugsOcupadosPorOtraSolicitud = new Set([propuesta.slug]);
      expect(() =>
        validarSlugConfirmado(propuesta.slug, slugsOcupadosPorOtraSolicitud),
      ).toThrow(expect.objectContaining({ code: 'SLUG_DUPLICADO' }));

      expect(
        mapearConflictoUnicoTaxonomy({
          code: '23505',
          constraint: 'uq_category_seo_slug',
        }),
      ).toMatchObject({ code: 'SLUG_DUPLICADO' });
      expect(
        mapearConflictoUnicoTaxonomy({
          code: '23505',
          constraint: 'uq_brands_nombre_normalizado',
        }),
      ).toMatchObject({ code: 'MARCA_DUPLICADA' });
      expect(
        mapearConflictoUnicoTaxonomy({ code: '23505', constraint: 'other' }),
      ).toBe(undefined);
    });

    it('falla cerrado en la baja asíncrona y elimina entidades solo lógicamente', () => {
      expect(validarResultadoBajaSegura('PENDING_DEACTIVATION', 'CLEAR')).toBe(
        'INACTIVO',
      );
      expect(
        validarResultadoBajaSegura(
          'PENDING_DEACTIVATION',
          'HAS_ACTIVE_PRODUCTS',
        ),
      ).toBe('ACTIVO');
      expect(
        validarResultadoBajaSegura('PENDING_DEACTIVATION', 'TIMEOUT'),
      ).toBe('ACTIVO');
      expect(validarResultadoBajaSegura('PENDING_DEACTIVATION', 'ERROR')).toBe(
        'ACTIVO',
      );
      expect(eliminarLogicamente('ACTIVO')).toBe('INACTIVO');
      expect(() => eliminarLogicamente('INACTIVO')).toThrow(
        expect.objectContaining({ code: 'VERSION_CONFLICT' }),
      );
    });
  });
});
