# catalog-svc — configuración y readiness (#43)

Los [puntos 2 y 3](DECISION-PUNTOS-2-3.md) incorporan filtros monetarios previos a
paginación y el resolver persistente de códigos de barras, con administración
interna autorizada. La integración productiva con Pricing requiere su identidad,
contexto SKU y mapeo de canales; barcode requiere aplicar la migración aditiva
`migrations/0002_create_sku_barcodes.sql` mediante el procedimiento oficial.

La [decisión D-CAT-05/06](DECISION-D-CAT-05-06.md) registra la elegibilidad global
implementada por indicación de Gabriel en `poma`: producto simple ACTIVO, o padre
ACTIVO con al menos una variante ACTIVA. Los detalles incluyen únicamente variantes
ACTIVA. Los cuatro canales comparten la regla; el enum VENTAS no concede acceso a
`modulo-ventas`. Se conservan las consultas administrativas autorizadas y los modos
demo explícitos. La ratificación documental y homologación externa siguen pendientes.

Demo interna de consulta real aprobada el 2026-10-17: [alcance, evidencias y liberación pendiente](DEMO-READ-ONLY.md).

Rama personal `poma`. El PR #119 conserva el código comercial incorporado desde
master; estas correcciones se limitan a configuración, arranque, observabilidad,
readiness y sus pruebas. Las ediciones propias no cambian CI, contratos, otros servicios ni migraciones.
La integración solicitada de master conserva también los cambios ajenos tal como
fueron publicados por sus owners.

## Contrato de configuración

El servicio usa exclusivamente el esquema PG. `CatalogConfig` llama al mismo
validador que el proveedor `Database` y le inyecta una instantánea de configuración:
el pool y la verificación de identidad no vuelven a leer variables distintas.
`DATABASE_URL` no sustituye este contrato y no es un modo de conexión soportado.

`CatalogConfig.taxonomy` es una instantánea inmutable validada e inyectada en
`TaxonomyClient` mediante `CATALOG_TAXONOMY_CONFIG`. El cliente no consulta el
entorno por request. Las herramientas existentes que lo construyen sin DI usan
el mismo validador al crear la instantánea; una configuración inyectada siempre
prevalece sobre el entorno, incluso si cambia después de validar.

| Variable | Requisito y descripción |
| --- | --- |
| `NODE_ENV` | Obligatoria: `development`, `test` o `production`. |
| `CATALOG_SVC_PORT` | Puerto HTTP decimal entre 1 y 65535. |
| `PORT` | Alternativa solo cuando `CATALOG_SVC_PORT` no existe. Un valor específico inválido no usa fallback. |
| `CATALOG_SVC_HOST` | Opcional; `127.0.0.1` por defecto. Admite también `0.0.0.0`, `::1` y `::`. |
| `PGHOST` | Obligatoria; identidad DNS/IP del servidor, utilizada para verificar el certificado TLS. |
| `G6_CONNECT_HOST` | Dirección TCP opcional. Permite conectar a otro host/IP conservando la verificación TLS contra `PGHOST`. |
| `PGPORT` | Obligatoria; puerto PostgreSQL decimal entre 1 y 65535. |
| `PGDATABASE` | Obligatoria; base esperada durante la comprobación de identidad. |
| `PGUSER` | Obligatoria; identidad propia de Catálogo. En Session Pooler puede incluir el sufijo del proyecto. En modo directo debe coincidir con `G6_EXPECTED_ROLE`. |
| `PGPASSWORD` | Obligatoria; contraseña privada de esa identidad. Nunca se registra. |
| `PGSSLMODE` | Obligatoria: `verify-full`. No se permite desactivar TLS ni la validación del certificado. |
| `PGSSLROOTCERT` | Obligatoria; ruta absoluta a una CA PEM existente y legible. |
| `G6_DATABASE_SCHEMA` | Obligatoria: `catalog`. |
| `G6_EXPECTED_ROLE` | Obligatoria: `catalog_dev_login` o `catalog_app`; debe corresponder a `PGUSER`. |
| `G6_CONNECTION_MODE` | Obligatoria: `session` o `direct`. Ambos modos mantienen TLS estricto y verificación de identidad. |
| `CATALOG_TAXONOMY_URL` | Origen HTTP(S) del servicio de Taxonomía para las consultas comerciales. Si se proporciona, se valida antes del arranque: sin credenciales, path adicional, query ni fragmento. Su ausencia no habilita una integración ficticia; las operaciones dependientes fallan cerradas. |

