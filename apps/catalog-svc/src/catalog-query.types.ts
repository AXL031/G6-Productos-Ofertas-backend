import type { Attribute } from './commercial.types.js';

export interface PhysicalSkuData {
  sku: string;
  estado: 'ACTIVO' | 'INACTIVO';
  pesoKg: number;
  dimensionesCm: { largo: number; ancho: number; alto: number };
  actualizadoEn: string;
}

export interface PreparationDependency {
  status: 'PENDING' | 'COMPLETED' | 'REJECTED';
  manual_retry_allowed: boolean;
  code?: string | null;
}

export interface VariantPreparation {
  variant_id: string;
  sku: string;
  inventario: PreparationDependency;
}

export interface ProductPreparation {
  product_id: string;
  tiene_variantes: boolean;
  pricing: PreparationDependency;
  inventario: PreparationDependency | null;
  variantes: VariantPreparation[];
}

export interface AdminVariant {
  variant_id: string;
  sku: string;
  status: 'BORRADOR' | 'ACTIVA' | 'INACTIVA';
  identifying_attributes: Attribute[];
  non_identifying_attributes: Attribute[];
  images: string[];
  physical_profile: PhysicalSkuData | null;
  catalog_version: number;
}

export interface PageMeta {
  pagina: number;
  tamanio: number;
  total: number;
  totalPaginas: number;
}

export interface VariantPage {
  items: AdminVariant[];
  meta: PageMeta;
}
