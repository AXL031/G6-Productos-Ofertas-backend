export type EstadoMaestro = 'ACTIVO' | 'INACTIVO' | 'PENDING_DEACTIVATION';
export type TipoCaracteristica = 'TEXTO' | 'NUMERO' | 'LISTA';

export interface CategoriaMaestra {
  id: string;
  categoriaPadreId: string | null;
  estado: EstadoMaestro;
}

export interface CaracteristicaMaestra {
  id: string;
  tipo: TipoCaracteristica;
  unidadMedida: string | null;
  estado: EstadoMaestro;
}

export interface ValorPermitido {
  id: string;
  caracteristicaId: string;
  nombre: string;
  estado: EstadoMaestro;
}

export interface AsociacionTipoCaracteristica {
  tipoProductoId: string;
  caracteristicaId: string;
  obligatoria: boolean;
  estado: EstadoMaestro;
}

export interface TipoProductoMaestro {
  id: string;
  estado: EstadoMaestro;
}

export class TaxonomyInvariantError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaxonomyInvariantError';
  }
}

function conflicto(code: string, message: string): never {
  throw new TaxonomyInvariantError(code, message);
}

export function validarJerarquiaCategoria(
  categoriaId: string,
  categoriaPadreId: string | null,
  categorias: readonly CategoriaMaestra[],
  maxDepth = 2,
): void {
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new RangeError('maxDepth debe ser un entero positivo.');
  }
  if (categoriaPadreId === categoriaId) {
    conflicto(
      'CATEGORIA_INVALIDA',
      'Una categoría no puede ser su propio padre.',
    );
  }

  const porId = new Map(
    categorias.map((categoria) => [categoria.id, categoria]),
  );
  const padre = categoriaPadreId ? porId.get(categoriaPadreId) : undefined;
  if (categoriaPadreId && !padre) {
    conflicto('CATEGORIA_NO_ENCONTRADA', 'La categoría padre no existe.');
  }
  if (padre && padre.estado !== 'ACTIVO') {
    conflicto(
      'CATEGORIA_PADRE_INACTIVA',
      'La categoría padre debe estar activa.',
    );
  }

  porId.set(categoriaId, {
    id: categoriaId,
    categoriaPadreId,
    estado: 'ACTIVO',
  });

  const profundidades = new Map<string, number>();
  const profundidadDe = (id: string, camino: Set<string>): number => {
    const memoizada = profundidades.get(id);
    if (memoizada !== undefined) return memoizada;
    if (camino.has(id)) {
      conflicto('CATEGORIA_INVALIDA', 'La jerarquía no puede contener ciclos.');
    }
    const actual = porId.get(id);
    if (!actual) {
      conflicto(
        'CATEGORIA_INVALIDA',
        'La jerarquía referencia una categoría padre inexistente.',
      );
    }
    const siguienteCamino = new Set(camino).add(id);
    const profundidad = actual.categoriaPadreId
      ? profundidadDe(actual.categoriaPadreId, siguienteCamino) + 1
      : 1;
    profundidades.set(id, profundidad);
    return profundidad;
  };

  for (const id of porId.keys()) {
    if (profundidadDe(id, new Set()) > maxDepth) {
      conflicto(
        'PROFUNDIDAD_CATEGORIA_EXCEDIDA',
        `La profundidad máxima permitida es ${maxDepth}.`,
      );
    }
  }
}

export function validarBajaCategoria(
  categoriaId: string,
  categorias: readonly CategoriaMaestra[],
): void {
  const categoria = categorias.find((item) => item.id === categoriaId);
  if (!categoria) {
    conflicto('CATEGORIA_NO_ENCONTRADA', 'La categoría no existe.');
  }
  const tieneHijosActivos = categorias.some(
    (item) =>
      item.categoriaPadreId === categoriaId && item.estado !== 'INACTIVO',
  );
  if (tieneHijosActivos) {
    conflicto(
      'CATEGORIA_CON_SUBCATEGORIAS_ACTIVAS',
      'No se puede desactivar una categoría con subcategorías activas.',
    );
  }
  if (categoria.estado !== 'ACTIVO') {
    conflicto('VERSION_CONFLICT', 'La categoría no está activa.');
  }
}

export function validarReactivacionCategoria(
  categoriaId: string,
  categorias: readonly CategoriaMaestra[],
  maxDepth = 2,
): void {
  const categoria = categorias.find((item) => item.id === categoriaId);
  if (!categoria) {
    conflicto('CATEGORIA_NO_ENCONTRADA', 'La categoría no existe.');
  }
  if (categoria.estado !== 'INACTIVO') {
    conflicto('VERSION_CONFLICT', 'La categoría no está inactiva.');
  }
  validarJerarquiaCategoria(
    categoria.id,
    categoria.categoriaPadreId,
    categorias.map((item) =>
      item.id === categoriaId ? { ...item, estado: 'ACTIVO' as const } : item,
    ),
    maxDepth,
  );
}

