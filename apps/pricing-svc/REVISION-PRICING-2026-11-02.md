# Pricing: contexto Catalog y canales — 2026-11-02

Rama `vera`; base backend `10a755bf953bf04926a94dea0f3ca222ffa447d8`.
Cambios locales sin commit, push, cierre de issues, CI nueva ni despliegue.
Owner: Leonardo Vera. Alcance concreto: #24/#55 y adaptación de canales de #56.

## Fuentes

- Docs oficial `783a60efa5772548fce66ef63198e17361d8460b`: OpenAPI
  `0.6.0-rc.2`, AsyncAPI `0.6.0-rc.4`, SPEC-013, registro/matriz DEC-F,
  matriz intermodular y acuerdos G6 H4 INT-01/04/06/09/13.
- DEC-F-001/006/009/012: ownership, precio por SKU/canal/vigencia,
  identidad/idempotencia y compatibilidad contractual.
- Acuerdo privado `ACUERDO_PRICING_CATALOGO_SKU_CONTEXT.md` y paquete operativo
  G1 Marketplace, acuerdo G1–G6 y alineación publicados en Docs.
- Guías Oracle del servicio, contrato de despliegue, matriz de dependencias,
  compatibilidad RabbitMQ, checklist y política demo/#144.
- G7 `6045c013fd454cff998169bd1b114323324cda72`, contrato
  `emitirTokenServicio`/`TokenServicio`. No se atribuye grant a ese documento.

## Resultado

- Canales textuales en GET, PATCH y POST; global null, fallback conservado,
  UUID/valores desconocidos rechazados antes de la mutación.
- Allowlist `modulo-productos` con `precios:leer` exclusivamente en
  `consultarPrecios` y `obtenerPrecioSku`; administración permanece humana.
- Adaptador privado Catalog registrado en Nest, preservación de SKU opaco y
  flags, solo `404 SKU_NO_ENCONTRADO` es ausencia. Errores técnicos, identidad
  o DTO corrupto producen 503, sin consultas cross-schema ni fallback ficticio.
- Credencial propia G7 `client_credentials`, scope `catalogo:leer`, verificación
  RS256/JWKS/issuer/audience/exp/tipo/sub/scope, expiración anticipada de caché.
  Sin configuración se falla cerrado; demo explícita no solicita ni reenvía JWT.
- HTTP acotado, sin redirects y JSON máximo 64 KiB. Timeouts por tramo:
  token 1 s, JWKS existente 2 s, Catalog 2 s. No son un SLA E2E acreditado.

## Supabase: exclusivamente consultas

Proyecto `slzglmtiyrzygpkiuthf`, PostgreSQL 17.11; esquema `pricing`.
Se consultaron metadatos, agrupación de canales y privilegios efectivos.
Las 20 definiciones observadas tenían `channel_id=null`; la columna es `text`.
No se necesitó conversión ni se ejecutó DDL/DML/migración compartida.

RLS estaba deshabilitado en las ocho tablas del esquema. Se verificó que
`anon` y `authenticated` no tenían USAGE en `pricing`, ni SELECT/UPDATE en
`pricing.prices`; la consulta de grants directos tampoco devolvió concesiones
para esos roles en el esquema. Esto no es una auditoría global de exposición.
No se cambiaron permisos ni políticas RLS.

## Validación

Las pruebas HTTP de Catalog y G7 usan servidores locales y firmas RSA reales
de fixtures. No son Catalog/G7 compartidos ni prueban grants efectivos.
Las pruebas de persistencia usan PostgreSQL 16.15 descartable y rol pricing_app.
La suite AMQP existente usa RabbitMQ descartable. Los hechos de prueba
`fixture_only` no acreditan el payload productivo tipado de AsyncAPI rc.4.

