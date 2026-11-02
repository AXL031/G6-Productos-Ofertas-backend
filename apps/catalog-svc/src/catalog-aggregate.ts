import { ServiceUnavailableException } from '@nestjs/common';
import type { PostgresCatalogWriteRepository } from './postgres-catalog-write.repository.js';
import type { PhysicalProfile } from './catalog-domain.js';
import type { PhysicalSkuData } from './catalog-query.types.js';
export type CatalogAggregate = Awaited<
  ReturnType<PostgresCatalogWriteRepository['aggregate']>
>;
export type CatalogChild = CatalogAggregate['children'][number];
export function domainProfile(
  profile: CatalogAggregate['profile'],
): PhysicalProfile {
  return profile
    ? {
        pesoKg: profile.pesoKg === null ? null : Number(profile.pesoKg),
        dimensionesCm: {
          largo: profile.largo === null ? null : Number(profile.largo),
          ancho: profile.ancho === null ? null : Number(profile.ancho),
          alto: profile.alto === null ? null : Number(profile.alto),
        },
      }
    : {};
}
function version(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new ServiceUnavailableException();
  return n;
}
function physical(
  sku: string,
  state: string,
  profile: CatalogAggregate['profile'],
): PhysicalSkuData | null {
  if (!profile || state === 'BORRADOR') return null;
  const values = [
    profile.pesoKg,
    profile.largo,
    profile.ancho,
    profile.alto,
  ].map((v) => (v === null ? NaN : Number(v)));
  if (!values.every((v) => Number.isFinite(v) && v > 0)) return null;
  return {
    sku,
    estado: state === 'ACTIVA' || state === 'ACTIVO' ? 'ACTIVO' : 'INACTIVO',
    pesoKg: values[0]!,
    dimensionesCm: { largo: values[1]!, ancho: values[2]!, alto: values[3]! },
    actualizadoEn: profile.updatedAt.toISOString(),
  };
}
export function attribute(
  row: Pick<
    CatalogAggregate['attributes'][number],
    'caracteristica_id' | 'nombre_snapshot' | 'valor_id' | 'valor'
  >,
) {
  return {
    caracteristica_id: row.caracteristica_id,
    nombre: row.nombre_snapshot,
    valor_id: row.valor_id,
    valor: row.valor,
  };
}
export function presentVariant(child: CatalogChild) {
  return {
    variant_id: child.id,
    sku: child.sku,
    status: child.estado,
    catalog_version: version(child.catalog_version),
    identifying_attributes: child.attributes
      .filter((a) => a.es_identificador)
      .map(attribute),
    non_identifying_attributes: child.attributes
      .filter((a) => !a.es_identificador)
      .map(attribute),
    images: child.images.map((i) => i.url),
    physical_profile: physical(child.sku, child.estado, child.profile),
  };
}
export function presentProduct(aggregate: CatalogAggregate) {
  return {
    product_id: aggregate.id,
    slug: aggregate.slug,
    name: aggregate.nombre,
    description: aggregate.descripcion,
    categoria_id: aggregate.categoria_id,
    tipo_producto_id: aggregate.tipo_producto_id,
    marca_id: aggregate.marca_id,
    tiene_variantes: aggregate.tiene_variantes,
    sku_base: aggregate.sku_base,
    status: aggregate.estado,
    catalog_version: version(aggregate.catalog_version),
    attributes: aggregate.attributes.map(attribute),
    images: aggregate.images.map((i) => i.url),
    perfil_fisico: aggregate.tiene_variantes
      ? null
      : physical(aggregate.sku_base, aggregate.estado, aggregate.profile),
    pricing_preparado: aggregate.checks.some(
      (c) => c.dependency === 'PRICING' && c.state === 'COMPLETED',
    ),
    ...(aggregate.tiene_variantes
      ? {}
      : {
          inventario_inicializado: aggregate.checks.some(
            (c) =>
              c.dependency === 'INVENTORY' &&
              c.variant_id === null &&
              c.state === 'COMPLETED',
          ),
        }),
    variants: aggregate.children.map(presentVariant),
  };
}
