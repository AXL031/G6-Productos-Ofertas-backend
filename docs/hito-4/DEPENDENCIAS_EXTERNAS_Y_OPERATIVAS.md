# Dependencias externas y operativas

| Owner | Frontera | Condición de desbloqueo |
| --- | --- | --- |
| G7 Seguridad y Marco (G6) | Autenticación humana de Gateway y servicios | Issuer y JWKS del entorno verificados. JWT de un gestor y de usuario sin rol. Evidencia HTTP positiva y negativa por operación. |
| G7 Seguridad y Vera (Pricing) | Introspección de escrituras | Cliente técnico autorizado con `tokens:introspeccion`, credencial runtime y prueba de introspección positiva y de fallo cerrado. |
| G7 Seguridad y owners de proveedores G6 | M2M de Catalog, Pricing, Inventory, Combos y Promotions | Grants efectivos para cliente, audiencia, scopes y canales aprobados por operación. Usar evidencia de JWT real sin publicar credenciales. |
| Vera (Pricing), arquitectura G6 | Precio editable por canal | Homologar las dos lecturas candidatas y probar lectura, PATCH e historial con PostgreSQL y G7 reales. |
| Taco (Inventory), G7 y Marco | Traslados y recepción en modo G7 | Configurar el mapa INVENTORY_G7_TRANSFER_GRANTS con operadores autorizados, habilitar GATEWAY_INVENTORY_LOCAL_GRANTS_ENABLED y acreditar JWT real y evidencia bilateral para `listarTrasladosInventario`, `obtenerTrasladoInventario` y `registrarRecepcionTrasladoInventario`. |
| Taco (Inventory) y owner maestro de ubicaciones | Alertas operativas | El estado calculado ya se filtra en la consulta física. Confirmar requisitos si se necesita un recurso persistente de alertas. |
| López (Taxonomy), Poma (Catalog) y Marco | Asociaciones tipo–característica | Catálogo expone su selección persistida. Validar la barrera real de desactivación y la adaptación de frontend a SPEC-004/010. |
| Castilla (Combos/Bulk) y proveedores G6 | Recuperación tras respuesta incierta | Combos tiene contrato candidato y prueba de concurrencia. Aplicar la migración con permisos SELECT/INSERT del rol runtime. Bulk requiere el protocolo de reanudación aprobado. |
| Vera (Price Audit) y arquitectura/Docs | Listado y detalle con SKU/canal nulos | Homologar las rutas candidatas y probar exportación con almacenamiento, sin cambiar el DTO rc.3. |
| Infraestructura Taxonomy y López | Publicación de logos multipart | Montar volumen autorizado para escritura de Taxonomy y servirlo en la base HTTPS aprobada de assets. Verificar GET del logo escrito. |
| Infraestructura Gateway y frontend H4 | CORS del frontend publicado | Confirmar origen exacto y URL HTTPS por entorno. Configurar el origen y probar OPTIONS, llamada Bearer y descarga desde el navegador. |
| Devteam/CI G6 | E2E de persistencia y mensajería | Runner con Docker, PostgreSQL y RabbitMQ descartables, OpenSSL y acceso a dependencias. Asociar evidencias al SHA que se someta a revisión. |

Homologación, grants, CI, imagen y despliegue se acreditan por separado. La configuración del Gateway y la PR están sujetas al flujo de publicación de Backend #111.