| Comando | Resultado |
|---|---|
| `npm test -- apps/pricing-svc --maxWorkers=1` | PASS: 295 pruebas |
| `npm test -- --maxWorkers=2` | PASS: 1767 pruebas; 56 optativas omitidas |
| `PRICING_TEST_POSTGRES=1 PRICING_TEST_AMQP=1 npm run test:e2e -- apps/pricing-svc --maxWorkers=1` | PASS: 48 pruebas, cero omitidas |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm run build:pricing-svc` | PASS |
| `git diff --check` | PASS |
| `PRICING_TEST_POSTGRES=1 PRICING_TEST_AMQP=1 npm run test:e2e -- --maxWorkers=2`, con OpenSSL de Git en PATH del proceso | FAIL: 970 PASS, 1 FAIL, 98 omitidas; fallo ajeno DATA-002 de Catalog |

Huella SHA-256 de fuentes/tests de Pricing (rutas ordenadas, separador NUL,
bytes de archivo, NUL por archivo):
`205accaa75a4fc8edf2a6f555f97bfefb15b56e97da20ca7923191d19599e819`.
No es un SHA de commit ni evidencia CI. No se presenta CI de un antecesor como
CI de estos cambios. Regresión E2E general: resultado final debajo.

Incidencias conservadas: Docker no estaba disponible al inicio y Desktop
registró un fallo de socket de Secrets Engine. Después respondió y permitió
las suites aisladas. La primera ejecución PostgreSQL tuvo 32 PASS y un FAIL:
una expectativa antigua rechazaba RETAIL con 400; se actualizó para comprobar
404 PRECIO_NO_ENCONTRADO sin crear override, conservando el negativo UUID/400.
La repetición con PostgreSQL y RabbitMQ pasó. Una primera edición del README
por Python falló al decodificar UTF-8 como CP1252, sin escribir ese archivo;
la edición se aplicó correctamente mediante patch.

La primera E2E general tuvo 935 PASS, 134 omitidas y una suite fallida en
`apps/catalog-svc/test/runtime-postgres.e2e-spec.ts:94`:
`openssl failed in disposable PostgreSQL setup`. OpenSSL no estaba en PATH.
Se usó el OpenSSL 3.5.4 ya instalado con Git mediante PATH exclusivo del proceso,
sin editar Catalog ni instalar dependencias. Repetición enfocada de esa suite:
4 PASS. La omisión de AMQP en una ejecución inicial de Pricing fue corregida
usando el flag real PRICING_TEST_AMQP=1; la ejecución válida tuvo cero omisiones.

La repetición E2E general con OpenSSL pasó la preparación TLS, pero falló
`apps/catalog-svc/test/postgres.persistence.e2e-spec.ts:882`, caso
`validates the DATA-002 batch in disposable PostgreSQL`, por timeout de 5000 ms.
Resultado final: 970 PASS, 1 FAIL y 98 omitidas. No se modificó la prueba ni su
timeout. Dependencia Poma: diagnosticar el caso DATA-002 y aportar su ejecución
válida bajo el presupuesto vigente. Este fallo no se atribuye a Pricing, pero
impide declarar PASS de la regresión general o proponer commit/PR en este corte.

## Estados y trabajo restante

| Issue | Estado interno de este corte | Pendiente verificable |
|---|---|---|
| #24 | IMPLEMENTAR_PARCIAL: adaptador, canal y token propio implementados/probados aisladamente | Poma/Vera: integración contra Catalog real por SHA/URL/dataset; G7: grant y credencial reales probados |
| #55 | IMPLEMENTAR_PARCIAL: consultas comerciales y administrativas conservadas | Integración anterior; reporte de importación específico sigue sin implementación. P-PRI-01 excluye importador propio del gate H4 |
| #56 | IMPLEMENTAR_PARCIAL: corrección de canales en controladores/DTO y persistencia probada | Trabajo propio Vera: authorizer/introspección mutante y factory de hechos efectivos; no presentarlos como bloqueo de contrato, P-PRI-02 ya fue aprobado |
| #57 | Sin nueva implementación de mensajería; relay existente regresionado | Trabajo propio Vera: payload tipado, emisión efectiva, consumidores de inicialización/bulk/desactivación e Inbox; Marco: autorización/red/ACL para integración compartida |
| #58 | Relay existente probado con broker aislado | Recuperación completa de los consumidores pendientes; no afirmar DLQ ni homologación física |
| #59 | Sin cambios frontend/Gateway | Vera/feature y Marco/cliente común: integración React→Gateway por SHA y estados UI |
| #60 | Segmentos aislados HTTP/SQL/AMQP comprobados | Recorrido completo React→Gateway→Pricing→Audit; depende de implementar los tramos propios anteriores y disponer de proveedores/grants del entorno |

No se crean importadores paralelos: prevalidarImportacionPrecios y
crearImportacionPrecios quedan fuera del gate H4 conforme INT-09.
La aprobación de P-PRI-02 ya existe: queda implementación propia, pruebas de
productor/consumidor y transición coordinada antes de activar el payload nuevo.
Sin integración autenticada compartida, homologación externa ni Oracle probado.
Estado global **PARTIAL**, sin READY_FOR_DEPLOY y sin cerrar issues.

## Archivos de esta entrega

Todos dentro de `apps/pricing-svc/`:

- `README.md`, `REVISION-PRICING-2026-11-02.md`.
- `src/config/environment.ts`.
- `src/http/catalog-context.ts`, `src/http/catalog-context.spec.ts`.
- `src/http/catalog-token.ts`, `src/http/catalog-token.spec.ts`.
- `src/http/commercial-prices.ts`, `src/http/commercial-prices.spec.ts`.
- `src/http/pricing-read.guard.ts`.
- `src/http/pricing-write.controller.ts`.
- `src/http/pricing-write.dto.ts`, `src/http/pricing-write.dto.spec.ts`.
- `src/pricing-svc.module.ts`, `test/persistence.e2e-spec.ts`.

Los archivos no rastreados ajenos en scripts/seed/mcp/pricing y tests/docs
se conservaron sin modificación; no forman parte de esta entrega.
