# Pricing — adopción histórica A1 de Catalog #194

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
