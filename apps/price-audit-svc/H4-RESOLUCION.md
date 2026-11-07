# Price Audit — resolución local de #63, #65, #66, #68 y #69

## Revalidación — 2026-11-05

Rama `vera`, base `5b659656a53abae557d6ce929e0a04df4906d0d1` (PR #169 ya
integrado). Esta entrega refuerza la implementación existente; el resto del
documento conserva su evidencia histórica, no acredita ejecuciones nuevas.
Código y regresiones: `fc95725798f038621b0c1497f812bec81e72bc0b`;
este reporte se incorpora en un commit documental posterior.

Fuentes reconsultadas: los cinco issues abiertos, AGENTS, las seis guías Oracle,
Docs oficial `a7778ec1a22811c1213a94ef096ab905911342cc`, OpenAPI `0.6.0-rc.3`,
AsyncAPI `0.6.0-rc.4`, SPEC-014, DEC-G6-INT-06, registro y matriz
DEC-F-001/006/009/012, matriz intermodular, arquitectura y modelo físico propio.

### Cambio

`Date.parse` normalizaba días inexistentes (30 de febrero, 31 de abril) y
`24:00:00`. Se rechazan antes de convertir `occurred_at`, `valid_from` y filtros
temporales de consulta/exportación para evitar asientos con fechas alteradas.
Se conservan años bisiestos y offsets válidos que cruzan de día/año.
Regresiones AMQP con fecha imposible en envelope y payload comprueban mensaje
retenido sin ACK, cero Inbox/asientos y readiness 503. La disposición manual
del mensaje es exclusiva de la fixture; no hay descarte ni DLQ productiva.

### Estado por issue

| Issue | Estado | Pendiente específico / condición verificable |
|---|---|---|
| #63 | IMPLEMENTAR_PARCIAL | Captura/cálculo/invariantes existentes y validación temporal reforzada. Vera + Marco deben aprobar formato/storage/proceso recuperable P-AUD-03 antes del archivo frío o retiro de originales. |
| #65 | IMPLEMENTAR_AHORA (superficie contractual) | POST exportaciones y lecturas probados. SPEC-014 prohíbe edición/borrado del histórico: no se inventan escrituras HTTP de asientos. Aplicación compartida de migración separada. |
| #66 | IMPLEMENTAR_PARCIAL | Inbox/ACK/dedupe/recuperación probados con broker/SQL aislados. Marco/infra (#29/#110): acreditar ACL/red/bindings y corte coordinado de backlog/productor/consumidores antes de activar flujo compartido. |
| #68 | BLOQUEADO_ESPECÍFICO | Marco/Gateway (#21), frontend (#45) y G7: ruta/composición React reales, token/grant efectivo e interacción visible sin fallback, con SHA/entorno. Sin cambios en componentes ajenos al ownership. |
| #69 | IMPLEMENTAR_PARCIAL | AMQP → Inbox/log → HTTP real aislado probado; productor/JWKS de fixture. Vera/Pricing: acreditar emisión post-commit real conjunta. Marco/frontend/G7: recorrido Gateway/UI/auth real con SHAs. Oracle requiere liberación individual #111. |

La discrepancia HTTP sigue vigente en Docs consultado: `sku/canal_origen` son
string en OpenAPI, mientras SPEC-014/DEC-G6-INT-06 permiten null. Marco/owner
contractual debe aprobar versión compatible y coordinar consumidores; se conserva
el 503 de esa frontera sin ocultar filas. Marco/BD debe incorporar la migración
propuesta al ledger canónico y autorizar destino/aplicación/postcheck. No se
ejecuta SQL compartido, despliegue ni cambios de autenticación.

### Validación de esta entrega

Node 26.13.0, Docker 29.8.2; PostgreSQL/RabbitMQ desechables y JWT/JWKS de
fixture, sin credenciales compartidas.

- `npm test -- apps/price-audit-svc`: PASS, 141 pruebas.
- `npm run test:e2e -- apps/price-audit-svc`, con
  `PRICE_AUDIT_TEST_POSTGRES=1` y `PRICE_AUDIT_TEST_AMQP=1`: PASS, 31 pruebas.
- `npm test -- --maxWorkers=2`: PASS, 1958 pruebas / 56 omitidas.
- `npm run typecheck`, `npm run lint`, `npm run build:price-audit-svc`: PASS.
- `npm run format:check`, `git diff --check`: PASS.
- E2E general `npm run test:e2e -- --maxWorkers=2`: FAIL, 1015 PASS /
  137 omitidas / un timeout de 5000 ms en
  `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts:883` (DATA-002),
  ya registrado en la revisión histórica. No se modifica Catalog.
