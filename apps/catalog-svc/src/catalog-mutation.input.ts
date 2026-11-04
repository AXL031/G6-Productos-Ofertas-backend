import { HttpException } from '@nestjs/common';
import type { Attribute } from './commercial.types.js';
import {
  isPhysicalProfileValid,
  type PhysicalProfile,
} from './catalog-domain.js';

export function catalogError(status: number, code: string): never {
  throw new HttpException({ code }, status);
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function inputObject(value: unknown): Record<string, unknown> {
  if (!object(value)) return catalogError(400, 'VALIDACION');
  return value;
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
export function isUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}
function attributes(value: unknown): Attribute[] {
  if (!Array.isArray(value)) return catalogError(400, 'VALIDACION');
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !object(item) ||
      !text(item.caracteristica_id) ||
      typeof item.nombre !== 'string' ||
      !Object.hasOwn(item, 'valor') ||
      (item.valor_id != null && typeof item.valor_id !== 'string') ||
      seen.has(item.caracteristica_id)
    )
      return catalogError(400, 'VALIDACION');
    seen.add(item.caracteristica_id);
  }
  return value.map((item: Record<string, unknown>) => ({
    caracteristica_id: item.caracteristica_id as string,
    nombre: item.nombre as string,
    valor_id: (item.valor_id as string) ?? null,
    valor: item.valor,
  }));
}
function profile(value: unknown): PhysicalProfile | null {
  if (value === null) return null;
  if (
    !object(value) ||
    (value.pesoKg != null && typeof value.pesoKg !== 'number') ||
    (value.dimensionesCm != null && !object(value.dimensionesCm))
  )
    return catalogError(422, 'PERFIL_FISICO_INVALIDO');
  const dimensions = value.dimensionesCm;
  if (
    object(dimensions) &&
    ['largo', 'ancho', 'alto'].some(
      (k) => dimensions[k] != null && typeof dimensions[k] !== 'number',
    )
  )
    return catalogError(422, 'PERFIL_FISICO_INVALIDO');
  if (!isPhysicalProfileValid(value as PhysicalProfile))
    return catalogError(422, 'PERFIL_FISICO_INVALIDO');
  return value as PhysicalProfile;
}
export interface MutationInput {
  nombre?: string;
  descripcion?: string;
  categoriaId?: string;
  tipoProductoId?: string;
  marcaId?: string;
  skuBase?: string;
  tieneVariantes?: boolean;
  precioBaseInicial?: number;
  sku?: string;
  atributos?: Attribute[];
  atributosIdentificadores?: Attribute[];
  atributosNoIdentificadores?: Attribute[];
  imagenes?: { url: string; principal: boolean }[];
  imagenUrl?: string;
  perfilFisico?: PhysicalProfile | null;
  catalogVersion?: number;
  motivo?: string | null;
  dependencia?: 'PRICING' | 'INVENTARIO';
}
export type MutationKind =
  | 'createProduct'
  | 'updateProduct'
  | 'createVariant'
  | 'updateVariant'
  | 'state'
  | 'retryProduct'
  | 'retryVariant';