Desde la raíz se carga `apps/catalog-svc/.env.local` y después `.env`, sin
sobrescribir valores ya definidos. Prioridad: entorno del proceso > archivo del
servicio > archivo raíz. El archivo privado del servicio está ignorado por Git.
Nunca versionar contraseñas ni rutas privadas de otros equipos.

Una configuración ausente/malformada impide crear Nest. Antes de escuchar, el
servicio comprueba identidad, base, USAGE del schema y ausencia de privilegios
administrativos/owner. Los errores de validación contienen nombres de variables,
no sus valores. Bootstrap registra JSON sanitizado con `APPLICATION_STARTED` o
`APPLICATION_START_FAILED`; el fallo sale por stderr y termina con código 1.

## Health, readiness y ciclo de vida

- `GET /health` conserva `{ "status": "ok", "service": "catalog-svc" }`.
- `GET /health/live` confirma que el proceso HTTP está vivo; no consulta la base.
- `GET /health/ready` reutiliza el mismo proveedor `Database`, configuración y pool
  de las operaciones comerciales. Verifica identidad y conserva la comprobación
  comercial de master. No abre un cliente PostgreSQL adicional.
- El endpoint ready tiene un timeout de 2 s. Un error o dependencia no comprobada
  devuelve 503 con el código contractual `SERVICIO_NO_DISPONIBLE`, sin secretos.
- La política global D-CAT-05/06 consulta productos y variantes oficiales. Una
  consulta vacía válida permite readiness; un fallo DB devuelve 503. No requiere
  asignaciones por canal ni llamadas a Pricing/Inventario.
- El pool conserva su máximo de 4 conexiones y timeouts explícitos de 10 s. Los
  timeouts del pool no alargan el límite de respuesta HTTP de readiness.
- Los sondeos concurrentes comparten una sola comprobación y un plazo de 2 s
  desde su inicio. Al vencer, todos reciben 503. No se afirma cancelación PG:
  la operación subyacente puede seguir hasta sus timeouts. Mientras drena,
  nuevos sondeos reciben 503 inmediatamente sin iniciar más comprobaciones.
  Un resultado tardío no se convierte en éxito cacheado.
- Tras completar la comprobación, el próximo sondeo consulta identidad otra vez;
  no reutiliza un éxito anterior. Al cerrar Nest se cierra su pool.
- El sondeo CLI existente sigue en `node dist/apps/catalog-svc/readiness.js` y no
  se ejecuta al importar el controlador desde Nest o tests.

Los logs JSON redactan secretos por clave, URLs, Bearer/JWT, objetos Error y los
valores sensibles del entorno. `X-Correlation-Id` usa UUID hexadecimal 8-4-4-4-12
en bootstrap, controlador y filtro. Un UUID válido conserva exactamente su
identidad, incluidas mayúsculas; si falta, se genera una sola identidad. Un valor
inválido produce 400 `VALIDACION` con una nueva identidad UUID idéntica en la
cabecera y el cuerpo problem. El filtro preserva la identidad ya establecida.
No se comprueban brokers ni se hace fan-out a servicios ajenos al trabajo admitido.

## Persistencia Drizzle de Catálogo

`src/catalog.schema.ts` mapea las 13 tablas de `catalog` y conserva los enums
nativos, constraints declarativos, defaults y relaciones de la migración oficial
`datos/catalog-svc/migrations/0001_create_catalog.sql` del repositorio de Docs.
La copia de solo lectura bajo `test/fixtures/` permite preparar PostgreSQL
desechable en la suite; no es una migración ejecutable del servicio ni sustituye
el historial oficial.