- Repetición `npm run test:e2e -- --maxWorkers=2 --testTimeout=15000`:
  PASS, 1016 pruebas / 137 omitidas, con los dos flags propios habilitados
  y OpenSSL de Git en PATH. El margen solo aplica al comando local;
  no cambia tests/configuración/CI. Las integraciones opcionales de otros
  servicios no habilitadas siguen omitidas, no se declaran ejecutadas.

CI del nuevo SHA, integración autenticada externa, homologación y despliegue
no se infieren de estos resultados. Estado integral: PARTIAL; no READY_FOR_DEPLOY.

## Revisión de auditoría PR #169 — 2026-11-02

Rama `vera`, owner Leonardo Vera. El SHA publicado auditado es
`29a6f2990e1b8773d5c0e16b433bebf7c2a54db1`:
[CI 41576029124](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/41576029124)
terminó **success, 16/16 jobs** (verificado remotamente). No equivale a despliegue.
La implementacion de esta revision esta publicada en
`08dc055efc38c1e7f04f69df62f41b117f8c0d4b`:
[CI 41578340213](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/41578340213)
termino **success, 16/16 jobs**, verificado remotamente para ese SHA exacto.
Este registro se incorpora en un commit posterior exclusivamente documental;
no se atribuye una ejecucion de CI a otro SHA. La verificacion del HEAD
final del PR se reporta aparte despues de publicar este registro.

El job de persistencia/mensajeria Pricing y Price Audit
([log del job](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/41578340213/job/125727008828))
ejecuto **81 pruebas PASS** combinadas, con los flags de integracion habilitados,
incluidas las 29 propias. Son dependencias reales aisladas y emisores/JWKS de
fixture; no equivalen a una integracion autenticada Pricing real, G7 o despliegue.
Tambien pasaron E2E general e imagenes con los comandos originales del workflow,
sin ampliar su timeout: el fallo local DATA-002 de Windows no se reprodujo en CI.

### Precisión de la respuesta HTTP

`wireAudit` serializa el decimal original de PostgreSQL como número JSON mediante
`JSON.rawJSON`, sin pasar por `Number` ni cambiar a string el tipo de OpenAPI.
El texto se valida como literal decimal antes de serializarlo; NaN, Infinity y
fragmentos de JSON arbitrarios se rechazan. Null permanece null y cero es cero.
La misma función atiende listado y detalle, incluidos los porcentajes negativos.
Se verificó la primitiva también en el runtime Node 24.15.0 de la imagen existente.

Las pruebas comparan **el texto HTTP recibido**, no solo `response.body`, porque
un parser JavaScript común ya redondearía el número. Casos: `1.2300`,
`0.10000000000000000001`, `9007199254740993.01` y
`9999999999999999999999999999.99`, admitidos sin máximo/escala en el contrato.
CSV/PDF continúan recibiendo los strings exactos del repositorio.

Límite del consumidor: `JSON.parse` convencional puede redondear números a
binary64 en el cliente. El servidor conserva los dígitos en tránsito; la adopción
de un parser decimal por el consumidor o una futura representación decimal-string
requiere coordinación contractual independiente. No se afirma precisión binary64
en el frontend ni se cambia unilateralmente la representación publicada.

### Evolución HTTP pendiente de coordinación

Docs SHA `40b566976fb94d924116dcd01d41b3276c2bc9e3` sigue vigente:
OpenAPI rc.3 exige string en `RegistroAuditoriaPrecio.sku/canal_origen`, mientras
SPEC-014/DEC-G6-INT-06 y AsyncAPI rc.4 definen PRODUCTO/global con null.
Propuesta para Marco/owner contractual: publicar una candidata que admita
`string | null` para ambos campos, documente `target_type: PRODUCTO | SKU`
y la relación PRODUCTO → sku=null; acordar con consumidores su versión/corte.
No se envía comunicación externa ni se edita el contrato desde este PR.

Hasta aprobación verificable, se conserva el 503 en esa frontera. Las pruebas
cubren detalle y lista **mixta** con un registro normal y otro PRODUCTO/global:
no se omiten filas ni se inventa SKU/canal. El detalle normal sigue respondiendo
200. Exportación CSV/PDF por batch funciona para PRODUCTO, SKU global y
PRODUCTO global; CSV comprueba columnas vacías, target_type y decimal exacto;
PDF comprueba generación/descarga de un archivo real, sin atribuir revisión visual.

