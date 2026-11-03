# Pricing: contexto Catalog y canales — 2026-11-02

Rama `vera`; base backend `10a755bf953bf04926a94dea0f3ca222ffa447d8`.
Entrega original publicada en PR #163: commit
`cc0e5fbf59be33892d25d2ff66dee0421d47684c`, seguido por
`c197f6648d4747fced6e13483b5a025eb227bd57` (integración previa de master).
Ambos ya estaban publicados al comenzar esta auditoría. No se hace otro merge
ni se autoriza merge/despliegue con estas correcciones.
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

## Auditoría de PR #163 y coordinación

CI remoto verificado en el SHA exacto `c197f6648d4747fced6e13483b5a025eb227bd57`:
[run 41537333579](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/41537333579),
16 checks completados con SUCCESS (incluidos unitarias, E2E, Pricing/Audit,
compilación, tipos, formato, lint y validación integral). Este resultado sustituye
la afirmación obsoleta de que no había commit/push/CI. No se atribuye ese CI a
los commits nuevos: su SHA y estado se registran separadamente abajo.

- Se retiran del diff los cuatro `scripts/seed/mcp/pricing/006_current_catalog_prices.*`
  y `tests/docs/__pycache__/test_validate_marketplace_h4_docs.cpython-312.pyc`.
  Antes de retirarlos se copiaron a `C:/Users/User/.codex/tmp/pr163-out-of-scope-c197f66/`,
  conservando rutas y verificando SHA-256 origen/copia. También permanecen en
  el historial de cc0e5fb para revisión independiente. No se ejecuta SQL ni se
  modifican datos de Supabase.
- Correlación: el controller usa el UUID validado/generado por PricingReadGuard;
  se propaga por CommercialPrices y el puerto Catalog hasta el header saliente.
  Single, todas las filas del batch y Problem de Pricing conservan ese mismo ID.
  Sin contexto HTTP, el adaptador puede generar un UUID propio; no sustituye
  una correlación recibida. No se usa estado global compartido entre solicitudes.
- La prueba local nueva usa Pricing HTTP real y un Catalog de fixture;
  cubre UUID entrante/ausente/inválido, single/batch y respuestas 200/404/503.
  Es una prueba de trazabilidad de transporte, no E2E con Catalog/G7 reales.

### Demo privada: BLOQUEADO_ESPECÍFICO

Poma confirmó que obtenerContextoSku rechaza anónimos incluso con demo
administrativa. La omisión de Authorization por Pricing no acredita una
integración sin JWT. Se envió a Poma/Marco la
[solicitud concreta de coordinación en #24](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/24#issuecomment-6590336223).
La publicación por conector devolvió 403; se publicó mediante API GitHub con
la identidad local de Git, sin exponer credenciales. No hay aceptación por silencio.

Propuesta pendiente de acuerdo: excepción reversible solo para el GET privado
obtenerContextoSku y par TCP privado de Pricing verificado; default cerrado,
ninguna confianza en X-Forwarded-For/Origin/headers de identidad, sin exposición
en Gateway externo. Poma define/implementa su guard/flags; Marco verifica red,
IP y perímetro. Se conservan JWT y allowlist al desactivar demo. No se modifica
Catalog, Gateway, política compartida ni flags desde esta PR.

Condición de desbloqueo: respuesta verificable de Poma/Marco con mecanismo,
SHA de Catalog y origen/red autorizados, seguida por prueba de ambos procesos
con PostgreSQL real: permitido/denegado, modo apagado, headers falsos,
simple/variante/inactivo/inelegible/404/503 y misma correlación en ambos servicios.
Acuerdo y ejecución conjunta siguen PENDIENTES; el 401/403 de Catalog se
convierte en fallo técnico 503 de Pricing, nunca en ausencia ni fallback mock.

### G7: BLOQUEADO_ESPECÍFICO independiente

Owner Seguridad G7 y Marco (provisión privada): falta evidencia de grant
`catalogo:leer` para `modulo-productos`, audiencia `api-productos`, issuer/JWKS
y secreto client_credentials del entorno. Desbloqueo: token realmente emitido
por G7, operación positiva y negativos 401/403 por SHA/entorno, sin guardar
secretos en evidencias. Credenciales, grant e integración autenticada: NO
VERIFICADOS. Fixtures firmados, YAML y CI no acreditan esos estados, homologación
ni recorrido E2E completo. Price Audit/evento tipado quedan fuera de esta corrección.

## Corrección publicada y validación nueva

Commit de código/limpieza **4c44fe633f05ea38302c368f1bac94f343b63440**,
publicado en origin/vera y PR #163 mediante push normal. La revisión documental
se publica después en otro commit que conserva exactamente ese código probado.
La CI del SHA nuevo está solicitada y pendiente de conclusión al redactar esta
revisión; no se le atribuyen los 16 checks verdes de c197f66. El estado final del
HEAD documental se verificará en el PR y se comunicará por su SHA exacto.

Pruebas locales sobre el contenido del commit 4c44fe6:

| Comando | Resultado actual |
|---|---|
| `npm test -- apps/pricing-svc --maxWorkers=1` | PASS: 295 |
| `PRICING_TEST_POSTGRES=1 PRICING_TEST_AMQP=1 npm run test:e2e -- apps/pricing-svc --maxWorkers=1` | PASS: 52, cero omitidas; PostgreSQL/RabbitMQ descartables |
| `npm test -- --maxWorkers=2` | PASS: 1813, 56 optativas omitidas |
| `PRICING_TEST_POSTGRES=1 PRICING_TEST_AMQP=1 npm run test:e2e -- --maxWorkers=1`, OpenSSL Git en PATH | FAIL: 974 PASS, 1 FAIL, 98 omitidas; DATA-002 Catalog :882, 6116 ms frente a 5000 ms |
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build:pricing-svc` | PASS cada comando |
| `git diff --check`, `git diff --cached --check` | PASS |

El fallo DATA-002 conocido se conserva, no se altera el test ni el timeout fuera
del ownership Vera. Se publica esta corrección acotada por la solicitud expresa
del auditor de nuevos commits/push después de revisar la entrega y su CI;
no se declara PASS general local ni autorización de merge. Poma mantiene el
diagnóstico de DATA-002. Los defectos de Pricing cubiertos por esta corrección
pasan sus pruebas; la integración demo conjunta y G7 siguen pendientes.

## Validación histórica de la entrega original

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
impidió declarar PASS de aquella ejecución local. El CI posterior de c197f66 y la nueva validación se registran por separado, sin borrar el fallo histórico.

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
- Auditoría: `src/http/pricing-read.controller.ts`, `test/correlation.e2e-spec.ts`.

La publicación original incluyó por error los cinco archivos ajenos indicados arriba; esta auditoría los retira del diff y conserva copia independiente.
