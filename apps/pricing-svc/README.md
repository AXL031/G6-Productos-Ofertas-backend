# pricing-svc — configuración y persistencia (#52, #53)

## Actualización 2026-11-02: contexto Catalog y canales (#24/#55/#56)

Este corte sustituye las restricciones históricas de UUID/canales y ausencia
de adaptador Catalog descritas abajo. Fuentes: Docs
`783a60efa5772548fce66ef63198e17361d8460b`, OpenAPI 0.6.0-rc.2,
AsyncAPI 0.6.0-rc.4, SPEC-013, DEC-F-006 y DEC-G6-INT-01/04/13.

- Canales textuales MARKETPLACE, CHATBOT, RETAIL, VENTAS; global null.
  Se elimina PRICING_CHANNEL_IDS. GET conserva fallback global; PATCH/POST
  rechazan UUID y canales desconocidos antes de persistir.
- modulo-productos con precios:leer puede usar consultarPrecios y obtenerPrecioSku;
  sus permisos no se extienden a operaciones administrativas.
- PRICING_CATALOG_CONTEXT usa CatalogContextHttp: GET privado
  /api/v1/productos/skus/{sku}/contexto, SKU codificado sin alterar identidad,
  DTO y flags validados; solo 404 SKU_NO_ENCONTRADO se convierte a null.
  Otros fallos resultan en 503 para el consumidor de Pricing.
  Timeout HTTP 2 s, JSON máximo 64 KiB, sin redirects.
- PRICING_CATALOG_URL es un origen HTTPS sin path/credenciales/query.
  HTTP solo hacia catalog-svc en demo explícita o loopback en test.
  En demo se omite Authorization y no se consulta G7. La activación sigue
  requiriendo aislamiento privado verificado; esta entrega no activa el modo.
- En autenticado, configurar AUTH_ISSUER/AUTH_JWKS_URL y el par opcional
  PRICING_SERVICE_TOKEN_URL / PRICING_SERVICE_CLIENT_SECRET. Endpoint del
  mismo origen del issuer, ruta /api/v1/auth/token, HTTPS salvo test loopback.
  Se solicita client_credentials de modulo-productos con catalogo:leer;
  nunca se reenvía el bearer entrante. Respuesta G7 limitada a 64 KiB/1 s;
  JWT verificado con RS256/JWKS/issuer/exp/audience/tipo/sub/scope. Caché hasta
  el mínimo de exp y expiresIn, con margen de 5 s. JWKS conserva timeout 2 s.
  Sin configuración o dependencia disponible, se falla cerrado con 503.

G7: Modulo-de-Seguridad `6045c013fd454cff998169bd1b114323324cda72`,
emitirTokenServicio/TokenServicio. Firmas de fixture no acreditan grants reales.
Ver [evidencia y pendientes](REVISION-PRICING-2026-11-02.md).

## Entrega Vera 2026-10-23: #24 y #55–60

Esta sección actualiza el estado del candidato; las secciones siguientes son
evidencia histórica de sus SHA. Rama `vera` sincronizada con
`origin/master@0b4e385` mediante merge normal. No se acredita Oracle ni E2E real.