### Migración: propuesta sin aplicación compartida

`migrations/0002_typed_price_change.sql` permanece **sin cambios y propuesta**.
No pertenece todavía al ledger/proceso canónico de Docs; no se aplica a Supabase,
Oracle ni ambiente compartido y el runtime nunca ejecuta DDL. Solo se prueba en
PostgreSQL desechable después de la migración histórica intacta.

Marco/administración BD deben revisar e incorporar la versión al proceso
canónico, registrar versión/checksum, destino, autorización, ejecución y
validación. Aplicación productiva y preparación del archivo son estados distintos.
La nueva versión del servicio requiere ese schema: sin target_type, readiness
es 503 aunque liveness sea 200. Primero migración autorizada/verificada, después
servicio compatible; no promover basándose en health. No se autoriza revertir
DDL ni borrar datos al hacer rollback del servicio.

### Transición RabbitMQ: gate previo, sin habilitar flujo compartido

Este es un **plan pendiente de aprobación/ejecución por Marco/infra**, Vera
(Pricing/Audit) y owners de los demás consumidores. No hay operación remota ni
declaración de recursos, cambio de ACL, purga o habilitación de AMQP en esta revisión.

1. Inventariar versiones/SHA del productor y consumidores, mensajes listos/en
   vuelo y pendientes Outbox/reintentos del productor. Conservar evidencia
   recuperable de payload, message_id y metadatos; no inferir cola vacía de un
   contador histórico ni asumir que GenericData tiene un decoder recuperable.
2. Congelar la emisión antigua bajo ventana aprobada; resolver **todo** el
   backlog antiguo antes del corte. Si existe un consumidor antiguo compatible,
   drenar con esa versión y comprobar su commit/Inbox. Si no existe, detener el
   corte hasta aprobar una disposición durable y recuperable y, si es posible,
   una transformación/replay respaldada por datos reales. Nunca completar campos
   desconocidos con valores inventados ni ACK/descarte para vaciar la cola.
3. Exigir evidencia de cero mensajes antiguos listos/en vuelo **y** cero
   publicaciones/reintentos antiguos pendientes. Si se necesita una retención
   separada, infraestructura debe aprobarla y acreditar su recuperabilidad antes
   de liberar la cola; este servicio no crea colas/DLX ni inventa esa política.
4. Con migración autorizada, desplegar consumidores compatibles y productor
   tipado en corte coordinado; mantener emisión detenida hasta validar versiones,
   ACL/red y readiness de cada componente. Después, comprobar con Pricing real
   emisión post-commit → RabbitMQ → Inbox/asiento, dedupe y lectura/exportación;
   recién entonces autorizar la reanudación. Las fixtures no satisfacen ese gate.
5. Si aparece un mensaje antiguo inesperado, el consumidor conserva la entrega
   sin ACK (NACK/requeue), pausa y muestra readiness 503. Se comprueba ese caso
   con GenericData en broker desechable, sin Inbox/asiento ficticio. Requiere
   disposición aprobada y reinicio; no es una estrategia automática de migración.
   Para rollback detener emisión y consumo, preservar pendientes y resolver la
   compatibilidad antes de volver a una versión antigua. No entregar datos
   tipados a un consumidor antiguo por el simple hecho de revertir su imagen.

**Estado de esta revisión:** implementación/pruebas locales separadas de CI
remoto; integración real Pricing → RabbitMQ → Price Audit, grants G7,
homologación y despliegue siguen **NO ACREDITADOS**. El emisor de los tests AMQP
es una fixture explícita; decoder, broker, repositorio y HTTP son reales aislados.

### Validación local de la revisión

Node 26.13.0, Docker 29.8.2; PostgreSQL 16/RabbitMQ 4.2 desechables y
JWT/JWKS de fixture. Comprobación adicional de rawJSON en Node 24.15.0: PASS.

- `npm test -- apps/price-audit-svc`: PASS, 114 pruebas.
- `npm run test:e2e -- apps/price-audit-svc`, con
  `PRICE_AUDIT_TEST_POSTGRES=1`, `PRICE_AUDIT_TEST_AMQP=1`: PASS, 29 pruebas.
- `npm test -- --maxWorkers=2`: PASS, 1893 pruebas / 56 omitidas.
- `npm run typecheck`, `npm run lint`, `npm run build:price-audit-svc`: PASS.
- tsc estricto explícito de fuentes/tests propios: PASS.
- `npm run format:check`, `git diff --check`: PASS.
- `npm run test:e2e -- --maxWorkers=2`: FAIL, 1012 PASS / 125 omitidas /
  un timeout de 5000 ms en DATA-002 de Catalog, reproducido en Windows.