`Database` mantiene un único pool, usa la configuración validada por
`CatalogConfig` y crea Drizzle con el esquema de Catálogo. Los repositorios de
lectura/escritura y `CatalogTransactionManager` reutilizan ese provider. Los
métodos de escritura reciben la transacción del agregado en vez de abrir pools
o transacciones paralelas. Una transacción de escritura agrupa los cambios
locales; PostgreSQL conserva la aplicación de UNIQUE/FK/CHECK y los triggers
diferidos existentes. Los errores se exponen mediante `CatalogPersistenceError`
con una categoría interna segura;
el SQL, los parámetros y el texto del driver no se incluyen en mensajes.

Las 21 pruebas actuales de `postgres.persistence.e2e-spec.ts` usan PostgreSQL 17
efímero con TLS, role `catalog_app` y un schema ajeno de comprobación. Incluyen
persistencia, DATA-002, coordinación transaccional y fallos del pool; el caso
JOINT-01 utiliza además un RabbitMQ desechable. En local,
la suite se omite si Docker u OpenSSL no están disponibles. En CI, la suite falla
explícitamente en esas condiciones y no acepta una omisión como resultado
aprobado. La cobertura incluye persistencia, rollback/constraints, permisos y
violaciones NOT NULL. La suite no usa ni escribe en Supabase.

