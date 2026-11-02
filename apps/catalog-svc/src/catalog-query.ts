import { BadRequestException } from '@nestjs/common';
import type { Canal, ProductQuery } from './commercial.types.js';
import { compareDecimal } from './decimal.js';

export function parseProductQuery(
  input: Record<string, unknown>,
  detail = false,
  requireChannel = true,
): ProductQuery {
  const keys = detail
    ? ['canal']
    : [
        'canal',
        'q',
        'categoriaId',
        'marcaId',
        'pagina',
        'tamanio',
        'estado',
        'precioMin',
        'precioMax',
        'orden',
      ];
  for (const [key, value] of Object.entries(input)) {
    if (!keys.includes(key) || typeof value !== 'string')
      throw new BadRequestException();
  }
  const canal = input.canal;
  if (
    (canal === undefined && requireChannel) ||
    (canal !== undefined &&
      (typeof canal !== 'string' ||
        !['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'].includes(canal)))
  )
    throw new BadRequestException();
  function integer(key: string, fallback: number, max: number): number {
    const raw = input[key];
    if (raw === undefined) return fallback;
    if (
      typeof raw !== 'string' ||
      !/^[0-9]+$/.test(raw) ||
      !Number.isSafeInteger(+raw) ||
      +raw < 1 ||
      +raw > max
    )
      throw new BadRequestException();
    return +raw;
  }
  function price(key: string): string | undefined {
    const raw = input[key];
    if (raw === undefined) return undefined;
    if (
      typeof raw !== 'string' ||
      raw.trim() !== raw ||
      !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) ||
      !Number.isFinite(+raw) ||
      +raw < 0
    )
      throw new BadRequestException();
    return raw;
  }
  if (
    input.estado !== undefined &&
    !['BORRADOR', 'ACTIVO', 'INACTIVO'].includes(String(input.estado))
  )
    throw new BadRequestException();
  if (
    input.orden !== undefined &&
    !['NOMBRE_ASC', 'NOMBRE_DESC'].includes(String(input.orden))
  )
    throw new BadRequestException();
  const pagina = integer('pagina', 1, Number.MAX_SAFE_INTEGER);
  const tamanio = integer('tamanio', 20, 100);
  if (!Number.isSafeInteger((pagina - 1) * tamanio))
    throw new BadRequestException();
  const precioMin = price('precioMin'),
    precioMax = price('precioMax');
  if (
    precioMin !== undefined &&
    precioMax !== undefined &&
    compareDecimal(precioMin, precioMax) > 0
  )
    throw new BadRequestException();
  return {
    canal: canal as Canal | undefined,
    q: input.q as string | undefined,
    categoriaId: input.categoriaId as string | undefined,
    marcaId: input.marcaId as string | undefined,
    pagina,
    tamanio,
    estado: input.estado as ProductQuery['estado'],
    precioMin,
    precioMax,
    orden: (input.orden ?? 'NOMBRE_ASC') as ProductQuery['orden'],
  };
}