- `npm run test:e2e -- --maxWorkers=2 --testTimeout=15000`, con OpenSSL de Git
  en PATH y los dos flags de Price Audit: PASS, 1013 pruebas / 125 omitidas.
  El margen es solo de este comando local; no se cambia ninguna prueba ni
  timeout en el repositorio. CI remoto conserva sus comandos/límites originales.

Cambios de revisión limitados a `H4-RESOLUCION.md`,
`src/http/audit.controller.ts`, `src/http/audit.controller.spec.ts`,
`test/provider.postgres.e2e-spec.ts`, `test/exports.postgres.e2e-spec.ts` y
`test/consumer.amqp.e2e-spec.ts`, todos dentro de Price Audit.

## Antecedente histórico de implementación (antes de publicar #169)

Corte: 2026-11-02, rama `vera`, base backend
`9f7be5e38be7b643acb956d8b3499459c146755b`, cambios locales sin commit.
Este informe sustituye las referencias a P-AUD-02 pendiente del README histórico.
No se han comentado ni cerrado issues, ni publicado cambios.

## Fuentes y alcance

Docs `40b566976fb94d924116dcd01d41b3276c2bc9e3`: SPEC-014,
DEC-G6-INT-06, registro/matriz DEC-F (001, 006, 009, 012 aplicables), matriz
intermodular, modelo físico Price Audit; OpenAPI 0.6.0-rc.3 y AsyncAPI
0.6.0-rc.4. También se consultaron AGENTS y las seis guías Oracle obligatorias.
Se conserva HTTP/auth existentes, sin modificar Gateway, Pricing o frontend.

La autorización del usuario permite **preparar** la migración, sin aplicarla a
Supabase. Solo las bases Docker desechables reciben DDL durante las pruebas.
No hay consulta ni escritura en BD compartida, ni credenciales reales utilizadas.

## Implementación interna

- Decoder productivo conectado al módulo: payload cerrado, actor nullable,
  identidad PRODUCTO/SKU, canal global null, metadatos y transiciones válidas.
- Porcentaje decimal exacto con BigInt, escala 2 y HALF_UP simétrico. No usa
  float para calcular ni comparar los importes. No se acepta MODIFICACION sin
  cambio efectivo. Timestamp del asiento = occurred_at, no valid_from.
- Un evento produce un asiento de su objetivo; moneda, price_version,
  valid_from y actor originales permanecen además en el payload Inbox.
- Migración nueva `migrations/0002_typed_price_change.sql`, sin tocar el SQL
  histórico: target_type con backfill SKU para asientos previos, SKU/canal
  nullable y checks. Se amplía numeric(12,2) a numeric para preservar los
  decimal-string de AsyncAPI sin redondeo silencioso. Contempla porcentaje
  indefinido ante precio anterior cero, conservando registros históricos.
- Inbox/bitácora siguen en la misma transacción, ACK después del commit;
  duplicados, rollback, reconexión y retención del mensaje incompatible probados.
  No hay declaración automática de topología ni cambios de ACL del broker.
- CSV/PDF conservan target_type; null no se reemplaza por SKU o canal ficticio.
- Readiness exige la columna de la nueva migración. No se ejecuta DDL al arrancar.

## Discrepancia HTTP aislada

SPEC-014 y DEC-G6-INT-06 requieren consultar PRODUCTO/sku=null y canal global;
RegistroAuditoriaPrecio en OpenAPI rc.3 todavía tipa sku/canal_origen como string.
No se modifica el contrato compartido. `wireAudit` responde 503 contractual si
algún registro tiene SKU o canal null, también en listas que lo incluyan; no
oculta filas, inventa valores ni publica DTOs incompatibles. La captura y la
exportación son independientes. Esto limita temporalmente esas lecturas.

## Estado por issue y dependencias

