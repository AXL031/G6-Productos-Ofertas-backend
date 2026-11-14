# Consumo frontend H4

El contrato local candidato permite reabrir un borrador o un inactivo después de recargar. Usa el mismo token de acceso del gestor para las dos nuevas lecturas, las mutaciones y las consultas existentes de preparación y variantes.

```sh
curl -H "Authorization: Bearer ${G7_ACCESS_TOKEN}" \
  "${GATEWAY_URL}/api/v1/productos/administracion?estado=BORRADOR&pagina=1&tamanio=20"
curl -H "Authorization: Bearer ${G7_ACCESS_TOKEN}" \
  "${GATEWAY_URL}/api/v1/productos/administracion/${PRODUCT_ID}"
```

Ejemplo de forma del detalle para un borrador de prueba. El ID y las fechas son ilustrativos.

```json
{
  "productId": "11111111-1111-4111-8111-111111111111",
  "catalogVersion": 4,
  "estado": "BORRADOR",
  "nombre": "Calzado de prueba",
  "descripcion": "Borrador administrativo",
  "categoriaId": "categoria-fixture",
  "marcaId": "marca-fixture",
  "tipoProductoId": "tipo-fixture",
  "skuBase": "SKU-DEMO-001",
  "slug": "calzado-de-prueba",
  "tieneVariantes": false,
  "publicadoAlgunaVez": false,
  "creadoEn": "2026-11-07T13:00:00.000Z",
  "actualizadoEn": "2026-11-07T13:02:00.000Z",
  "imagenes": [],
  "atributos": [],
  "caracteristicasIdentificadoras": [],
  "perfilFisico": null
}
```

Para editar este registro, usar `PATCH /api/v1/productos/{productoId}` con `{"descripcion":"Borrador editado","catalogVersion":4}`. Volver a consultar el detalle después de una escritura o de un `409 VERSION_CONFLICT`. Las operaciones de escritura vigentes tienen su propio DTO, incluido `catalog_version` en la respuesta existente.

Configurar en el Gateway `GATEWAY_CORS_ALLOWED_ORIGINS` con los orígenes exactos aprobados, separados por comas, por ejemplo `https://admin.example.test,http://localhost:5173`. El valor vacío desactiva CORS. El navegador puede leer `Content-Disposition`, `Location` y `X-Correlation-Id` cuando la respuesta los incluya. El origen admitido por CORS sigue necesitando el Bearer de G7 en la petición real.

Pricing acepta los valores textuales exactos `MARKETPLACE`, `CHATBOT`, `RETAIL` y `VENTAS` en `channelId`. Global usa `null` u omisión. El parser vigente rechaza UUID y alias. Para una escritura por canal, obtener primero la versión de la definición a editar. Las lecturas nuevas de definición exacta permiten obtener esa versión sin usar el precio heredado.

Los contratos candidatos están separados por servicio: [Catálogo](catalogo-admin.openapi.json), [Pricing](pricing-admin.openapi.json), [Inventario](inventory-admin.openapi.json), [Price Audit](price-audit-admin.openapi.json) y [Combos](combos-admin.openapi.json). El frontend puede adaptar sus DTO a esta propuesta local. La URL publicada y el preflight desde su origen real requieren verificación en el ambiente objetivo.

Para editar un precio de Retail, consultar `GET /api/v1/precios/administracion/productos/{productoId}?channelId=RETAIL` o `GET /api/v1/precios/administracion/skus/{sku}?channelId=RETAIL`. Ejemplo de una definición existente con una versión editable 7:

```json
{
  "productId": null,
  "sku": "SKU-DEMO-001",
  "channelId": "RETAIL",
  "priceVersion": 7,
  "vigenciaActual": {
    "precioRegular": 79.5,
    "precioOferta": null,
    "currency": "PEN",
    "validFrom": "2026-11-07T13:00:00.000Z",
    "validUntil": null
  }
}
```

Enviar `channelId` y `priceVersion` en el PATCH correspondiente. Para un `404` de la lectura exacta, consultar el precio efectivo por la ruta comercial si se necesita mostrar la herencia. La herencia no confirma que se pueda crear un override.

Para la grilla física, usar `GET /api/v1/inventario/administracion/saldos?pagina=1&tamanio=20` con el mismo Bearer de gestor. Identificar filas por `(sku, ubicacion.locationId)`. Los campos `onHand`, `reserved`, `blocked` y `available` vienen del saldo de esa ubicación. Conservar el nulo de `skuActivo` y mostrar `ubicacion.nombre` sin reconstruirlo desde el ID. `estado` describe el saldo local. La API comercial sigue siendo la fuente de disponibilidad comercial.

## Flujos recuperables y estado operativo

- Combos usa POST /api/v1/combos/administracion con un Idempotency-Key por intención. Una repetición con el mismo cuerpo y gestor devuelve 201 y la misma identidad. La representación refleja el estado persistido al reintentar. Una clave con otro cuerpo devuelve 409 IDEMPOTENCY_CONFLICT.
- Auditoría usa GET /api/v1/auditoria-precios/administracion y GET /api/v1/auditoria-precios/administracion/{auditId}. Para target_type PRODUCTO, sku es null. El canal global se devuelve como canal_origen null. Los endpoints existentes de exportación conservan su contrato.
- Para alertas de Inventario, usar estado=STOCK_BAJO o estado=AGOTADO en GET /api/v1/inventario/administracion/saldos. El filtro se aplica antes de contar y paginar. actualizadoEn corresponde al saldo, no a la creación de una alerta.
- En marcas, multipart con archivo válido y sin logoUrl publica el archivo en el volumen configurado. Omitir el logo conserva el valor. El campo logo vacío en PATCH lo desvincula. Una logoUrl explícita mantiene el comportamiento anterior de referencia externa.
- En variantes, las características identificadoras provienen de caracteristicasIdentificadoras en el detalle del producto de Catálogo. Una lista vacía deja la elección para la primera variante. La asociación obligatoria de Taxonomía no define esa selección.