| operationId / alcance | Estado del candidato |
|---|---|
| consultarPrecios; obtenerPrecioSku (#24/#55) | Handlers GET, resolver propio, parámetros SKU/canal/instante y JWT humano/servicio. Provider HTTP/DB probado con contexto Catalog de fixture; sin integración productiva de Catalog. |
| obtenerPrecioBaseProducto; listarProgramacionesPrecioProducto; listarProgramacionesPrecioSku; obtenerImportacionPrecios (#55) | Lecturas existentes conservadas. |
| prevalidarImportacionPrecios; descargarReporteImportacionPrecios (#55) | Sin implementación: P-PRI-01 formato/política de importación sin aprobar. No se inventan parser, cabeceras ni reporte. |
| actualizarPrecioSku; actualizarPrecioBaseProducto; programarPrecioSku; programarPrecioBaseProducto (#56) | Controladores usan mutaciones existentes, versión/conflictos y Outbox transaccional. Por defecto 503 sin autorizer G7 y factory aprobados; fixtures explícitas prueban HTTP/SQL, actor no viene del body. |
| crearImportacionPrecios (#56) | Sin implementación por P-PRI-01. No se fabrica admisión 202 ni procesamiento masivo. |
| pricing.price.changed (#57) | Relay real con confirms, mandatory/rutas, persistencia y replay del mismo message_id. Solo envelope, no se inventa GenericData. P-PRI-02 sigue abierto. |
| Otros eventos/commands candidatos de #57 | Inicialización, bulk y catalog.sku.deactivated no tienen nuevos handlers en esta entrega; requieren completar su caso de uso/acuerdo por operación. No se presentan como implementados por existir el relay. |
| Resiliencia (#58) | Fallos DB/broker, confirm sin ruta, rollback después del confirm, relays concurrentes, reconexión y logs sanitizados probados aisladamente. No se promete exactly-once ni homologación productiva. |
| React/Gateway (#59) | Provider preparado; Frontend #45/PR #47 y Gateway #21 pendientes de integración real. No se modificó frontend. |
| Recorrido completo (#60) | Segmentos HTTP/SQL/Outbox y broker probados; falta React/Gateway/contexto Catalog/grant G7 y payload acordado. No se declara E2E comercial. |

PRICING_CATALOG_CONTEXT es un puerto interno sin provider productivo implícito.
Debe resolver producto/variante, SKU, estado y elegibilidad desde Catalog/Poma.
No hay SQL cruzado ni endpoint inventado. Ausencia real usa el único 404 publicado
PRECIO_NO_ENCONTRADO; fallo/ausencia de provider devuelve 503, no lista vacía.
Batch omite solo ausencia contractual de precio, propaga otros errores. Se
requiere mapping aprobado PRICING_CHANNEL_IDS entre enum comercial y UUID canónico;
el nombre del canal no se usa como UUID. Precio vigente devuelve versión de la
definición para CAS; consulta histórica explícita devuelve versión del snapshot.

PRICING_WRITE_AUTHORIZER y PRICING_FACT_FACTORY son ports internos sin defaults
productivos. Vera/Marco/G7 deben implementar introspección/autorización mutante y
Marco/Vera/consumidores acordar P-PRI-02 antes de habilitar escrituras. La factory
recibe estado antes/después dentro del lock; fallo revierte toda la transacción.
JWT firmado de lectura no sustituye autorización mutante/introspección. Incluso
con el bypass demo previo, no se permiten escrituras sin esos dos providers.

PRICING_AMQP_URL es opcional. AMQPS obligatorio salvo loopback dev/test,
heartbeat 5 s; sin parámetros arbitrarios. Relay comprueba po.eventos.x, nunca
declara topología. Cada lote bloquea hasta 10 pendientes con skip-locked,
publish durable/mandatory/confirm y marca published_at después de confirmar ruta.
Fallo no descarta; attempts/last_error sanitizado y readiness permiten observarlo.
Un rollback DB después del confirm puede repetir message_id: Inbox del consumidor
debe deduplicar. Sin URL no se activa el worker ni dependencia AMQP.
Topología/ACL/red Oracle y retry/DLX: Marco/#29/#110, aprobación y prueba real
separadas. No se publica a un broker compartido desde los tests.

Fuentes de este corte: Docs oficial master
`1ee0d9e5a788dbe559a376bf96a60c6117af3956`: SPEC-013, OpenAPI, AsyncAPI,
modelo Pricing y DEC-F-001/006/009/012. Paquete operativo
`integraciones/g1-marketplace/{README,MATRIZ_OPERACIONES_H4,PRUEBAS_Y_EVIDENCIAS_H4}.md`
de master y acuerdo/alineación Docs PR #94
`a8d89296b0eac37315ef30a9390f1e4e30933136` leídos; coinciden en identidades
separadas, precio por SKU/canal/vigencia y JWT servidor a servidor por scope.
No se atribuye grant real a JWT firmados por la fixture.

Pruebas y dependencias compartidas autorizadas: ver
[evidencia reproducible Price Audit](../price-audit-svc/README.md#pruebas-reproducibles).
Resumen local: 662 unitarias PASS; 432 E2E PASS y 37 omitidas de otros servicios;
typecheck general y estricto de fuentes/tests, lint y builds propios PASS.
CSV/PDF y consumidor Audit tienen pruebas separadas; no convierten segmentos
aislados en el recorrido React→Gateway→Pricing→Audit.

No se cierran automáticamente #24/#55–60: faltan sus criterios de integración
documentados. Owner/condición: Poma/Vera contrato Catalog y provider probado;
Marco/Vera formato P-PRI-01; Marco/Vera/consumidores payload P-PRI-02;
Marco/G7 introspección/grant; Marco/Gateway/Frontend #45 composición y recorrido
con SHAs y token/dataset reales; Marco aprobación individual Oracle #111.

Owner: Leonardo Vera, rama `vera`. Alcance operativo: `IMPLEMENTAR_AHORA`.

**Entrega interna #13, #24, #55–#60:** consultas administrativas, autenticación
de lectura y casos de uso transaccionales parciales. La trazabilidad por issue,
evidencia y fronteras pendientes están en [AUDIT-OPEN-ISSUES.md](AUDIT-OPEN-ISSUES.md).
Las secciones #52–#54 conservan la evidencia histórica de sus entregas.

## Configuración y ejecución

Se conservan los scripts del monorepo: `npm run build:pricing-svc`,
`npm run start:pricing-svc` y `npm run start:dev:pricing-svc`.
Usar la versión de Node indicada en `package.json`. El ejecutable carga `.env`
de la raíz si existe; las variables de la sesión tienen precedencia.

| Variable | Descripción | Obligatoria |
|---|---|---|
| `NODE_ENV` | Entorno: `development`, `test` o `production`. | Sí |
| `PRICING_SVC_PORT` | Puerto HTTP entero entre 1 y 65535; prioridad sobre `PORT`. Puerto asignado a Pricing: 3002. | Sí, salvo que exista `PORT` |
| `PORT` | Alternativa cuando no se define el puerto propio. No sustituye un puerto propio inválido. | Condicional |
| `DATABASE_URL` | Conexión PostgreSQL directa/pooler para el rol runtime de Pricing, con host, usuario y base. Inyectar desde la sesión o gestor de secretos. | Sí |
| `PGSSLMODE` | Alternativa al parámetro `sslmode` de la URL. Se exige `verify-full` en producción y para hosts remotos. | Condicional |
| `PGSSLROOTCERT` | Ruta a la CA PEM del proveedor; alternativa a `sslrootcert` en la URL. Si se declara, debe existir y ser un certificado válido. | Para CA no incluida en la confianza de Node |
| `AUTH_ISSUER` | Issuer exacto del JWT humano de G7. | Para readiness y consultas en modo autenticado |
| `AUTH_JWKS_URL` | URL HTTPS configurada de claves públicas. Nunca se obtiene del JWT. | Junto con `AUTH_ISSUER`, en modo autenticado |
| `GATEWAY_DEMO_NO_AUTH_ENABLED` | `true` solicita explícitamente demo sin JWT/G7; ausente o `false` conserva autenticación. En `production` exige la segunda confirmación. | No, predeterminado `false` |
| `PRICING_DEMO_PRODUCTION_CONFIRMED` | `true` confirma excepcionalmente demo en `production`, únicamente si el flag anterior también es `true`. Por sí sola no activa demo. | Solo para demo en producción; predeterminado `false` |

Para la demo, inyectar `GATEWAY_DEMO_NO_AUTH_ENABLED=true` tanto al Gateway
como a Pricing en su entorno privado de demo. Pricing ignora Authorization y
la configuración G7 en ese modo; conserva consultas reales, validación,
correlación y errores. El flag no cambia `NODE_ENV`, TLS ni permisos PostgreSQL.
Reiniciar con el flag ausente/`false` restaura JWT/JWKS y rol; no hay detección
automática de demo ni activación por falta de credenciales.
En `NODE_ENV=production`, ambos flags deben ser exactamente `true`; sin la
segunda confirmación el proceso rechaza la configuración antes de arrancar.
En `development`/`test` no se exige esa segunda confirmación. Ambos flags
rechazan valores distintos de `true`/`false`. La excepción conserva TLS
`verify-full` y todas las validaciones PostgreSQL. El responsable del despliegue
verifica exposición privada, aislamiento de datos y permisos mínimos antes
de activarla; este cambio no activa ni despliega la excepción en Oracle.

No hay valores implícitos para variables obligatorias. Configuración ausente o
malformada impide crear Nest/abrir el listener y termina con código 1. No se
imprime el valor rechazado. Los errores al cargar `.env` o abrir el listener
también se informan con un mensaje fijo sin el error original.
Se exige `sslmode=verify-full` en producción, incluso en localhost. También se
exige para hosts remotos en desarrollo/test. Se rechazan modo ausente,
`disable`, `allow`, `prefer`, `require`, `verify-ca` y `no-verify` en esas conexiones.
Solo localhost/loopback fuera de producción admite modo ausente o `disable`
para pruebas aisladas. Una URL admite únicamente `sslmode` y `sslrootcert`,
sin duplicados ni overrides del host/SSL. Antes de crear el pool se eliminan
esos parámetros y se pasa TLS explícito con `rejectUnauthorized: true` y
`checkServerIdentity` de Node; el parser de pg no puede sustituir esa política.
La CA configurada se valida y carga al arrancar. Si no se declara, se utiliza
la confianza de Node; una CA no confiable falla la conexión, sin fallback.
También se rechaza validación TLS global desactivada. No usar credenciales owner/deployer, claves del
frontend ni acceso a schemas ajenos. No se cambia exposición de puertos.

## Sondas operativas

| Ruta | Significado | Resultado |
|---|---|---|
| `GET /health` | Liveness existente, preservado para infraestructura. | 200, `status=ok` |
| `GET /health/live` | Liveness de Arquitectura §25; no consulta dependencias. | 200, `status=ok` |
| `GET /health/ready` | Disponibilidad de PostgreSQL y lectura de `pricing.prices`. | 200, `status=ready`; 503, `status=not_ready` |

Todas las respuestas identifican `service=pricing-svc`. Readiness ejecuta
una consulta `LIMIT 0` sobre `prices`, `price_validities`, `scheduled_prices`,
`bulk_price_jobs`, `bulk_price_rows` y `outbox` del schema propio. Comprueba
conexión y permisos de lectura sin obtener filas ni escribir datos. Una base
caída, tabla ausente o permisos insuficientes produce 503 en ambos modos;
configuración de identidad ausente produce 503 solo en modo autenticado.
Liveness sigue en 200. No acredita grants de escritura ni
disponibilidad remota de G7; readiness no consulta JWKS por request.
El pool limita conexiones a 2 y tiempos de conexión/consulta a 2 segundos
cada uno; se libera al cerrar la aplicación y en señales de apagado de Nest.
No hace fan-out a otros servicios. Broker no es dependencia de este scaffold:
no hay consumers, relay ni operaciones de negocio implementados en #52.

## Logging y fuentes

Logs JSON con servicio y entorno. No se registran configuración, requests,
objetos, errores/stack originales ni payloads. El logger solo acepta una lista
cerrada de mensajes técnicos internos y contextos controlados. Redacta cualquier
otro mensaje, argumento o entorno, aunque sea texto sin prefijos reconocibles.
No usa expresiones regulares para decidir qué contenido es seguro. Mantiene
timestamp, nivel, servicio y entorno validado; las pruebas verifican stdout y
stderr con secretos ficticios arbitrarios. Añadir mensajes exige revisar la lista.

Fuentes oficiales consultadas en `Taller-SW-Web/G6-Productos-Ofertas-docs`
(master `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`):
[Arquitectura §§24–25](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/Arquitectura.md),
[SPEC-013](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/requisitos/specs/SPEC-013-gestion-precios-individuales-masivos.md),
HU/FLOW-013 y `datos/pricing/physical-model.md`.
Se revisaron registro DEC-F, trazabilidad y matriz intermodular: DEC-F-006
delimita la autoridad de Pricing; DEC-F-001 aporta la identidad SKU y DEC-F-012
la gobernanza contractual. Sus reglas de negocio quedan fuera de este bloque.
OpenAPI `0.6.0-rc.1` y AsyncAPI `0.6.0-rc.2` son candidatos consultados en master;
no se modifican contratos ni se infiere homologación externa.

## Validación y límites de evidencia

Pruebas enfocadas: `npm test -- apps/pricing-svc` y
`npm run test:e2e -- apps/pricing-svc`. Cubren configuración, errores sanitizados,
sondas independientes, recuperación simulada y PostgreSQL local inaccesible.
Los dobles de prueba se inyectan solo en tests, nunca en ejecución normal.
Implementación local no equivale a integración PostgreSQL/Supabase autenticada,
homologación, despliegue ni cierre del issue: requieren evidencia separada.

Evidencia local del 2026-10-16, Node 24.19.0: `npm test` pasó 159 pruebas;
`npm run test:e2e` pasó 337 y omitió 13 por condiciones de entorno.
`npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run build:pricing-svc` y `git diff --check`: PASS.
Smoke del ejecutable con fixtures locales: liveness 200, readiness 503 ante
PostgreSQL inaccesible, logs JSON sin la credencial ficticia; configuración
inválida termina con código 1 sin mostrar el valor rechazado. El caso ready
200 está probado con doble inyectado, no con PostgreSQL autenticado real.

### Correcciones de auditoría del PR #121

Se añadieron pruebas de producción sin TLS, modos inseguros, CA ilegible/inválida,
overrides del parser de pg y secreto arbitrario sin etiquetas en stdout/stderr.
Pricing: 55 unitarias y 3 E2E aprobadas. El smoke del ejecutable en producción
con `verify-full` y DB inaccesible mantuvo health/live=200 y readiness=503;
sin TLS, con `disable` o con `require` terminó con código 1 sin filtrar el secreto.
Regresión general de la rama: 180 unitarias aprobadas; 337 E2E aprobadas y
13 omitidas por condiciones de entorno. Typecheck, lint, formato, build de
Pricing y revisión de whitespace: PASS. La integración con master se verifica
adicionalmente en el commit de merge de GitHub y en el CI del mismo PR.

Prueba autenticada de solo lectura con las credenciales runtime existentes:
rol esperado confirmado, transacción READ ONLY, consulta sin filas a
`pricing.prices`, TLS 1.3 autorizado y `/health`, `/health/live`, `/health/ready`
en 200. Sin mutaciones, cambios de credenciales, grants ni configuración Supabase.
La confianza de Node sola rechazó la cadena del proveedor; con la CA oficial,
certificado y hostname se verificaron correctamente. La CA se descargó a un
archivo temporal y se eliminó al terminar; no se modifica `.env` ni se incorpora
ningún certificado al repositorio. La ruta de CA declarada en el `.env` local no
existe en este equipo: para operar debe provisionarse una ruta válida.

Fuente de CA: URL de producción publicada por
[Supabase Studio](https://github.com/supabase/supabase/blob/7425d4930528931400fb3e656e860b1094cb224e/apps/studio/hooks/custom-content/custom-content.json).
SHA-256 del certificado: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.
La integración autenticada puntual no acredita homologación ni despliegue.

## Persistencia Drizzle (#53)

Alcance operativo: `IMPLEMENTAR_AHORA`, exclusivamente `apps/pricing-svc`.
Prerrequisito #52: [PR #121 fusionado](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/121).
Base de implementación: `79a03c02f82722c599a9963b7340c088eba8f5b4`, rama `vera`.

`PricingDatabase` mantiene un único pool runtime para Drizzle y readiness,
con cierre por el ciclo de Nest. Conserva TLS validado, límites y timeouts
del bloque #52; fija `search_path=pg_catalog,pricing` y desactiva logging SQL.
`PricingRepository` se inyecta/exporta desde el módulo. Consulta definiciones
por producto **o** SKU y canal exacto (incluido global), y snapshots por definición.
No resuelve herencia/fallback ni consulta Catálogo.

`transaction(callback)` entrega un `PricingTransaction` tipado para insertar
o actualizar snapshots, programación, lotes y mensajería dentro del mismo
commit. El caller debe incluir el hecho Outbox y, cuando corresponda, Inbox
en esa transacción. No hay publicación al broker ni eventos fabricados por
triggers. La suite demuestra commit/rollback conjunto y CAS concurrente;
el caso de uso deberá convertir cero filas actualizadas en `VERSION_CONFLICT`.
Los errores DB se convierten en `PricingPersistenceError` con mensaje fijo y
SQLSTATE cuando existe, sin SQL, parámetros, credenciales, detalle ni causa
original. Los errores propios del callback conservan identidad tras rollback.

### Mapping y fuente del DDL

`src/persistence/pricing.schema.ts` mapea las siete tablas de
[`datos/pricing/physical-model.md`](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/pricing/physical-model.md):

| Elemento | Tabla |
|---|---|
| Definición y versión | `pricing.prices` |
| Snapshot monetario y vigencia | `pricing.price_validities` |
| Programación vinculada a snapshot | `pricing.scheduled_prices` |
| Lote local y filas durables | `pricing.bulk_price_jobs`, `pricing.bulk_price_rows` |
| Mensajería transaccional | `pricing.outbox`, `pricing.inbox` |

Versiones `bigint` permanecen `bigint` de JavaScript; importes `numeric(12,2)`
permanecen strings decimales. El encoder monetario rechaza más de dos decimales,
desbordes y valores no decimales antes del cast de PostgreSQL para evitar
redondeo silencioso. Positividad, oferta, coherencia temporal y demás checks
siguen en el SQL normativo.

El mapping declara PK, UNIQUE (incluido NULLS NOT DISTINCT), FK internas,
checks e índices. No genera/aplica DDL ni sustituye la exclusion GiST o los
triggers diferidos de la migración oficial. No hay segundo historial de
migraciones en backend. `test/fixtures/pricing.sql` es una copia de prueba del
[SQL oficial](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/pricing/migrations/0001_create_pricing.sql),
sin cambios de contenido. SHA-256 con saltos LF:
`7f440ffa401e8d56ecb2664060edb131505a16b8568843093a5047a6c13bc581`.
La suite verifica ese checksum antes de ejecutarlo.

Se consultaron Arquitectura §§7/9/16, Modelo Conceptual §5, SPEC/HU/FLOW-013,
registro y matrices DEC-F e intermodular del mismo commit documental.
Aplican DEC-F-001 (identificadores externos), 006 (autoridad, versión y vigencia),
009 (Inbox/Outbox e identidad de transporte, sin prometer idempotencia de negocio
completa) y 012 (fuentes/versionado/migraciones inmutables).
OpenAPI `0.6.0-rc.1` y AsyncAPI `0.6.0-rc.2` siguen candidatos sin cambios.
El payload genérico de los hechos no se concreta en este bloque.
Referencias de implementación: [tipos PostgreSQL](https://orm.drizzle.team/docs/column-types/pg)
y [transacciones Drizzle](https://orm.drizzle.team/docs/transactions).

### Reproducción de pruebas aisladas

Requiere Node compatible con `package.json`, dependencias instaladas y Docker
activo con contenedores Linux. No requiere `.env`, credenciales compartidas,
un proyecto Supabase ni una URL de base de datos externa.

```powershell
npm test -- apps/pricing-svc
$env:PRICING_TEST_POSTGRES = '1'
npm run test:e2e -- apps/pricing-svc --reporter=verbose --silent=false
Remove-Item Env:PRICING_TEST_POSTGRES
```

La suite crea una instancia PostgreSQL por suite, no por test, con imagen fijada:
`postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`.
Si falta localmente, Docker debe poder descargarla. Solo el puerto aleatorio de
la fixture se publica en loopback; no se publican servicios internos ni broker.
La preparación de roles/ACL y extensión ocurre exclusivamente en ese contenedor.
Las operaciones del repositorio usan `pricing_app`, sin membresía owner.
Al terminar se cierran conexiones y se elimina el contenedor con sus volúmenes.
No se aceptan URLs externas para preparar fixtures, ni se escriben datos,
credenciales, grants o policies de Supabase.

Sin `PRICING_TEST_POSTGRES=1`, las 13 pruebas PostgreSQL se marcan omitidas;
esa ejecución no acredita persistencia. Con la variable activa, falta de Docker,
errores de fixture o de permisos hacen fallar la suite. El workflow compartido
no se modifica en este issue; la evidencia local siguiente sí activa la suite.

### Evidencia local del 2026-10-17

Entorno: Windows, Node `24.19.0`, Vitest `4.1.11`, PostgreSQL `16.15` real en
Docker. Sin conexión ni escritura a Supabase durante #53.

| Comando | Resultado |
|---|---|
| `npm test -- apps/pricing-svc` | PASS: 71 unitarias |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e -- apps/pricing-svc` | PASS: 16 E2E, incluidas 13 PostgreSQL; sin omitidas |
| `npm test` | PASS: 196 unitarias |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e` | PASS: 350 pruebas; 13 omitidas preexistentes de otras suites por entorno |
| `npm run typecheck` | PASS |
| TypeScript estricto de las nuevas pruebas de repositorio y E2E | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm run build:pricing-svc` | PASS |
| `git diff --check` | PASS |

Las pruebas PostgreSQL comparan todas las columnas/tipos/nullabilidad y las tres
FK internas; verifican UNIQUE, precisión monetaria, XOR de objetivo, intervalos,
CAS con dos conexiones, coherencia de programación/lotes, deduplicación y
rollback de precio/Inbox/Outbox, incluido fallo diferido en COMMIT. Se comprueban
SELECT/INSERT/UPDATE efectivos por tabla y denegación de DELETE/TRUNCATE/DDL,
UPDATE a Inbox, lectura de otro schema y SET ROLE al owner.

Implementación interna y pruebas locales: completadas. Provider y readiness
contra PostgreSQL aislado autenticado: comprobados. Integración compartida
Supabase, homologación externa y despliegue de #53: no ejecutados. El cierre
del issue requiere revisión/aceptación y PR fusionado según su definición de
terminado. No se agregan endpoints, handlers, workers, parser ni resolver del #54.

## Reglas puras del dominio (#54)

Prerrequisito #53: [PR #127 fusionado](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/127)
en `9866ff26a8ff542b802ae39775db2e0326c623fb`. Base de trabajo en `vera`:
`41815e8998230973b4c4e55abeb58001a10023c1`. El issue #53 sigue abierto;
no se altera su estado administrativo.

`src/domain/` contiene funciones puras, sin Nest, SQL, red ni estado global.
Reciben contexto y reloj explícitos y devuelven decisiones/planes; no producen
escrituras ni publicaciones. Sus interfaces son internas, no nuevos DTOs de red.
Importes permanecen strings y se comparan en centavos `bigint`, dentro de
`numeric(12,2)`; versiones conservan precisión hasta el límite bigint de PostgreSQL.

| Fuente normativa | Regla y prueba |
|---|---|
| SPEC-013 §3; HU CA-02–04 | `initializeProduct`: producto/global, `ALTA_PRODUCTO`, versión 1, `CREACION`, anterior/variación nulos; precio/contexto/fecha inválidos se rechazan. `sku_base` no crea override. |
| SPEC §5; FLOW §4.3; HU CA-08 | `changePrice`: versión esperada obligatoria, incremento unitario, oferta conservar/establecer/eliminar y `RETIRO_OFERTA`, motivo/actor; rechazos por CAS, importe, oferta y ausencia de vigencia. |
| SPEC §5; HU CA-09; modelo físico §§10/15 | Intervalos `[inicio,fin)`, adyacencia válida, solapamiento rechazado, canceladas excluidas. La programación exige inicio estrictamente futuro y asigna versión sin exigirla al cliente. |
| SPEC §2; HU CA-06–07; DEC-F-001/006 | `resolvePrice`: simple usa producto; variante busca override y después producto. Dentro de cada objetivo, canal específico y después global para la fecha solicitada. Sin precios sintéticos; conserva versión/origen del snapshot histórico. |
| SPEC §6; HU CA-10; modelo físico §§7/10 | `importDecision`: política parcial por fila o ninguna fila confirmable si falla alguna y `allow_partial=false`; estados y contadores coherentes, incluido lote vacío. Sin promesa de atomicidad remota. |
| DEC-F-009; modelo físico §§14/15 | Replay de inicialización compara contenido semántico y devuelve la aceptación anterior suministrada por el caller; contenido distinto da conflicto. Estados terminales no reviven; repetir resultado de fila es idempotente. |

Edición cierra la vigencia efectiva en el instante del cambio y conserva su fin
original en el nuevo snapshot, respetando futuras programaciones. Programación
cierra la vigencia abierta anterior; no recorta automáticamente intervalos
finitos que se solapen ni inventa restauración al finalizar una oferta.
Un cambio en el mismo instante de inicio se rechaza por solapamiento, evitando
un intervalo histórico vacío incompatible con el modelo físico.

La prueba PostgreSQL nueva aplica planes de inicialización, edición y
programación al repositorio real: versiones 1/2/3, cierres de intervalos,
actor/oferta, rechazo CAS y Outbox en la misma transacción. Su helper de
aplicación y payload vacío son **solo fixtures de prueba**, no un caso de uso
runtime ni un payload de negocio acordado.

### Fronteras y estados de evidencia

- `IMPLEMENTAR_AHORA`: decisiones internas de dominio y pruebas, terminadas.
- HTTP/mutaciones autenticadas: conexión a casos de uso, transacciones,
  locks/CAS y DTOs corresponde a #55/#56; no implementada aquí.
- Inbox/Outbox y relay: el caller debe cargar la aceptación por `operation_id`
  con control transaccional, persistir efecto/resultado/Outbox juntos y publicar
  después de COMMIT. Replay puro no es un ledger durable ni protege concurrencia
  por sí solo. La entrega real corresponde a #57.
- `BLOQUEADO_ESPECÍFICO`: concretar payload productivo de `pricing.price.changed`
  y archivo de importación. Owner: Leonardo Vera con Marco/arquitectura y
  consumidores para el evento; Leonardo Vera con Marco para formato/prevalidación.
  Desbloqueo: definición normativa verificable del payload y formato/política,
  respectivamente (P-PRI-01/02 del modelo físico). No se inventan campos de
  `GenericData` ni cabeceras CSV. No bloquea las reglas puras ya definidas.
  No hay cambios contractuales que comunicar/homologar.

Se consultó el repositorio **oficial remoto** `G6-Productos-Ofertas-docs`, master
`c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`: SPEC/HU/FLOW-013,
Arquitectura §16, modelo físico de Pricing, registro DEC-F, matriz de trazabilidad
y matriz intermodular. Aplican DEC-F-001/006/009/012; OpenAPI `0.6.0-rc.1`
y AsyncAPI `0.6.0-rc.2` candidatos, sin cambios ni aceptación externa atribuida.

### Evidencia local del 2026-10-17 (#54)

Node `24.19.0` (runtime temporal, sin cambiar dependencias), Vitest `4.1.11`,
PostgreSQL `16.15` en el contenedor aislado descrito en #53. Sin acceso a
Supabase, cambios de credenciales, grants/policies compartidos ni migraciones.

| Comando | Resultado |
|---|---|
| `npm test -- apps/pricing-svc` | PASS: 131 unitarias, 60 nuevas de dominio |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e -- apps/pricing-svc --reporter=verbose --silent=false` | PASS: 17 E2E, 14 PostgreSQL; cero omitidas |
| `npm test` | PASS: 256 unitarias |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e` | PASS en repetición: 351 aprobadas, 13 omitidas preexistentes de otras suites |
| `npm run typecheck` | PASS |
| TypeScript estricto de las tres suites de dominio y E2E | PASS, con `tsc --ignoreConfig --noEmit` y opciones estrictas equivalentes |
| `npm run lint`, `npm run format:check`, `npm run build:pricing-svc` | PASS |
| `git diff --check` | PASS |

La primera regresión E2E general tuvo `read ECONNRESET` en la prueba de
multipart/autorización de `api-gateway`; repetir el mismo comando sin cambios
pasó. No se modificaron pruebas ni código del gateway. El primer comando
TypeScript explícito requirió `--ignoreConfig` por TS5112 de TypeScript 6;
la ejecución corregida pasó sin errores de tipos.

Implementación interna y pruebas locales: comprobadas. Provider autenticado
aislado: comprobado. Contrato/provider HTTP y mensajería de negocio, integración
compartida autenticada, homologación externa y despliegue: no acreditados aquí.
HU CA-03/05 requieren flujo y publicación reales posteriores; Outbox local no
acredita entrega al broker. No se cierra #54 automáticamente.

## Integración G1 Marketplace H4 — brecha de precio por SKU

**Corte de código:** rama `vera`, HEAD `48afbf7a6845db4aaba6b58eb336396fa0e85ea7`. CI consultada para ese SHA: no se encontraron check-runs. No inferir CI, despliegue, grant G7 ni E2E. El historial previo de PR #132 o CI de commits anteriores no prueba este HEAD.

OpenAPI G6 publica `obtenerPrecioSku`, `GET /api/v1/precios/skus/{sku}` con `precios:leer` y audiencia `api-productos`; en este HEAD el `PricingReadController` no registra handler `GET skus/:sku`. Por tanto, es **CONTRATO_DEFINIDO / NO IMPLEMENTADO en este SHA**. La operación `GET /api/v1/precios` (consulta masiva) no sustituye el lookup por ruta individual, y las programaciones bajo `/skus/{sku}/programaciones` son otra operación.

Para implementar sin fabricar contexto, el provider necesita identidad autoritativa de Catalog para saber que el SKU es vendible/elegible y a qué producto corresponde; debe resolver canal aplicable, instante/vigencia efectiva y reglas de precio base/oferta, moneda y versión conforme al contrato. Si falta una entrada/campo o la composición padre/SKU no está definida, registrar brecha exacta en matriz, no inferir precio para padre con variantes. No agregar campos ni ruta alterna sin cambio de OpenAPI aprobado.

G1 consume desde su BFF con cliente técnico `modulo-marketplace`, audience `api-productos` y scope/allowlist de OpenAPI. El bypass `GATEWAY_DEMO_NO_AUTH_ENABLED` no es autenticación H4. Condición mínima: handler, tests Provider de SKU activo/inactivo/no elegible, canal y vigencia, respuesta/errores OpenAPI, identity/grant G7 comprobados aparte, CI del mismo SHA y después BFF/deploy/E2E separados. Consultar [matriz H4](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/castilla/integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md).