| Issue | Clasificación | Estado interno y condición pendiente |
|---|---|---|
| #63 | IMPLEMENTAR_PARCIAL | Decoder, cálculo e invariantes implementados. Archivo frío P-AUD-03 sigue sin formato/storage/proceso aprobados; no hay purga de originales. |
| #65 | IMPLEMENTAR_AHORA | Exportaciones existentes verificadas; no se añaden POST/PUT/PATCH/DELETE de asientos. Consumo tipado conectado; aplicación compartida de migración y rollout siguen separados. |
| #66 | IMPLEMENTAR_PARCIAL | Decoder real y broker/SQL desechables verificados. Owner Marco/infra: habilitar flujo compartido solo con ACL/red/topología y corte coordinado de productores/consumidores acreditados (#29/#110). |
| #68 | BLOQUEADO_ESPECÍFICO | Owner Gateway/Marco + frontend (#21/Frontend #45) + G7: ruta, interacción visible sin mock y autenticación real con SHAs verificables. No hay autorización para editar esos componentes en esta tarea. |
| #69 | IMPLEMENTAR_PARCIAL | AMQP tipado → Inbox/log → HTTP probado localmente; productor de la prueba es fixture explícita, no Pricing real. Owner Vera/Pricing: factory/emisión post-commit vigente y prueba conjunta. Gateway/UI/G7 y Oracle siguen pendientes. |

Dependencias adicionales:

- Marco/owner contractual: alinear RegistroAuditoriaPrecio para target_type,
  sku y canal nullable; después habilitar la proyección HTTP pendiente y probarla.
- Marco/administración BD: revisar/incorporar la migración al ledger canónico y
  aprobar su aplicación en entorno concreto; no ejecutar manualmente ni al boot.
- Vera + Marco: aprobar storage/formato/recuperación de archivo frío P-AUD-03
  antes de implementar retiro de originales. Este cambio no concede permisos.
- Marco/release #111: autorización individual, SHA/digest, imagen, TLS/red,
  readiness, smoke y recuperación. No se declara READY_FOR_DEPLOY.

## Evidencia local

Resultados y comandos de esta entrega se registran a continuación. JWT/JWKS
son fixtures criptográficas locales; PostgreSQL 16 y RabbitMQ 4.2 son Docker
descartables en loopback. Las pruebas propias DB no acreditan TLS de Supabase,
grants G7, homologación, CI ni despliegue.

- `npm test -- apps/price-audit-svc`: PASS, 100 pruebas antes de dos casos
  adicionales de dominio, incluidos decoder y porcentaje; suite propia final
  en `npm test`: 102 PASS.
- `npm test`: PASS, 1881 pruebas y 56 omitidas; incluye 102 de Price Audit.
- `npm run test:e2e -- apps/price-audit-svc`, con
  PRICE_AUDIT_TEST_POSTGRES=1 y PRICE_AUDIT_TEST_AMQP=1: PASS, 21 pruebas finales,
  incluidas HTTP inmutable/readiness de migración y decoder productivo sin override.
- `npm run typecheck`, `npm run lint`, `npm run build:price-audit-svc`: PASS.
- tsc estricto explícito de todas las fuentes y tests de Price Audit: PASS.
- `npm run format:check` y `git diff --check`: PASS.
- Prettier sobre el directorio completo detectó formato previo de README.md;
  el chequeo de TypeScript global pasa. No se reformatea documentación histórica.
- E2E general: 920 PASS, 210 omitidas, una suite FAIL de Catalog por OpenSSL
  ausente en PATH. Revalidación de esa suite con OpenSSL instalado de Git: PASS,
  4 pruebas. Repetición general con PATH corregido: FAIL, 1004 PASS / 125 omitidas /
  1 FAIL: `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts:883`,
  `validates the DATA-002 batch in disposable PostgreSQL`,
  `Error: Test timed out in 5000ms.` No se modifica Catalog.
  Owner Gabriel Poma: reproducir/corregir ese timeout y repetir su gate general.
- Sin npm ci, CI por nuevo SHA, build de imagen ni deploy en esta entrega.

## Archivos del cambio

Todas las rutas están bajo `apps/price-audit-svc/`:

- `src/domain/audit.ts`, `src/domain/audit.spec.ts`.
- `src/messaging/price-change-decoder.ts`, `src/messaging/price-change-decoder.spec.ts`.
- `src/messaging/audit-consumer.ts`, `src/messaging/audit-consumer.spec.ts`.
- `src/price-audit-svc.module.ts`.
- `src/persistence/audit.schema.ts`, `src/persistence/audit.database.ts`.
- `src/http/audit.controller.ts`, `src/exports/audit-file-worker.ts`.
- `migrations/0002_typed_price_change.sql`.
- `test/isolated-postgres.ts`, `test/consumer.amqp.e2e-spec.ts`,
  `test/provider.postgres.e2e-spec.ts`.
- `H4-RESOLUCION.md` y enlace desde `README.md`.

Estado integral: PARTIAL. Desarrollo interno, integración aislada, autenticación
externa, homologación y despliegue se mantienen como estados independientes.
