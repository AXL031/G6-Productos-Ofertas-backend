export type Canal = 'MARKETPLACE' | 'CHATBOT' | 'RETAIL' | 'VENTAS';
export interface ProductQuery {
  canal?: Canal;
  q?: string;
  categoriaId?: string;
  marcaId?: string;
  pagina: number;
  tamanio: number;
  estado?: 'BORRADOR' | 'ACTIVO' | 'INACTIVO';
  precioMin?: string | number;
  precioMax?: string | number;
  orden: 'NOMBRE_ASC' | 'NOMBRE_DESC';
}
export interface Attribute {
  caracteristica_id: string;
  nombre: string;
  valor_id: string | null;
  valor: unknown;
}
export interface ProductSummary {
  product_id: string;
  slug: string;
  name: string;
  description: string;
  categoria_id: string;
  tipo_producto_id: string;
  marca_id: string;
  tiene_variantes: boolean;
  sku_base: string | null;
  images: string[];
  attributes: Attribute[];
}
export interface CommercialVariant {
  variant_id: string;
  sku: string;
  identifying_attributes: Attribute[];
  non_identifying_attributes: Attribute[];
  images: string[];
}
export interface CommercialBrand {
  marca_id: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  country_code: string | null;
}
export interface ProductDetail extends ProductSummary {
  marca: CommercialBrand;
  variants: CommercialVariant[];
}
export interface ProductPage {
  items: ProductSummary[];
  pagina: number;
  tamanio: number;
  total: number;
}

// Demo-only extension; canonical HTTP/OpenAPI price fields remain unchanged.
export interface DemoProduct extends ProductSummary {
  precio_regular: number;
  precio_oferta: number | null;
  currency: string;
}

export interface DemoProductDetail extends DemoProduct {
  variants: CommercialVariant[];
}
