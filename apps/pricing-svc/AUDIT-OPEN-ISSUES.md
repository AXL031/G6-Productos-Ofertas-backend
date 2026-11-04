# Entrega interna de Pricing para auditoría

Rama `vera`, entrega inicial `9e29481`, revisión de auditoría del 2026-10-17.
Owner: Leonardo Vera. PR #132 abierto para nueva auditoría, sin merge autorizado.
Alcance confirmado por el solicitante: trabajar lo interno; las definiciones
normativas pendientes corresponden a auditoría. Estado global: **PARTIAL**.

## Trazabilidad de los ocho issues abiertos

| Issue | Estado operativo y avance comprobable | Pendiente de cierre |
|---|---|---|
| [#13 DATA-003](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/13) | `IMPLEMENTAR_PARCIAL`: nueve checks existentes de hashes, referencias, importes, vigencias y herencia aprobados. No se propone nueva carga. | Reauditar publicación tras #12. La evidencia versionada anterior contiene borradores; no prueba el estado runtime actual. |
| [#24 SKU/canal](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/24) | `BLOQUEADO_ESPECÍFICO` para exposición comercial; resolver puro existente conservado. | Contexto autoritativo de Catálogo por SKU para producto/variante, estado y elegibilidad; no sustituirlo con SQL ajeno. |
| [#55 HTTP](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/55) | `IMPLEMENTAR_PARCIAL`: cuatro operationIds administrativos reales con JWT/JWKS, rol, paginación, errores y PostgreSQL. | `consultarPrecios`/`obtenerPrecioSku`: frontera de Catálogo. Prevalidación/reporte: P-PRI-01. |
| [#56 escrituras](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/56) | `IMPLEMENTAR_PARCIAL`: `PricingMutations.update/schedule` conecta dominio, locks/CAS, snapshots, programación y Outbox en una transacción. | Adaptadores HTTP, inicialización de nuevos overrides, payload aprobado, introspección e importación. |
| [#57 RabbitMQ](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/57) | `IMPLEMENTAR_PARCIAL`: persistencia atómica interna del hecho; no relay/consumer productivo nuevo. | P-PRI-02 y transporte AMQP autorizado. Inicialización tipada también exige producir el hecho de cambio. |
| [#58 robustez](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/58) | `IMPLEMENTAR_PARCIAL`: timeouts, JWKS acotado/cache con expiración, Problem sanitizado, correlación/duración/estado y readiness. | Fallos/reconexión/replay de broker al incorporar #57; retry/DLX productivo no acreditado. |
| [#59 React](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/59) | `IMPLEMENTAR_PARCIAL`: provider de las cuatro operaciones preparado y probado. | Feature `src/features/pricing` del frontend, cliente/config compartidos #109/Frontend #45 y stack coordinado. |
| [#60 E2E](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/60) | `IMPLEMENTAR_PARCIAL`: HTTP→PostgreSQL y casos de uso→PostgreSQL/Outbox reales con identidad firmada de prueba. | Recorrido React→Gateway→Pricing, RabbitMQ e identidad compartida. El nombre E2E del runner no acredita ese recorrido. |

No se usa `Closes` para estos issues. Ningún estado de integración, homologación
o despliegue se deduce de implementación interna ni de estas pruebas locales.

## Provider disponible

| Método y ruta | operationId OpenAPI |
|---|---|
| `GET /api/v1/precios/productos/{productoId}` | `obtenerPrecioBaseProducto` |
| `GET /api/v1/precios/productos/{productoId}/programaciones` | `listarProgramacionesPrecioProducto` |
| `GET /api/v1/precios/skus/{sku}/programaciones` | `listarProgramacionesPrecioSku` |
| `GET /api/v1/precios/importaciones/{batchId}` | `obtenerImportacionPrecios` |

El prefijo coincide con `originalUrl` reenviado por Gateway. Por defecto son
operaciones administrativas `userBearer`; exigen RS256, issuer configurado, clave RSA de
2048 bits mínimo, `tipo=acceso`, `sub` UUID, `iat/exp/nbf`, `jti` y rol
`GESTOR_COMERCIAL`. Sin token: 401; rol insuficiente: 403; JWKS/config ausente
o no disponible: 503. Sin configuración de identidad, readiness devuelve 503
en modo autenticado. No se confía en headers de identidad.

La corrección P0 autorizada de la auditoría incorpora la excepción explícita
`GATEWAY_DEMO_NO_AUTH_ENABLED=true` en Pricing, compatible con el flag del
Gateway. Por defecto está desactivada. En `development`/`test` basta ese flag;
en `production` también se exige `PRICING_DEMO_PRODUCTION_CONFIRMED=true`.
Si falta esa segunda confirmación, falla la configuración antes de arrancar.
La segunda confirmación por sí sola no activa demo y los valores inválidos
de cualquiera de los flags se rechazan. TLS/PostgreSQL siguen obligatorios.
En demo se ignoran Authorization y configuración de G7, sin llamadas JWKS,
pero se mantienen validación/correlación, errores y persistencia reales.
Readiness sigue comprobando PostgreSQL y devuelve 503 si falla. El flag debe
inyectarse explícitamente en ambos procesos de demo; no modifica infraestructura.
Con el flag ausente/`false` se restaura la autenticación anterior.

Ambas URLs de identidad se configuran juntas con HTTPS, sin credenciales,
fragmentos ni redirects. Solo `NODE_ENV=test` admite HTTP loopback para JWKS
aislado. Fetch: 2 segundos, 1 MiB, 100 claves y cache de 60 segundos. El cache
vencido no se reutiliza si falla la renovación. No acredita identidad real G7.

Consultas `REPEATABLE READ READ ONLY`; paginación base uno, default 1/20, máximo
200, orden estable por inicio/ID. Precio base: vigencia global actual y versión
de definición para CAS; programación: versión de su snapshot. Programar no
adelanta el precio vigente. Una versión bigint no representable exactamente
en JSON se rechaza sin redondeo. El lote omite `row_input`, actor, URI privada
y detalle libre; limita los códigos por fila a los normativos aplicables.
`readImport` selecciona únicamente campos necesarios del resumen y de las
filas (`row_id`, `sku`, `status`, `code`), sin recuperar `row_input` ni detalle
libre de PostgreSQL. La consulta tiene `LIMIT 1001`: hasta 1.000 filas devuelve
el detalle completo; si hay más, omite `rows` y conserva todos los campos
obligatorios del resumen. `rows` ya es opcional en `EstadoImportacionPrecio`
del OpenAPI vigente. No se inventa paginación/campo/código ni se devuelve una
lista truncada como si fuera completa. El reporte sigue pendiente de P-PRI-01.

Las programaciones del precio base filtran `product_id` y `channel_id IS NULL`
en existencia, conteo y página, usando el mismo `scope`. No mezclan canales.
El filtro por SKU conserva su semántica anterior. Comprueban primero la definición dentro de la misma
fotografía: definición inexistente devuelve 404 `PRECIO_NO_ENCONTRADO`;
definición existente sin programaciones devuelve 200 con `items: []` y total 0.

DB/permisos/timeouts producen 503, sin simular precio ausente ni filtrar SQL o
credenciales. Correlación UUID generada/conservada; valor inválido devuelve
VALIDACION con ID nuevo. Logs HTTP: servicio, entorno, UUID, status y duración,
sin JWT, URL con IDs, body ni error original. Readiness verifica SELECT en las
seis tablas propias usadas por estos casos de uso; no hace fan-out a G7/broker.

## Escritura interna

`PricingMutations` está registrado/exportado. Opera sobre una definición ya
existente de producto o SKU/canal; no crea contexto ni overrides. `update`
compara versión; `schedule` asigna la siguiente bajo lock sin versión cliente.
Ambos confirman versión, cierres históricos, snapshot nuevo, programación
cuando aplica y Outbox juntos. El dominio recibe campos de negocio sin PK/FK
para evitar reutilizar la identidad del snapshot anterior. Un fallo de Outbox
revierte el cambio; rechazo de negocio no persiste hechos. No publica en el tx.

El caller debe suministrar el payload opaco obligatorio de `PriceFact`, sin
valor por defecto. El adaptador que lo construya espera P-PRI-02. Los `{}` de
tests son fixtures de atomicidad; no son un payload productivo acordado.
Outbox persistido no demuestra publicación, ACK, consumer ni homologación.

## Dependencias específicas

| Owner responsable | Operación afectada | Condición verificable de desbloqueo |
|---|---|---|
| Leonardo Vera + Marco/arquitectura y consumidores concernidos | Cambio/aplicación masiva | Definición normativa verificable del data/payload P-PRI-02 y aceptación concernida cuando corresponda. No completar `GenericData` por inferencia. |
| Leonardo Vera + Marco/arquitectura | Archivo, prevalidación, admisión y reporte | Formato/cabeceras/versionado y política de prevalidación/reporte publicados (P-PRI-01). |
| Gabriel Poma/Catálogo + Marco/arquitectura | Herencia, estado y elegibilidad por SKU | Contrato ejecutable que entregue contexto autoritativo por SKU; búsqueda comercial por texto no garantiza ese lookup. |
| Gabriel Poma / #12 | DATA-003 | Publicación, IDs/versiones y elegibilidad confirmados; reauditar matriz existente. |
| Marco Castilla / Gateway #107/#109 | Mutaciones autenticadas y stack demo | Introspección de mutaciones conectada y stack privado verificado. La compatibilidad sin Authorization está corregida localmente; no acredita despliegue ni recorrido real Gateway→Pricing. |
| Leonardo Vera / Frontend #38 + Marco / Frontend #45 | #59/#60 | Adaptadores de feature, cliente compartido y stack real coordinados. |
| Marco/infraestructura + Leonardo Vera | Transporte #57 | Cliente AMQP autorizado en el monorepo y broker/topología de pruebas. No hay cliente AMQP instalado; dependencias globales exigen autorización expresa del issue. |

## Normativa y evidencia

Fuentes oficiales remotas: `Taller-SW-Web/G6-Productos-Ofertas-docs`, master
`c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`: Arquitectura §§7/9/10/16/21/24–26,
SPEC/HU/FLOW-013, modelo físico §23, registro DEC-F, matriz de trazabilidad y
matriz intermodular. OpenAPI `0.6.0-rc.1`, AsyncAPI `0.6.0-rc.2` candidatos.
Aplican DEC-F-001/006/009/012. No se modifican contratos ni migraciones.

Node 24.19.0, Vitest 4.1.11, PostgreSQL 16.15 real en Docker aislado existente,
una instancia por suite, rol runtime sin ownership. JWKS HTTP de prueba y
firmas RSA reales. Sin credenciales ni escrituras compartidas.

```powershell
npm test -- apps/pricing-svc
$env:PRICING_TEST_POSTGRES = '1'
npm run test:e2e -- apps/pricing-svc
node --test scripts/seed/mcp/pricing/verify.test.mjs
npm test
npm run test:e2e
npm run typecheck
npm run lint
npm run format:check
npm run build:pricing-svc
git diff --check
```

Resultados de la entrega inicial `9e29481` (Node 24.19.0):

| Comando | Resultado |
|---|---|
| `npm test -- apps/pricing-svc` | PASS: 154 pruebas |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e -- apps/pricing-svc` | PASS: 25 pruebas, cero omitidas |
| `node --test scripts/seed/mcp/pricing/verify.test.mjs` | PASS: 9 checks |
| `npm test` | PASS: 279 pruebas |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e` | PASS: 359 aprobadas, 13 omitidas preexistentes de otras suites por entorno |
| `npm run typecheck` | PASS |
| TypeScript estricto de todo Pricing y sus pruebas | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm run build:pricing-svc` | PASS |
| `git diff --check` | PASS |

El PR registra el SHA de entrega. Además se ejecuta
TypeScript estricto sobre todos los `.ts` de Pricing, incluidos tests, mediante
`tsc --ignoreConfig --noEmit` y opciones NodeNext/decoradores del monorepo.

Fallos detectados y corregidos durante la validación: reutilización de PK al
pasar una fila ORM completa al dominio, tipos de mocks e import ESM de test.
Se conservan las pruebas; las ejecuciones fallidas no se reportan como PASS.

Implementación interna: parcial comprobada. Integración autenticada compartida,
homologación externa y despliegue: no ejecutados/acreditados en esta entrega.

## Correcciones para segunda auditoría de PR #132

- P0 en `6c70a17`: demo explícita sin G7, apagada por defecto y entonces prohibida en producción
  (restricción sustituida por la doble confirmación de la tercera auditoría);
  pruebas de configuración, provider en ambos modos y readiness con DB real.
- P1 importaciones: proyección SQL explícita y detalle acotado sin alterar
  OpenAPI. Pruebas del SQL generado, límite 1.000/1.001 y resumen HTTP.
- P1 programaciones: 404 frente a 200 vacío, probado para producto y SKU.
- P1 CI: `.github/workflows/ci.yml` incorpora un paso con
  `PRICING_TEST_POSTGRES=1` y `npm run test:e2e -- apps/pricing-svc --reporter=verbose`.
  Reutiliza una instancia Docker por suite con imagen fijada, rol runtime,
  SQL con checksum, puerto aleatorio loopback y limpieza al cerrar. Fallo de
  Docker/fixture hace fallar la suite. No utiliza `.env`, URLs ni credenciales
  compartidas/Supabase. Se conservan todos los pasos y pruebas existentes.
- La modificación acotada de CI está autorizada expresamente por esta auditoría.
  No se toca CAS, locks, snapshots, Outbox, otros servicios, frontend ni contratos.
- P-PRI-01/P-PRI-02 y estados parciales de los ocho issues se conservan.

El nuevo SHA y resultados locales/CI se registran en el mismo PR; merge pendiente
de autorización expresa tras la nueva auditoría.

Resultados de esta revisión (Node 24.19.0, PostgreSQL 16.15 aislado):

| Comando | Resultado |
|---|---|
| `npm test -- apps/pricing-svc` | PASS: 163 |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e -- apps/pricing-svc --reporter=verbose` | PASS: 29, cero omitidas |
| `npm test` | PASS: 288 |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e` | PASS: 363; 13 omitidas preexistentes de otras suites |
| `npm run typecheck` y TypeScript estricto de todo Pricing/tests | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS tras corregir formato del test |
| `npm run build:pricing-svc` | PASS |
| `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -shellcheck=` | PASS |
| `git diff --check` | PASS |

Estos resultados locales no se presentan como resultado del workflow remoto;
su ejecución para el nuevo SHA queda identificada en PR #132.

## Correcciones para tercera auditoría de PR #132

Base de esta revisión: `6c70a17`. Solo los dos hallazgos solicitados:

1. La configuración valida los dos flags estrictamente y permite demo en
   `production` únicamente con ambas confirmaciones en `true`. Guard y readiness
   usan la decisión ya validada; no dependen de G7 en demo confirmada. Se conserva
   autenticación por defecto y con flag `false`, y se conserva TLS/PostgreSQL,
   correlación y manejo de errores. Se prueba rechazo antes de crear Nest,
   configuración de producción, flags inválidos, Authorization ignorado y
   ausencia de llamadas G7 en demo, y readiness ante éxito/fallo de DB.
2. `readSchedules` usa el filtro exacto producto/global para las tres consultas.
   Las pruebas PostgreSQL cubren mezcla de global/Marketplace/Retail, páginas
   y metadatos solo globales, global sin programaciones, solo canal con 404,
   producto inexistente con 404 y regresión SKU con todos sus canales.

No se modifican Compose, Gateway, Oracle, despliegues, CI, OpenAPI/AsyncAPI,
CAS, locks, snapshots, Outbox ni reglas de vigencias. No se despliega ni activa
el modo: el solicitante asume su activación y validación de exposición privada,
aislamiento de datos y permisos mínimos. Los ocho issues siguen parciales y
las dependencias P-PRI-01/P-PRI-02 y demás fronteras conservan sus owners y
condiciones de desbloqueo. PR #132 pendiente de tercera auditoría, sin merge.

Resultados y CI completa del nuevo SHA se registran en el mismo PR.

Validación local de esta revisión, Node 24.19.0 y PostgreSQL 16.15 aislado:

| Comando | Resultado |
|---|---|
| `npm test -- apps/pricing-svc` | PASS: 176 pruebas |
| `PRICING_TEST_POSTGRES=1 npm run test:e2e -- apps/pricing-svc --reporter=verbose` | PASS: 31 pruebas, cero omitidas |
| `npm run typecheck` y TypeScript estricto de Pricing/tests | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS tras normalizar formato del test |
| `npm run build:pricing-svc` | PASS |
| `git diff --check` | PASS |

Producción confirmada se verifica en configuración, guard y readiness con
dobles de DB en pruebas unitarias; las pruebas de consultas usan PostgreSQL
real aislado en modo test. No acreditan despliegue ni exposición en Oracle.
