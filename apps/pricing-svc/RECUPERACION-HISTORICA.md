# Pricing — adopción histórica A1 de Catalog #194

## Auditoría posterior: envelopes inválidos y espera de lock

Una recepción identificable con envelope inválido permanece auditada en Inbox,
pero no constituye una decisión de negocio y no debe seleccionarse para el
replay por operación. La prueba con PostgreSQL y RabbitMQ reprodujo inicialmente
`PRICING_INITIALIZATION_RESULT_MISSING` y la pausa del consumidor; con el filtro
actual pasa, incluyendo replays concurrentes y conflicto de intención.

Un lock retenido 7,2 segundos reprodujo una pausa permanente tras el timeout de
PostgreSQL. Para `PricingPersistenceError.sqlState=57014` o el timeout de lectura
del cliente PostgreSQL, después de tres
intentos el canal se cierra para devolver las entregas sin ACK y se reconecta;
la prueba real pasa sin modificar los límites existentes. Errores no reconocidos
continúan pausando. La modificación del índice 0003 supone que esta migración
aún no fue aplicada; el owner debe verificar el ledger antes de aplicarla. Si
ya se aplicó, se requiere una migración incremental separada, sin alterar la
migración histórica. No se aplicó DDL en el entorno compartido.

## Integración local con Catalog — 2026-11-07

La prueba integral A1/A2 de Catalog pasó localmente usando Catalog
`72c3d238abfa3004e00fabb8839fa91cc9a7a3d1`, Pricing
`31780a0c76a6f8652a1963f6925bf68c1b6706e8` e Inventory
`56aa4322725060b529bf316872f891582d7d1b2e`, con PostgreSQL y RabbitMQ
descartables y procesos reales. Se exportó Catalog temporalmente y se cambió
solo el pin de Pricing para la prueba; su código productivo no se modificó.
El caso integral pasó (1 PASS, 96 casos no seleccionados). Incluye recuperación,
activación, rechazos, reintentos, reinicio y snapshots monetarios. No acredita
homologación de Poma, despliegue ni integración compartida de producción.

El ejecutor `test/integracion-catalog.ps1` reproduce el montaje y exige el
marcador A1. La suite DATA-002 pasó 25 casos en Windows, con límite original
de 5000 ms. Contrato Docs y registro de la migración 0003 siguen pendientes
de Marco.

Rama `vera`, base `2cc8c8df8f0d00d8f858978f93e82f787b64777a`.
Refs Backend #57 y Catalog PR #194. Corte de trabajo: 2026-11-05.
Implementación: `8c67362d74f7de510d421fa25a80a9799082a2d5`; reporte/contrato
en commit documental posterior.
Owner: Leonardo Vera. Solo Pricing; DRAFT, sin merge ni Supabase compartida.

## Contrato y autorización

El usuario comunica aprobación definitiva de Marco para la semántica y confirma
expresamente en esta sesión la propuesta de `data.modalidad`, precio condicional,
moneda obligatoria y códigos de conflicto, además de preparar el cambio en Docs.
No se atribuye un comentario GitHub de Marco ni homologación externa que no consten.

Fuentes: AGENTS completo y seis guías Oracle; #57 y #194; Docs oficial
`a7778ec1a22811c1213a94ef096ab905911342cc`, SPEC-013, AsyncAPI rc.4,
OpenAPI rc.3, DEC-F-001/006/009/012 y acuerdos internos H4. El contrato compartido
publicado aún no contiene la modalidad: el cambio concordante de SPEC-013/AsyncAPI,
el schema y la fixture acordados se entregan en `contracts/` y `test/fixtures/`.
Ambos archivos Docs fueron modificados en el clon local de revisión; publicación
compartida sigue pendiente. Ver `contracts/README.md` para aplicación y límites.

## Implementación

- Mismo comando, resultados, envelope y topología. ALTA ausente/explícita conserva
  creación y hecho monetario existentes; nunca se infiere recuperación por motivo.
- Recuperación explícita busca solo product_id exacto global, sku/channel null,
  una vigencia no cancelada dentro de [valid_from, valid_until). Valida términos,
  moneda e importe decimal exacto, si fue proporcionado, con centavos BigInt.
- Advisory lock por operation_id y FOR UPDATE de definición (mismo lock que las
  mutaciones). FOR SHARE de snapshots. Corte clock_timestamp() posterior al lock,
  persistido explícitamente en Inbox.processed_at. No usa occurred_at remoto.
  La selección del intervalo se evalúa en PostgreSQL y el corte se conserva con
  seis decimales UTC en processed_at/completed_at, sin truncar a Date.
- Intención original en Inbox y decisión/vigencia/versión en Outbox se comprometen
  juntos. No hay migración: se reutilizan columnas y permisos existentes.
