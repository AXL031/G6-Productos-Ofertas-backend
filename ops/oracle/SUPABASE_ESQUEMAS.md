# Esquemas físicos PostgreSQL observados y modelo de aplicación

## Estado y límites de evidencia

La auditoría histórica de preparación del 2026-10-17 (`hito3-preparacion.md`, sección runtime) registró ocho esquemas y roles de servicio existentes y autenticables desde el host Oracle, con TLS `verify-full`; anotó conteos físicos: catalog 14, taxonomy 13, pricing 8, price_audit 5, promotions 14, inventory 16, combos 6 y bulk 8 tablas. Es evidencia fechada de host-level connectivity, no una comprobación actual desde contenedores ni una garantía de acceso para cada servicio. No se vuelven a publicar usuarios, rutas privadas ni credenciales.

Las listas siguientes son los nombres definidos por las migraciones de `docs/origin/master` SHA `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`, no un inventario de presencia individual realizado en la VM. Cada conteo histórico coincide con las tablas de aplicación listadas más `schema_migrations`. La existencia física del esquema/tablas no demuestra repositorios funcionales, migraciones aplicadas en la revisión actual, permisos correctos, conectividad desde el contenedor ni readiness.

| Schema | Tablas de aplicación según migraciones oficiales |
|---|---|
| `catalog` | `products`, `variants`, `sku_identity`, `product_images`, `variant_images`, `product_attribute_values`, `variant_attribute_values`, `product_identifying_characteristics`, `sku_physical_profiles`, `activation_checks`, `master_barriers`, `outbox`, `inbox` |
| `taxonomy` | `runtime_settings`, `categories`, `brands`, `characteristics`, `characteristic_values`, `product_types`, `product_type_characteristics`, `category_seo`, `slug_history`, `master_deactivation_operations`, `outbox`, `inbox` |
| `pricing` | `prices`, `price_validities`, `scheduled_prices`, `bulk_price_jobs`, `bulk_price_rows`, `outbox`, `inbox` |
| `price_audit` | `inbox`, `price_audit_log`, `export_jobs`, `archive_manifests` |
| `promotions` | `promotions`, `promotion_scopes`, `combination_policy`, `coupons`, `coupon_uses`, `recommendation_rules`, `recommendation_items`, `catalog_projection`, `price_projection`, `stock_projection`, `outbox`, `inbox`, `coupon_command_receipts` |
| `inventory` | `locations`, `stock_balance`, `reservations`, `reservation_lines`, `inventory_operations`, `kardex`, `incidencias`, `traslados`, `traslado_recepciones`, `stock_threshold_override`, `inventory_config`, `dashboard_projection`, `outbox`, `inbox`, `commercial_fulfillment_routes` |
| `combos` | `combos`, `combo_items`, `component_projection`, `outbox`, `inbox` |
| `bulk` | `file_manifests`, `batch_jobs`, `batch_rows`, `row_domain_steps`, `export_jobs`, `outbox`, `inbox` |

## Conteos observados directamente (solo lectura)

Observación: `2026-10-20 00:11:34.265687+00` UTC, con Supabase MCP en el proyecto configurado como **Modulo de Productos y Ofertas**. Se enumeraron 84 tablas en los ocho schemas y se ejecutaron consultas SQL exclusivamente `SELECT count(*)` por tabla: 54 tablas vacías y 30 con al menos una fila; 483 filas sumadas incluyendo `schema_migrations`. Esta medida es una fotografía, no una garantía de que los datos sigan iguales.

| Schema | Tabla | Filas exactas observadas |
|---|---|---:|
| `bulk` | `batch_jobs` | 0 |
| `bulk` | `batch_rows` | 0 |
| `bulk` | `export_jobs` | 0 |
| `bulk` | `file_manifests` | 0 |
| `bulk` | `inbox` | 0 |
| `bulk` | `outbox` | 0 |
| `bulk` | `row_domain_steps` | 0 |
| `bulk` | `schema_migrations` | 1 |
| `catalog` | `activation_checks` | 0 |
| `catalog` | `inbox` | 0 |
| `catalog` | `master_barriers` | 0 |
| `catalog` | `outbox` | 0 |
| `catalog` | `product_attribute_values` | 6 |
| `catalog` | `product_identifying_characteristics` | 24 |
| `catalog` | `product_images` | 3 |
| `catalog` | `products` | 20 |
| `catalog` | `schema_migrations` | 1 |
| `catalog` | `sku_identity` | 71 |
| `catalog` | `sku_physical_profiles` | 0 |
| `catalog` | `variant_attribute_values` | 102 |
| `catalog` | `variant_images` | 51 |
| `catalog` | `variants` | 51 |
| `combos` | `combo_items` | 0 |
| `combos` | `combos` | 0 |
| `combos` | `component_projection` | 0 |
| `combos` | `inbox` | 0 |
| `combos` | `outbox` | 0 |
| `combos` | `schema_migrations` | 1 |
| `inventory` | `commercial_fulfillment_routes` | 0 |
| `inventory` | `dashboard_projection` | 0 |
| `inventory` | `inbox` | 0 |
| `inventory` | `incidencias` | 0 |
| `inventory` | `inventory_config` | 0 |
| `inventory` | `inventory_operations` | 14 |
| `inventory` | `kardex` | 12 |
| `inventory` | `locations` | 2 |
| `inventory` | `outbox` | 0 |
| `inventory` | `reservation_lines` | 0 |
| `inventory` | `reservations` | 0 |
| `inventory` | `schema_migrations` | 2 |
| `inventory` | `stock_balance` | 14 |
| `inventory` | `stock_threshold_override` | 0 |
| `inventory` | `traslado_recepciones` | 0 |
| `inventory` | `traslados` | 0 |
| `price_audit` | `archive_manifests` | 0 |
| `price_audit` | `export_jobs` | 0 |
| `price_audit` | `inbox` | 0 |
| `price_audit` | `price_audit_log` | 0 |
| `price_audit` | `schema_migrations` | 1 |
| `pricing` | `bulk_price_jobs` | 0 |
| `pricing` | `bulk_price_rows` | 0 |
| `pricing` | `inbox` | 0 |
| `pricing` | `outbox` | 0 |
| `pricing` | `price_validities` | 20 |
| `pricing` | `prices` | 20 |
| `pricing` | `scheduled_prices` | 0 |
| `pricing` | `schema_migrations` | 1 |
| `promotions` | `catalog_projection` | 0 |
| `promotions` | `combination_policy` | 0 |
| `promotions` | `coupon_command_receipts` | 0 |
| `promotions` | `coupon_uses` | 0 |
| `promotions` | `coupons` | 0 |
| `promotions` | `inbox` | 0 |
| `promotions` | `outbox` | 0 |
| `promotions` | `price_projection` | 0 |
| `promotions` | `promotion_scopes` | 0 |
| `promotions` | `promotions` | 0 |
| `promotions` | `recommendation_items` | 0 |
| `promotions` | `recommendation_rules` | 0 |
| `promotions` | `schema_migrations` | 4 |
| `promotions` | `stock_projection` | 0 |
| `taxonomy` | `brands` | 6 |
| `taxonomy` | `categories` | 8 |
| `taxonomy` | `category_seo` | 3 |
| `taxonomy` | `characteristic_values` | 23 |
| `taxonomy` | `characteristics` | 2 |
| `taxonomy` | `inbox` | 0 |
| `taxonomy` | `master_deactivation_operations` | 0 |
| `taxonomy` | `outbox` | 0 |
| `taxonomy` | `product_type_characteristics` | 12 |
| `taxonomy` | `product_types` | 6 |
| `taxonomy` | `runtime_settings` | 1 |
| `taxonomy` | `schema_migrations` | 1 |
| `taxonomy` | `slug_history` | 0 |