export function parseMutation(
  value: unknown,
  kind: MutationKind,
): MutationInput {
  const body = inputObject(
    value ?? (kind === 'state' || kind === 'retryVariant' ? {} : undefined),
  );
  const result: MutationInput = {};
  const update = kind === 'updateProduct' || kind === 'updateVariant';
  if (
    update &&
    Object.hasOwn(body, 'catalogVersion') &&
    body.catalogVersion === null
  )
    return catalogError(400, 'VALIDACION');
  const forbidden =
    kind === 'updateProduct'
      ? [
          'id',
          'product_id',
          'skuBase',
          'sku_base',
          'tieneVariantes',
          'tiene_variantes',
          'tipo_producto_id',
          'slug',
        ]
      : kind === 'updateVariant'
        ? [
            'id',
            'variant_id',
            'product_id',
            'productId',
            'sku',
            'atributosIdentificadores',
            'identifying_key',
          ]
        : [];
  if (update && forbidden.some((k) => Object.hasOwn(body, k)))
    return catalogError(409, 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO');
  const product = kind === 'createProduct' || kind === 'updateProduct';
  const variant = kind === 'createVariant' || kind === 'updateVariant';
  if (product) {
    if (kind === 'updateProduct' && Object.hasOwn(body, 'tipoProductoId')) {
      if (!text(body.tipoProductoId)) return catalogError(400, 'VALIDACION');
      result.tipoProductoId = body.tipoProductoId;
    }
    for (const k of [
      'nombre',
      'descripcion',
      'categoriaId',
      'marcaId',
    ] as const) {
      if (body[k] !== undefined || kind === 'createProduct') {
        if (!text(body[k])) return catalogError(400, 'VALIDACION');
        result[k] = body[k];
      }
    }
    if (kind === 'createProduct') {
      if (
        !text(body.tipoProductoId) ||
        !text(body.skuBase) ||
        typeof body.tieneVariantes !== 'boolean' ||
        typeof body.precioBaseInicial !== 'number' ||
        !Number.isFinite(body.precioBaseInicial) ||
        body.precioBaseInicial <= 0
      )
        return catalogError(400, 'VALIDACION');
      Object.assign(result, {
        tipoProductoId: body.tipoProductoId,
        skuBase: body.skuBase,
        tieneVariantes: body.tieneVariantes,
        precioBaseInicial: body.precioBaseInicial,
      });
    }
    if (body.atributos !== undefined)
      result.atributos = attributes(body.atributos);
    if (body.imagenes !== undefined) {
      if (
        !Array.isArray(body.imagenes) ||
        body.imagenes.some(
          (i) =>
            !object(i) ||
            !isUri(i.url) ||
            (i.principal !== undefined && typeof i.principal !== 'boolean'),
        )
      )
        return catalogError(400, 'VALIDACION');
      result.imagenes = body.imagenes.map((i: Record<string, unknown>) => ({
        url: i.url as string,
        principal: i.principal === true,
      }));
    }
  }
  if (variant) {
    if (kind === 'createVariant') {
      if (!text(body.sku)) return catalogError(422, 'SKU_INVALIDO');
      result.sku = body.sku;
      result.atributosIdentificadores = attributes(
        body.atributosIdentificadores,
      );
      if (!result.atributosIdentificadores.length)
        return catalogError(422, 'ATRIBUTO_IDENTIFICADOR_INVALIDO');
    }
    if (body.atributosNoIdentificadores !== undefined)
      result.atributosNoIdentificadores = attributes(
        body.atributosNoIdentificadores,
      );
    if (body.imagenUrl !== undefined || kind === 'createVariant') {
      if (!isUri(body.imagenUrl)) return catalogError(422, 'IMAGEN_INVALIDA');
      result.imagenUrl = body.imagenUrl;
    }
  }
  if ((product || variant) && body.perfilFisico !== undefined)
    result.perfilFisico = profile(body.perfilFisico);
  if (body.catalogVersion != null && (update || kind === 'state')) {
    if (
      !Number.isSafeInteger(body.catalogVersion) ||
      (body.catalogVersion as number) < 0
    )
      return catalogError(400, 'VALIDACION');
    result.catalogVersion = body.catalogVersion as number;
  }
  if (
    body.motivo !== undefined &&
    (kind === 'state' || kind.startsWith('retry'))
  ) {
    if (kind.startsWith('retry') && body.motivo === null)
      return catalogError(400, 'VALIDACION');
    if (
      (body.motivo !== null && typeof body.motivo !== 'string') ||
      (kind === 'state' &&
        typeof body.motivo === 'string' &&
        body.motivo.length > 500)
    )
      return catalogError(400, 'VALIDACION');
    result.motivo = body.motivo as string | null;
  }
  if (kind === 'retryProduct') {
    if (body.dependencia !== 'PRICING' && body.dependencia !== 'INVENTARIO')
      return catalogError(400, 'VALIDACION');
    result.dependencia = body.dependencia;
  }
  return result;
}