- Replays reproducen decisión y corte persistidos; no consultan reloj de negocio
  ni vigencias. Resultados de conflictos no sustituyen la decisión original.
  Correlación y causalidad responden al nuevo envío, identidad de negocio estable.
- Incompatibilidad: rejected/HISTORICAL_PRICE_CONFLICT; nueva intención para misma
  operación: OPERATION_ID_CONFLICT. Sin precios ficticios ni selección arbitraria.
- No INSERT/UPDATE/DELETE monetario en la rama de recuperación, no cambios de
  vigencia/versiones/ofertas/motivos/fechas y no pricing.price.changed.

## Evidencias

Node 26.13.0, Docker 29.8.2, PostgreSQL 16 y RabbitMQ 4.2 descartables en
loopback, digests fijados por los harness existentes; roles y credenciales de
fixture. PostgreSQL propio sin TLS en estas suites: no acredita TLS/Supabase/G7.
Productor Catalog fixture explícito; handler/consumer/relay y broker/SQL reales.

| Escenario | Evidencia nueva |
|---|---|
| Compatible sin precio; importe exacto proporcionado | READY, versión 3 y vigencia reales; snapshot completo prices/validities/schedules idéntico |
| Cero, múltiples, otro producto/canal/SKU | REJECTED/HISTORICAL_PRICE_CONFLICT; sin alta ni cambios |
| Importe/moneda inválidos o incompatibles | Rechazo durable; null/string no equivalen a omitir importe |
| Cancelada, futura, vencida y límite inclusivo/exclusivo | Unitarias y PostgreSQL; corte actual, no occurred_at de 2001 |
| Espera de lock + transición concurrente | SQL conserva microsegundos del límite; adopta vigencia al desbloquear |
| Snapshot futuro más nuevo | Devuelve versión de la vigencia adoptada, no la futura del agregado |
| Replays y redelivery, handler reiniciado | Misma decisión aunque se cierre la vigencia o se habilite después de rechazo |
| Seis entregas concurrentes, misma operación | Un primer procesamiento; resultados iguales; sin duplicar precios |
| Intención distinta y replay posterior | Conflicto determinista; decisión original preservada |
| Fallo Outbox antes de commit | Rollback sin Inbox; recuperación atómica |
| Fallo después de commit/antes de ACK | Consumidor real reintenta sin repetir efecto; resultado queda disponible al relay |
| Publicación de aceptación y rechazo | Relay real con confirms y AMQP userId; ambas rutas observadas en broker |
| Ausencia monetaria | Solo resultados por operation_id; cola monetaria vacía; snapshots preservados |
| Regresión ALTA_PRODUCTO | Alta implícita/explícita crea precio/evento; ambas son intención idéntica en replay; histórico previo no dispara recuperación |

La prueba de múltiples vigencias retira temporalmente una constraint **solo en la
base desechable propia**, introduce corrupción explícita y restaura datos/constraint
al terminar. No modifica SQL normativo ni migraciones históricas.

## Comandos ejecutados

- `npm test -- apps/pricing-svc --maxWorkers=2`: PASS, 318 pruebas (14 nuevas).
- `PRICING_TEST_AMQP=1 npm run test:e2e -- apps/pricing-svc/test/historical-initialization.e2e-spec.ts`:
  PASS, 25 pruebas, ninguna omitida.
- Flags `PRICING_TEST_POSTGRES=1`, `PRICING_TEST_AMQP=1`, `PRICING_TEST_AUDIT=1`;
  `npm run test:e2e -- apps/pricing-svc --maxWorkers=2`: PASS, 97 pruebas / una
  integración Catalog histórica omitida por su condición previa independiente.
- `npm test -- --maxWorkers=2`: PASS, 2309 pruebas / 66 omitidas.
- `npm run test:e2e -- --maxWorkers=2`: FAIL, 1129 PASS / 137 omitidas y
  un timeout de 5000 ms en DATA-002 Catalog
  (`apps/catalog-svc/test/postgres.persistence.e2e-spec.ts:1041`), preexistente
  en Windows; sin modificación de Catalog ni ocultación del fallo.
- Repetición E2E general `npm run test:e2e -- --maxWorkers=2 --testTimeout=15000`:
  PASS, 1130 pruebas / 137 omitidas. Margen solo del comando Windows; sin cambiar
  tests, workflow ni configuración. Tras el ajuste final de precisión temporal se
  revalida además la suite completa propia; CI verifica el HEAD publicado.
- `npm run typecheck`, `npm run lint`, `npm run build:pricing-svc`: PASS.
- tsc estricto explícito (--ignoreConfig) de la suite y unitarias nuevas: PASS.
- `npm run format:check`, `git diff --check`: PASS.
- Schema Draft 2020-12, cuatro requests válidos y cuatro inválidos: PASS;
  PyYAML/jsonschema instalados solo en directorio temporal, sin dependencias del repo.