### Datos maestros y efecto en una prueba funcional

En esta observación hay 20 productos, 51 variantes, 6 marcas, 8 categorías, 20 precios y 14 filas de saldo de stock. El GET de Catalog probado por HTTPS devolvió 15 productos publicables; Nike Academy aparece como producto con SKU base `NIK-ACADEMY-HV4386-05`, y su detalle tiene cero variantes. Estos conteos muestran datos para algunas lecturas; no prueban integridad de cada relación ni que todos los SKUs sean vendibles. Muchos objetos operativos (reservas, trabajos, outbox/inbox, promociones, combos y bulk) están vacíos, lo que impide usar esos datos como evidencia de un flujo ya procesado. Ver detalle de la sonda pública en `servicios/catalog-svc.md`.

### Permisos y conectividad

Consulta de solo lectura a `pg_roles`, `has_schema_privilege` y `has_table_privilege` observó ocho logins `*_dev_login`, uno por schema, con LOGIN y sin SUPERUSER/CREATEROLE/CREATEDB/BYPASSRLS; cada uno tiene USAGE y SELECT/INSERT/UPDATE/DELETE efectivo en las tablas de su propio schema (8/8 bulk, 14/14 catalog, 6/6 combos, 16/16 inventory, 5/5 price_audit, 8/8 pricing, 14/14 promotions, 13/13 taxonomy). Son roles denominados de desarrollo; esta inspección no los aprueba como identidades de producción, no verificó passwords ni abrió sesión con cada login. Los roles `*_app` consultados son NOLOGIN. El catálogo de privilegios tampoco prueba que las variables privadas del contenedor usen esos logins.

Conectividad real desde contenedores verificada en Oracle el 2026-10-20: Taxonomy y Pricing dieron readiness 200 en consultas internas de solo lectura; Catalog tuvo resultados intermitentes 503 y 200 en el endpoint de readiness en el intervalo observado. Esto prueba consultas de dependencia desde esas instancias en esos momentos, no acceso de los otros cinco servicios ni estabilidad continua. RabbitMQ no tiene conexión autorizada desde `g6-http`.

**Aviso de seguridad:** el listado Supabase reportó RLS deshabilitado en las 84 tablas. Una consulta ACL separada verificó que `anon` y `authenticated` no tienen USAGE/CREATE sobre estos schemas ni privilegios DML en sus tablas. Esto reduce la posibilidad de acceso por esos roles en estas tablas, pero no verifica la configuración de schemas expuestos de la Data API ni elimina el hallazgo de RLS; el owner de Seguridad debe revisar la exposición antes de declarar el riesgo cerrado. No habilitar RLS ni cambiar policies/grants como parte de esta documentación.

## Implementación por separado

- Repositorios y readiness reales están identificados en Catalog (rama Poma), Taxonomy (rama Lopez) y Pricing (rama Vera). Su existencia se comprueba en esos SHAs, no en el mero inventario físico.
- Inventory (rama Taco) y Promotions (rama Cueva) tienen implementaciones candidatas de persistencia; no están integradas y requieren pruebas aisladas y configuración exacta de sus fichas.
- Price Audit, Combos y Bulk mantienen scaffolds o implementación incompleta respecto a persistencia/negocio en los HEAD registrados en sus fichas.
- Gateway no tiene esquema propio. Su `read_model` documentado queda fuera de estos ocho esquemas operativos de servicios.

No conceder, ampliar ni inferir permisos. Cualquier cambio SQL en Supabase necesita autorización expresa, alcance y proceso de despliegue aprobado; esta ficha no ejecuta ni propone DDL.