export function normalizarNombreMarca(nombre: string): string {
  return nombre.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('es');
}

export function validarUnicidadNombreMarca(
  nombre: string,
  marcas: readonly { id: string; nombre: string; estado: EstadoMaestro }[],
  excluirId?: string,
): void {
  const normalizado = normalizarNombreMarca(nombre);
  if (!normalizado) {
    conflicto('VALIDACION', 'El nombre de la marca no puede estar vacío.');
  }
  if (
    marcas.some(
      (marca) =>
        marca.id !== excluirId &&
        normalizarNombreMarca(marca.nombre) === normalizado,
    )
  ) {
    conflicto('MARCA_DUPLICADA', 'Ya existe una marca con ese nombre.');
  }
}

export function validarActualizacionCaracteristica(
  actual: CaracteristicaMaestra,
  tipoSolicitado: TipoCaracteristica | undefined,
  unidadMedida: string | null | undefined,
): void {
  if (tipoSolicitado !== undefined && tipoSolicitado !== actual.tipo) {
    conflicto(
      'TIPO_CARACTERISTICA_INMUTABLE',
      'El tipo de una característica es inmutable.',
    );
  }
  const unidad =
    unidadMedida === undefined ? actual.unidadMedida : unidadMedida;
  if (actual.tipo === 'NUMERO' && !unidad?.trim()) {
    conflicto(
      'VALOR_NUMERICO_INVALIDO',
      'Una característica NUMERO requiere unidad de medida.',
    );
  }
  if (actual.tipo !== 'NUMERO' && unidad !== null) {
    conflicto(
      'VALIDACION',
      'Solo una característica NUMERO puede declarar unidad de medida.',
    );
  }
}

export function validarValorCaracteristica(
  caracteristica: CaracteristicaMaestra,
  nombre: string,
  valores: readonly ValorPermitido[],
  maxValoresLista = 50,
): void {
  const valor = nombre.trim();
  if (!valor) {
    conflicto('VALIDACION', 'El valor no puede estar vacío.');
  }
  if (caracteristica.tipo !== 'LISTA') {
    conflicto(
      'VALIDACION',
      'Solo las características LISTA admiten valores permitidos.',
    );
  }
  const activos = valores.filter(
    (item) =>
      item.caracteristicaId === caracteristica.id && item.estado === 'ACTIVO',
  );
  if (
    valores.some(
      (item) =>
        item.caracteristicaId === caracteristica.id &&
        item.nombre.trim().toLocaleLowerCase('es') ===
          valor.toLocaleLowerCase('es'),
    )
  ) {
    conflicto('VALIDACION', 'El valor permitido ya existe.');
  }
  if (activos.length >= maxValoresLista) {
    conflicto(
      'VALOR_LISTA_LIMITE_EXCEDIDO',
      `La lista admite como máximo ${maxValoresLista} valores activos.`,
    );
  }
}

export function validarDefinicionCaracteristica(
  tipo: TipoCaracteristica,
  unidadMedida: string | null,
): void {
  if (!['TEXTO', 'NUMERO', 'LISTA'].includes(tipo)) {
    conflicto('VALIDACION', 'El tipo de característica no está permitido.');
  }
  if (tipo === 'NUMERO' && !unidadMedida?.trim()) {
    conflicto(
      'VALOR_NUMERICO_INVALIDO',
      'Una característica NUMERO requiere unidad de medida.',
    );
  }
  if (tipo !== 'NUMERO' && unidadMedida !== null) {
    conflicto(
      'VALIDACION',
      'Solo una característica NUMERO puede declarar unidad de medida.',
    );
  }
}

export function validarValorCapturado(
  caracteristica: CaracteristicaMaestra,
  valor: string,
  valoresPermitidos: readonly ValorPermitido[],
  maxTexto = 100,
): void {
  if (caracteristica.tipo === 'TEXTO' && [...valor].length > maxTexto) {
    conflicto(
      'VALIDACION',
      `El texto excede el máximo de ${maxTexto} caracteres.`,
    );
  }
  if (
    caracteristica.tipo === 'NUMERO' &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(valor.trim())
  ) {
    conflicto(
      'VALOR_NUMERICO_INVALIDO',
      'El valor debe tener formato numérico.',
    );
  }
  if (
    caracteristica.tipo === 'LISTA' &&
    !valoresPermitidos.some(
      (item) => item.estado === 'ACTIVO' && item.id === valor,
    )
  ) {
    conflicto('VALIDACION', 'El valor debe corresponder a una opción activa.');
  }
}

export function crearAsociacionTipoCaracteristica(
  tipoProductoId: string,
  caracteristicaId: string,
  obligatoria: boolean,
): AsociacionTipoCaracteristica {
  if (typeof obligatoria !== 'boolean') {
    conflicto(
      'VALIDACION',
      'La obligatoriedad solo se define en la asociación tipo-característica.',
    );
  }
  return {
    tipoProductoId,
    caracteristicaId,
    obligatoria,
    estado: 'ACTIVO',
  };
}