La [auditoría de #43 y #44](AUDIT-43-44.md) separa los resultados actuales,
la evidencia histórica y las dependencias pendientes. Las pruebas del esquema
comparan las columnas, tipos, nulabilidad, presencia de defaults y nombres de
todas las restricciones declarativas de las 13 tablas con la fixture oficial.
Los triggers y permisos se verifican mediante PostgreSQL, no mediante ese test
de metadatos.

El [bloque de auditoría #45/#46](AUDIT-45-46.md) documenta las reglas,
las ocho operaciones HTTP y los límites normativos que permanecen abiertos.

## Ejecución y pruebas

Desde la raíz, con configuración PG propia suministrada de forma segura:

```sh
npm ci
npm run build:catalog-svc
npm run start:catalog-svc
npm test -- apps/catalog-svc
npm run test:e2e -- apps/catalog-svc
npm test
npm run test:e2e
npm run build:all
npm run typecheck
npm run lint
npm run format:check
git diff --check
```

Las unitarias usan fixtures aislados para las invariantes de validación,
identidad, pool compartido, sanitización y timeout. Cubren el origen de Taxonomía
inyectado frente a un entorno distinto, construcción sin DI con el mismo
validador, UUID válido/ausente/inválido y 100 sondeos concurrentes más otros 100
tras el timeout sin acumular trabajo. No acreditan integración real.

`test/runtime-postgres.e2e-spec.ts` ejecuta el entry point compilado con PostgreSQL
17 descartable y TLS real cuando Docker está disponible. Comprueba arranque
positivo en `session` y `direct`, rechazo de identidad faltante, CA ajena y hostname
incorrecto, readiness 200 con el esquema oficial vacío y liveness 200/readiness
503 al detener la base. No sustituye Database ni el cliente PG. Requiere Docker y OpenSSL; en
este equipo sin Docker se informa como omitida, no como PASS de integración.
En GitHub Actions Docker está disponible y la suite se ejecuta normalmente.

El workflow compartido mantiene además su prueba independiente Marketplace con
PostgreSQL, TLS, JWT, indisponibilidad y recuperación. No se modifica ni se omite
para aprobar este PR. El SHA, enlace al run y resultados reales se registran en
la descripción del PR #119 después de completar CI. No inferir despliegue,
homologación externa ni aceptación de otros módulos a partir de esos resultados.

## Bloques 1 y 2: consultas, mutaciones y mensajería

El detalle por operación, evidencia, autorizaciones y pendientes está en
[AUDIT-BLOCKS-1-2.md](AUDIT-BLOCKS-1-2.md). Incluye los ocho operationIds de
consulta y los doce de mutación. El estado integral es PARTIAL; las políticas
comerciales/barcode y algunos handlers GenericData siguen aislados.

Las altas usan PEN y slug estable de nombre normalizado seguido del UUID completo,
según aprobación expresa del owner. Las variantes requieren SKU explícito por
ahora; omitirlo no genera una identidad comercial arbitraria.

Configuración adicional (suministrar secretos fuera del repositorio):

- `RABBITMQ_URL`: AMQP(S), usuario/contraseña y vhost `g6-productos-ofertas`.
  Si no se configura, el transporte no arranca y los mensajes quedan en Outbox.
  Con URL configurada el runtime también permanece bloqueado y emite
  `AMQP_RECOVERY_BLOCKED`: AsyncAPI 0.6.0-rc.3 no aprueba ni aprovisiona
  retry/DLX. No conecta, consume, ACKea ni publica pendientes en el broker
  compartido. HTTP y las transacciones locales siguen independientes.
  La inyección `isolatedTestRecovery: true` solo funciona con NODE_ENV=test
  en pruebas desechables; ninguna variable de entorno habilita ese ensayo.
  Nombres físicos del cliente: `po.comandos.x`, `po.eventos.x`,
  `po.resultados.x`, `po.catalogo.q`. Ver [auditoría #48](AUDITORIA-48.md).
- `CATALOG_AMQP_PRODUCER_USERS`: objeto JSON que asocia `pricing-svc`,
  `inventory-svc`, `taxonomy-svc` y `bulk-svc` a usuarios broker distintos entre sí
  y del usuario Catálogo. Se valida `user_id` de RabbitMQ; requiere permisos
  acordados de infraestructura, no un header de productor sin autenticar.
- `CATALOG_PREPARATION_TIMEOUT_MS`: entero positivo aprobado para permitir
  recuperación manual de PENDING vencido después de published_at. Si se omite,
  ese reintento no se habilita. Valor aprobado para desarrollo integrado/staging
  y local con AMQP real: `300000` (5 minutos), desde publicación confirmada del
  intento vigente. Ver `runtime.integrated.env.example`. En producción mantener
  sin configurar hasta completar homologación. Todo REJECTED tiene
  `manual_retry_allowed=false`; editar datos locales no lo habilita. COMPLETED
  siempre es terminal.

El runtime no declara recursos en RabbitMQ. Usa la topología aprovisionada;
confirms, alternate exchange y entrega al consumidor son evidencias diferentes.
Las suites PostgreSQL y RabbitMQ crean una instancia desechable por suite;
necesitan Docker y, para PostgreSQL TLS, OpenSSL. Nunca apuntarlas a servicios
compartidos. La suite HTTP aísla casos de uso y no acredita integración real.

## Auditoría correctiva y bloque 3

Estado actual de las decisiones 4–9 y sus límites:
[RESOLUCION-PUNTOS-4-9.md](RESOLUCION-PUNTOS-4-9.md). La corrección Q-06 requiere
la migración aditiva `0003_product_publication_history.sql`, aplicada por el
proceso oficial antes de habilitar las mutaciones de esta versión. El bootstrap
no ejecuta SQL de migraciones. Los históricos quedan en NULL, nunca en false por
backfill. Se exige SKU explícito en toda alta de variante.

Las barreras CATEGORY/BRAND/PRODUCT_TYPE/CHARACTERISTIC_VALUE comparten locks
transaccionales con las escrituras. CLEAR no libera; solo un final coincidente
por operación, identidad y versión lo hace. PRODUCT_TYPE_CHARACTERISTIC instala
una barrera no resuelta, no emite CLEAR y no se libera sin correspondencia
verificable. Hasta homologarla, nuevas dependencias se rechazan conservadoramente;
lecturas, bajas y ediciones independientes permanecen disponibles. Un diagnóstico
periódico informa barreras pendientes de final sin liberarlas por timeout.
Los payloads Bulk siguen pendientes; no hay un consumidor alternativo que omita
estas reglas. Los cambios de contratos de Docs se entregan como parches en
`contracts/`; no se publican ni se consideran homologados automáticamente.

[AUDIT-BLOCK-3.md](AUDIT-BLOCK-3.md) registra la causa del smoke Marketplace,
las correcciones autorizadas, observabilidad, pruebas de fallos y la matriz de
integración real. Los logs HTTP omiten URL/query/body/headers; los indicadores
internos cuentan señales de transporte/Inbox/Outbox sin crear una API pública.
La cancelación remota del consumidor dispara reconexión; el shutdown tiene un
plazo de cinco segundos para cerrar transporte y drenar entregas, sin afirmar
cancelación de transacciones en curso.

`gateway-catalog.provider.e2e-spec.ts` ejecuta Gateway y Catálogo reales en
loopback: acredita la incompatibilidad demo/Bearer mediante 401, no CRUD React.
`postgres.persistence.e2e-spec.ts` agrega JOINT-01 (PostgreSQL TLS + RabbitMQ +
Outbox/Inbox reales), timeout/rollback y saturación de pool. Son 15 casos en esa
suite, con una instancia de cada infraestructura; no apuntan a Supabase.

La configuración adicional SECURITY_* y la CA del smoke, junto al discovery del
emisor efímero de CI, se modifican con autorización expresa. No se desactiva JWT,
no se cambia la aserción 400 y no se inventa una política de confianza demo.

## Fuentes históricas

- [Issue #43](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/43).
- [Arquitectura §§7, 23–25](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/Arquitectura.md).
- [Guía PG del proyecto](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ops/postgres-runtime/guia-desarrollo-local.md).
- DEC-F-001 y -011 delimitan identidad y perfil físico; DEC-F-012 exige distinguir
  contrato, implementación local, integración autenticada y despliegue.

## Integración Marketplace H4

**Corte de evidencia:** rama personal `poma`, HEAD `a81f2d5fa735d7353b5df0ec0f095abac489e5d3`; PR #125 abierto, no integrado. CI del SHA exacto consultada el 2026-10-20: PASS (workflow principal y Taxonomy PostgreSQL desechable). No se infiere despliegue, grant G7 ni E2E G1.

### Operaciones Catalog

- `listarProductos` — `GET /api/v1/productos`: listado/búsqueda comercial bajo `canal=MARKETPLACE`; validar `q`, paginación, categoría/marca solo según OpenAPI y elegibilidad desde la proyección autorizada.
- `obtenerProductoPorSlug` — `GET /api/v1/productos/por-slug/{slug}`: ficha por slug; mantener `product_id`, `slug`, `variant_id`, `sku` y `sku_base` separados. Un producto simple usa `sku_base`; un producto con variantes publica solo SKU elegibles. Nunca deducir SKU desde IDs ni devolver variantes administrativas inactivas.
- Filtros múltiples de categoría/marca y precio: no afirmar paridad si el OpenAPI G6 vigente no los expone. No aplicar un filtro global únicamente sobre una página parcial.
- Las pruebas `commercial.e2e-spec.ts` usan repositorio/Taxonomy sustituidos por fixtures aisladas: evidencian comportamiento HTTP/controlado, no PostgreSQL integrado, llamada BFF G1, grant ni E2E comercial externo.

### Cierre de integración

Leer [paquete operativo H4](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/castilla/integraciones/g1-marketplace/README.md), [matriz](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/castilla/integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md), [Acuerdo G1–G6](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/docs/g1-marketplace-homologacion-lote03/integraciones/ACUERDO_G1_G6_H4_2026-10-20.md) y operationId OpenAPI. M-01–M-09 están `ACEPTADO_G6_COMUNICADO_G1`; esto permite implementar reglas Catalog propias. La elegibilidad comercial requiere prueba provider con datos identificados; no confundir fixtures contractuales, base PostgreSQL aislada, Supabase o Oracle. Cierre mínimo: provider de listado vacío/elegible/no elegible, slug simple con SKU base, variantes con SKU distinto de `variant_id`, campos comerciales y JWT/scopes; ligar resultados al SHA exacto.