- Aplicación inversa del patch Docs (--unidiff-zero --reverse --check): PASS.

## Historial de correcciones de prueba

Primer arranque de suite nueva: fallo de sintaxis SQL en literal TS, corregido.
Primera cobertura de espera de lock: fixture trasladaba límite de PostgreSQL
microsegundos a Date milisegundos y causaba solapamiento; corregida para copiar
límite exacto en SQL, repetición 25/25 PASS. Unitarias nuevas usaban %j para
BigInt en título y fallaban al descubrir casos; corregido a índice, 318 PASS.
Primer tsc explícito exigió --ignoreConfig de TS6; comando correcto PASS.
Primer format:check durante edición detectó formato de la spec nueva; corregido,
repetición PASS. No se eliminan pruebas ni se amplían timeouts en el repositorio.

## Estados separados y entrega

Implementación interna y PostgreSQL/RabbitMQ local: IMPLEMENTADO/PROBADO.
CI por HEAD: registrar en la PR tras publicar, nunca inferir de ejecución local.
Contrato/fixtures: acordados en sesión; cambio Docs preparado, publicación pendiente.
Owner Marco/contratos: publicar SPEC-013/AsyncAPI concordantes antes del corte compartido.
Owner Poma/Catalog: emitir modalidad/DTO acordados y completar A1 E2E de #194 con
estos resultados reales. La suite propia no acredita esa integración Catalog.
Owner Marco/infra: ACL/red/rollout y autorización individual antes de cualquier deploy.
Sin despliegue, merge, activación de datos reales ni escrituras compartidas.

Estado integral: PARTIAL por publicación contractual/E2E Catalog/CI por verificar;
la adaptación interna no queda bloqueada por esas evidencias independientes.

## Auditoría de replay y representación — seguimiento de PR #205

Base auditada: `807189f7ca49d4af3b4ad367043260bc3050fb3d`.
Las pruebas nuevas reprodujeron siete fallos antes de la corrección y después
pasaron 40 escenarios históricos en PostgreSQL/RabbitMQ descartables. El replay
conserva el token inválido en metadatos privados versionados de Inbox; las filas
anteriores carecen del token y su representación no puede recuperarse.

Los homónimos anidados no intervienen; para propiedades duplicadas prevalece la
última, conforme a JSON.parse. JSON Schema valida valores, no representación
textual. La migración 0003 añade el índice de replay, sin DDL de arranque; su
homologación y aplicación compartida corresponden a Marco. El detalle y límites
de EXPLAIN figuran en `contracts/README.md`.

CI, contrato Docs, integración histórica Catalog y despliegue deben verificarse
por separado contra sus propios SHA. Las pruebas con productor fixture no
acreditan integración Catalog ni despliegue.

Validación de esta auditoría: unitarias Pricing 318 PASS; E2E Pricing con
POSTGRES/AMQP/AUDIT activos 112 PASS y una omitida (Catalog); unitarias generales
2309 PASS y 66 omitidas; typecheck, lint, build Pricing y format:check PASS.
E2E general: primer intento FAIL por OpenSSL ausente del PATH; con OpenSSL de
Git disponible, 1046 PASS, 235 omitidas y un FAIL por timeout de 5000 ms en
`apps/catalog-svc/test/postgres.persistence.e2e-spec.ts:1041`. El mismo test
falló también aislado, con el límite original. No se modificó Catalog ni se
amplió el timeout. No hay commit, push ni CI para estos cambios pendientes.

## Integración de master y corrección decimal

Código Pricing: `3aa530d372aaad20636afde1bfc5c6f1b0e01945`; merge local de
master `797a043` sobre `72c3d238abfa3004e00fabb8839fa91cc9a7a3d1`. El merge se
realizó a solicitud expresa del usuario, sin modificar master ni el estado de PR.
Las pruebas de abajo se ejecutaron antes del commit con el mismo código Pricing.

- Unitarias Pricing: 325 PASS. E2E Pricing con POSTGRES/AMQP/AUDIT activos:
  112 PASS y una integración Catalog antigua omitida.
- E2E general, límites originales: 1008 PASS y 247 omitidas en checkout
  temporal de master con los cambios Pricing aplicados; no equivale a CI.
- typecheck, lint, build:pricing-svc, format:check y diff --check: PASS.
- Antes de la corrección, siete regresiones nuevas fallaron; luego la suite
  histórica pasó 40 escenarios contra PostgreSQL/RabbitMQ descartables.
- CI del HEAD documental final: pendiente de ejecución tras publicar.
  Catalog/Poma debe fijar ese SHA y ejecutar E2E histórica real separada.

El fallo DATA-002 anterior corresponde al checkout anterior a integrar master;
la versión de Poma pasó en Windows y en la ejecución general integrada anterior.
No se infiere homologación, grant, aplicación de la migración ni despliegue.