export function validarNuevaAsociacionTipoCaracteristica(
  tipoProducto: TipoProductoMaestro,
  caracteristica: CaracteristicaMaestra,
  asociaciones: readonly AsociacionTipoCaracteristica[],
  maxCaracteristicas = 20,
): void {
  if (tipoProducto.estado !== 'ACTIVO') {
    conflicto(
      'TIPO_PRODUCTO_INVALIDO',
      'El tipo de producto debe estar activo.',
    );
  }
  if (caracteristica.estado !== 'ACTIVO') {
    conflicto('VALIDACION', 'La característica debe estar activa.');
  }
  const activas = asociaciones.filter(
    (asociacion) =>
      asociacion.tipoProductoId === tipoProducto.id &&
      asociacion.estado === 'ACTIVO',
  );
  if (
    asociaciones.some(
      (asociacion) => asociacion.caracteristicaId === caracteristica.id,
    )
  ) {
    conflicto(
      'ASOCIACION_DUPLICADA',
      'La característica ya está asociada al tipo.',
    );
  }
  if (activas.length >= maxCaracteristicas) {
    conflicto(
      'LIMITE_CARACTERISTICAS_EXCEDIDO',
      `El tipo admite como máximo ${maxCaracteristicas} características activas.`,
    );
  }
}

export function validarResultadoBajaSegura(
  estadoActual: EstadoMaestro,
  resultado: 'CLEAR' | 'HAS_ACTIVE_PRODUCTS' | 'TIMEOUT' | 'ERROR',
): EstadoMaestro {
  if (estadoActual !== 'PENDING_DEACTIVATION') {
    conflicto(
      'VERSION_CONFLICT',
      'Solo una baja pendiente puede recibir el resultado de verificación.',
    );
  }
  if (resultado === 'CLEAR') return 'INACTIVO';
  if (resultado === 'TIMEOUT' || resultado === 'ERROR') return 'ACTIVO';
  if (resultado === 'HAS_ACTIVE_PRODUCTS') return 'ACTIVO';
  return 'ACTIVO';
}

export function normalizarSlug(nombre: string): string {
  return nombre
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en')
    .trim()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
}

export function proponerSlugCategoria(
  nombre: string,
  slugsOcupados: ReadonlySet<string>,
): { slug: string; colisionResuelta: boolean } {
  const base = normalizarSlug(nombre);
  if (!base) conflicto('VALIDACION', 'El nombre no produce un slug válido.');
  if (!slugsOcupados.has(base)) return { slug: base, colisionResuelta: false };
  let sufijo = 2;
  while (slugsOcupados.has(`${base}-${sufijo}`)) sufijo += 1;
  return { slug: `${base}-${sufijo}`, colisionResuelta: true };
}

export function validarSlugConfirmado(
  slugConfirmado: string,
  slugsOcupados: ReadonlySet<string>,
): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slugConfirmado)) {
    conflicto('VALIDACION', 'El slug confirmado tiene un formato inválido.');
  }
  if (slugsOcupados.has(slugConfirmado)) {
    conflicto('SLUG_DUPLICADO', 'El slug confirmado dejó de estar disponible.');
  }
}

export function eliminarLogicamente(estado: EstadoMaestro): EstadoMaestro {
  if (estado !== 'ACTIVO') {
    conflicto(
      'VERSION_CONFLICT',
      'Solo una entidad activa puede darse de baja.',
    );
  }
  return 'INACTIVO';
}

export function mapearConflictoUnicoTaxonomy(
  error: unknown,
): TaxonomyInvariantError | undefined {
  const uniqueViolation = buscarViolacionUnica(error);
  if (!uniqueViolation) return undefined;
  if (uniqueViolation.constraint === 'uq_category_seo_slug') {
    return new TaxonomyInvariantError(
      'SLUG_DUPLICADO',
      'El slug confirmado dejó de estar disponible.',
    );
  }
  if (uniqueViolation.constraint === 'uq_brands_nombre_normalizado') {
    return new TaxonomyInvariantError(
      'MARCA_DUPLICADA',
      'Ya existe una marca con ese nombre.',
    );
  }
  return undefined;
}

function buscarViolacionUnica(
  error: unknown,
  profundidad = 0,
): { constraint: string } | undefined {
  if (typeof error !== 'object' || error === null || profundidad > 3) {
    return undefined;
  }
  const dato = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (dato.code === '23505' && typeof dato.constraint === 'string') {
    return { constraint: dato.constraint };
  }
  if (dato.cause) {
    const causa = buscarViolacionUnica(dato.cause, profundidad + 1);
    if (causa) return causa;
  }
  if (Array.isArray(dato.errors)) {
    for (const nested of dato.errors) {
      const causa = buscarViolacionUnica(nested, profundidad + 1);
      if (causa) return causa;
    }
  }
  return undefined;
}
