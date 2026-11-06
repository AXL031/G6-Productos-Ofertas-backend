export function bulkSimpleCsv(sku) {
  const headers = 'operacion,producto_id,catalog_version,sku_base,sku_variante,nombre,descripcion,categoria_id,marca_id,tipo_producto_id,tiene_variantes,precio_regular,atributos_producto,atributos_variante,imagen_url,stock_inicial';
  return `${headers}\r\nALTA,,,${sku},,Bulk real,Disposable,category-fixture,brand-fixture,type-fixture,false,20,[],,,0\r\n`;
}
