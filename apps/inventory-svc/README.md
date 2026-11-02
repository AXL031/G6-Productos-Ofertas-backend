# inventory-svc — Control de stock y disponibilidad (G6 · Productos y Ofertas)

Servicio NestJS **dueño del saldo autoritativo por `(sku, location_id)`** del
bounded context de Inventario. Owner de la rama `taco`: Miguel Ángel Taco
Zavala. Este documento describe la superficie implementada, sus límites reales
y las dependencias externas; **no** sustituye los contratos ejecutables ni
acredita integración, homologación o despliegue.

**Fuentes normativas** (repositorio `docs`, no modificado por este servicio):
OpenAPI `0.6.0-rc.1`, AsyncAPI `0.6.0-rc.2`, `SPEC-015`, `SPEC-016`,
`SPEC-003`/`SPEC-004`, DEC-F-001/002/005/009/013/014/015 y el modelo físico
`docs/datos/inventory-svc/`. Ante discrepancia entre este README y un contrato
vigente, **prevalece el contrato**.

## 1. Invariantes de dominio

- El saldo se identifica por la clave compuesta `(sku_id, location_id)`
  (`inventory.stock_balance`, `pk_stock_balance`).
- Magnitudes por saldo: `on_hand`, `reserved`, `blocked`, `available`,
  `stock_version`. `available = max(on_hand - reserved - blocked, 0)`.
- Nunca hay saldo negativo; las mutaciones son transaccionales e idempotentes
  (`operation_id` + `Idempotency-Key`) y escriben Kardex y Outbox en la misma
  transacción.
- La **disponibilidad comercial** es una proyección de solo lectura: resuelve
  **una sola ubicación elegible**; si el contexto es ausente o ambiguo devuelve
  `INDETERMINADO`. No expone saldo físico ni ubicación detallada, no reserva y
  `binding=false` (verificar no compromete stock).
- La reserva se crea, confirma/consume, libera o expira como **operación
  separada** orquestada por Ventas. El `202 Accepted` es *admisión*, no éxito:
  el resultado definitivo se consulta en `GET /inventario/operaciones/{id}`.
- Las **incidencias** y **recepciones de traslado** afectan disponible solo por
  operación autorizada. Un traslado no acredita el destino hasta registrar su
  recepción; una discrepancia no suma unidades faltantes.
- El **reintegro F3** opera tras recepción física y aptitud; el replay valida
  identidad, líneas y versión y no vuelve a aplicar stock.

## 2. Estructura

```text
src/
  main.ts                      arranque fail-closed + logger sanitizado + shutdown
  inventory-svc.controller.ts  GET /health, GET /health/readiness
  inventory.controller.ts      operaciones técnicas y comerciales (InventoryAuthGuard)
  inventory-admin.controller.ts  umbrales/dashboard/traslados (UserAuthGuard, userBearer)
  config/                      loadInventoryConfig (fail-closed)
  auth/                        InventoryAuthGuard, UserAuthGuard, decoradores, demo comercial
  reservations/ operations/ disponibilidad/ reintegros/  reglas de negocio
  umbrales/ dashboard/ incidencias/ traslados/           administración y consultas
  conciliacion/                política pura de consumo offline (sin HTTP)
  inbox/ outbox/ workers/      mensajería: consumer, outbox transaccional, workers
  drizzle/ database/ repositories/  persistencia Drizzle y transacciones
  errors/                      Problem Details + filtro
  logging/                     SanitizedLogger
```

## 3. Operaciones HTTP

Prefijo de las operaciones: `/api/v1` (el Gateway reenvía `originalUrl`). Los
`operationId` corresponden al OpenAPI vigente.

### 3.1 Técnicas y comerciales — `InventoryAuthGuard`

| operationId | Método y ruta | Seguridad | Estado |
|---|---|---|---|
| `consultarDisponibilidad` | GET `/inventario/disponibilidad` | serviceBearer VENTAS/POSTVENTA o userBearer humano | Implementado |
| `solicitarReserva` | POST `/inventario/reservas` | serviceBearer VENTAS + `Idempotency-Key` | Implementado |
| `confirmarReserva` | POST `/inventario/reservas/{reservaId}/confirmar` | serviceBearer VENTAS + `Idempotency-Key` | Implementado |
| `liberarReserva` | POST `/inventario/reservas/{reservaId}/liberar` | serviceBearer VENTAS + `Idempotency-Key` | Implementado |
| `consultarOperacionInventario` | GET `/inventario/operaciones/{operationId}` | serviceBearer VENTAS | Implementado |
| `reintegrarInventario` | POST `/inventario/reintegros` | serviceBearer VENTAS/POSTVENTA + `Idempotency-Key` | Implementado |
| `reportarIncidenciaInventario` | POST `/inventario/incidencias` | serviceBearer RETAIL | Implementado |
| `resolverIncidenciaInventario` | POST `/inventario/incidencias/{incidenciaId}/resolver` | serviceBearer RETAIL | Implementado |
| `consultarDisponibilidadComercial` | GET `/inventario/disponibilidad/comercial` | serviceBearer MARKETPLACE/CHATBOT/RETAIL (+ excepción demo) | Implementado |
| `verificarCantidadComercial` | POST `/inventario/disponibilidad/comercial/verificar` | serviceBearer MARKETPLACE/CHATBOT/RETAIL (+ excepción demo) | Implementado |
| `conciliarVentaOffline` | POST `/inventario/conciliaciones-offline` | (contractual) | **BLOQUEADO_ESPECÍFICO** — ver §6 |

### 3.2 Administrativas — `UserAuthGuard` (`userBearer`, rol `GESTOR_COMERCIAL`)

| operationId | Método y ruta | Capacidad local | Estado |
|---|---|---|---|
| `obtenerUmbralesInventario` | GET `/inventario/umbrales` | — | Implementado |
| `actualizarUmbralGlobal` | PUT `/inventario/umbrales/global` | — | Implementado |
| `establecerUmbralSku` | PUT `/inventario/umbrales/skus/{sku}` | — | Implementado |
| `eliminarUmbralSku` | DELETE `/inventario/umbrales/skus/{sku}` | — | Implementado |
| `obtenerDashboardInventario` | GET `/inventario/dashboard` | — | Implementado (filtros de Catálogo bloqueados) |
| `listarTrasladosInventario` | GET `/inventario/traslados` | `traslados:leer` | Implementado |
| `obtenerTrasladoInventario` | GET `/inventario/traslados/{trasladoId}` | `traslados:leer` | Implementado |
| `registrarRecepcionTrasladoInventario` | POST `/inventario/traslados/{trasladoId}/recepciones` | `traslados:recibir` | Implementado |

### 3.3 Salud

| Ruta | Tipo | Comportamiento |
|---|---|---|
| GET `/health` | liveness público | `200` mientras el proceso esté vivo; no verifica dependencias |
| GET `/health/readiness` | readiness público | `200` si PostgreSQL responde; `503` si no. El broker es opcional |

Nunca se exponen DSN, credenciales ni detalles internos.

## 4. Mensajería (AsyncAPI `0.6.0-rc.3` / Topología Oracle)

Cola principal consumida: `po.inventario.q` (prefetch 20, ACK manual tras el
commit de Inbox + saldo + operación + resultado Outbox).

**Produce (Outbox transaccional):**

| Evento | Emitido hoy |
|---|---|
| `inventory.stock.changed` | Sí |
| `inventory.reservation.created` | Sí |
| `inventory.reservation.consumed` | Sí |
| `inventory.reservation.released` | Sí |
| `inventory.reservation.expired` | Sí |
| `inventory.reservation.rejected` | Sí |
| `inventory.consumption.completed` | Sí |
| `inventory.sku.initialization.completed` | Sí |
| `inventory.sku.initialization.rejected` | Sí |
| `inventory.consumption.rejected` | **No** — el rechazo de consumo es sincrónico (HTTP `409`); no se emite por diseño |
| `inventory.stock.adjusted` | **No** — sin caso de uso que lo origine |
| `inventory.bulk.stock.adjust.completed`/`.rejected` | **No** — entrada Bulk bloqueada por contrato |

**Consume:**

| Evento | Estado |
|---|---|
| `inventory.sku.initialization.requested` | Handler implementado (crea saldo cero, versión 0) |
| `inventory.bulk.stock.adjust.requested` | **BLOCKED_CONTRACT** — AsyncAPI lo declara `GenericData`, sin semántica ejecutable |
| `catalog.sku.deactivated` | **BLOCKED_CONTRACT** — mismo motivo |

Ante mensaje inválido o contrato bloqueado, el consumer **pausa y cierra el
canal sin ACK**; se recupera con causa resuelta y `resume()` o reinicio
coordinado. `getMetrics()` expone contadores locales (conexión, pausa, ACK,
duplicados, rechazos, fallos, reconexiones). No hay endpoint/exportador de
métricas.

### 4.1 Topología física AMQP adoptada (Resolución #29 / AsyncAPI 0.6.0-rc.3)

El código de Inventory adopta la nomenclatura física en español oficial de Oracle y las ACLs del usuario `g6_inventario`:

| Elemento | Nombre físico en código (AsyncAPI 0.6.0-rc.3) | Referencia histórica (AsyncAPI 0.6.0-rc.2) | ACL del usuario `g6_inventario` | Estado |
|---|---|---|---|---|
| Cola de consumo | `po.inventario.q` | `po.inventory.q` | **read** `po.inventario.q` | **Alineado** |
| Exchange de eventos | `po.eventos.x` | `po.events.x` | **write** `po.eventos.x` | **Alineado** |
| Exchange de resultados | `po.resultados.x` | `po.results.x` | **write** `po.resultados.x` | **Alineado** |
| Configure | ninguno | ninguno | ninguno (`^$`) | **Cumplido** (el servicio no declara topología) |

*Nota histórica:* Previo a la actualización contractual AsyncAPI `0.6.0-rc.3` en `master` y la resolución #29, el código utilizaba temporalmente nombres en inglés (`po.inventory.q`, `po.events.x`, `po.results.x`), los cuales diferían de la topología física desplegada en Oracle. Esta discrepancia operativa quedó resuelta adoptando los nombres físicos españoles en el consumidor y publicador Outbox. Este servicio **no crea ni modifica** exchanges, colas, bindings ni ACLs.

La frontera HTTP/PostgreSQL es independiente del broker:

- `RABBITMQ_URL` es opcional al arranque; sin ella el proceso sirve HTTP y
  conserva los eventos en Outbox como `PENDING`.
- `GET /health/readiness` solo comprueba `SELECT 1` en PostgreSQL; no exige
  RabbitMQ ni marca `not_ready` por su ausencia.
- La pausa del consumidor no bloquea las operaciones HTTP ni las transacciones
  de persistencia.
- El estado AMQP se reporta aparte en `InventoryConsumerService.getMetrics()`.

Esto habilita desplegar y probar los flujos HTTP/DB mientras AMQP sigue
bloqueado; **no** acredita el flujo de eventos ni la homologación de topología.

## 5. Configuración

Todas las variables, su obligatoriedad, valor por defecto, comportamiento
fail-closed y owner están en **[`CONFIGURACION.md`](./CONFIGURACION.md)**.
Resumen de las más relevantes para integración:

| Variable | Uso |
|---|---|
| `DATABASE_URL` o `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD` (+ `PGSSLMODE`, `PGSSLROOTCERT`) | Pool PostgreSQL |
| `RABBITMQ_URL` | Publicación y consumo de eventos (opcional para arranque) |
| `G7_JWT_PUBLIC_KEY` / `JWT_PUBLIC_KEY`, `G7_JWT_ISSUER` | Verificación RS256 de endpoints protegidos |
| `INVENTORY_DEMO_NO_AUTH_ENABLED`, `INVENTORY_DEMO_GATEWAY_IPS` | Excepción de demo (#25) acotada a dos consultas comerciales |
| `INVENTORY_SVC_PORT`/`PORT`, `RESERVATION_TTL_SECONDS`, `DEFAULT_LOW_STOCK_THRESHOLD`, `INVENTORY_WORKER_*` | Runtime |

## 6. Estado de los issues y dependencias externas

Estados operativos según `AGENTS.md` §4 (`IMPLEMENTAR_AHORA` /
`IMPLEMENTAR_PARCIAL` / `BLOQUEADO_ESPECÍFICO`). Toda dependencia externa
identifica **owner · operación afectada · condición verificable de desbloqueo**.

| Issue | Estado | Implementación interna | Bloqueo externo (owner · operación · desbloqueo) |
|---|---|---|---|
| [#14](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/14) | IMPLEMENTAR_PARCIAL | Preparador offline y dry-run en `data/data-f1/`; 38 filas candidatas, `ready_for_load=false`, sin SQL | Poma/#12 confirma SKU vigentes · Marco/Infra aporta baseline y destino · autorización explícita antes de cualquier escritura en Supabase |
| [#25](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/25) | IMPLEMENTAR_PARCIAL | GET comercial y POST verificador sin JWT solo desde el peer Gateway (`INVENTORY_DEMO_GATEWAY_IPS`) | Marco/`api-gateway` #106/#107 · propagación de errores del verificador y exposición demo de Inventory · contrato/registro corregidos y prueba conjunta |
| [#30](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/30) | IMPLEMENTAR_PARCIAL | Ciclo M1 reserva/consumo/liberación/expiración, estados, errores, replay, correlación | G5/M1 + Marco · secuencia por canal y resultado definitivo · prueba bilateral con entorno identificado; G7 concede grants |
| [#31](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/31) | IMPLEMENTAR_PARCIAL | Consulta informativa M2 y reintegro F3 internos | G5/M2 · recepción/aptitud física y destino real de `location_id` · prueba bilateral; G7 concede scopes |
| [#97](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/97) | IMPLEMENTAR_PARCIAL | Config fail-closed, liveness/readiness, logging sanitizado | Infra · arranque/readiness con dependencias reales aisladas y Node admitido |
| [#98](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/98) | IMPLEMENTAR_PARCIAL | Mapping Drizzle, repositorios, transacciones, errores DB | Infra/CI · ejecutar suite PostgreSQL aislada (jobs de Actions ya la acreditan en el SHA publicado) |
| [#99](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/99) | IMPLEMENTAR_PARCIAL | Invariantes de saldo/reserva/incidencia/traslado/reintegro y política offline pura | Marco + G4/G5/G7 · identidad estable de venta offline, dedupe, actor y ubicación (DEC-F-009/014/015) · política y contrato ejecutables |
| [#100](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/100) | IMPLEMENTAR_PARCIAL | Lecturas, umbrales, dashboard, traslados y consultas comerciales | Poma/Catálogo · mapping producto/categoría/marca→SKU · Marco · métricas SPEC-016 ausentes del schema HTTP y errores de Gateway |
| [#101](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/101) | IMPLEMENTAR_PARCIAL | Escrituras contractuales salvo frontera offline | Marco + G4/G5/G7 · autorización offline · homologación antes de conectar la política pura a una mutación persistente |
| [#102](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/102) | IMPLEMENTAR_PARCIAL | Inbox/Outbox, inicialización SKU, workers, resiliencia | Marco + owners Bulk/Catálogo · payload tipado de bulk/deactivated · Infra y G5/#29 · homologación de topología y retry/DLX |
| [#103](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/103) | IMPLEMENTAR_PARCIAL | Límites, timeouts, errores sanitizados, contadores internos | Infra/G5 · validar fallos y recuperación con DB/broker reales; sin exporter/endpoint de métricas no contratado |
| [#104](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/104) | BLOQUEADO_ESPECÍFICO | Provider HTTP; adaptador Frontend de umbrales, KPIs autoritativos de dashboard, distribución `porUbicacion` y traslados con solicitud inmutable, confirmación separada de presentación (`TAC-P0-05`), protección `UNCERTAIN` y matriz de transición (`TAC-P0-02`/`TAC-P1-07`) (33 pruebas unitarias/flujo + 60 Playwright, SHA Frontend `db7c2e6`, `src/features/inventory/INTEGRACION_HTTP.md`); lecturas sin fuente contractual fallan con `CONTRATO_BLOQUEADO` | Marco · cliente compartido #109 y rutas #106/#107 · integración React↔Gateway validada (área Frontend) |
| [#105](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/105) | BLOQUEADO_ESPECÍFICO | Suites locales/provider (no son E2E real) | Marco/Infra · #104, stack aislado PostgreSQL/RabbitMQ, datos autorizados y #110 · recorrido real React→Gateway→Inventory→persistencia |

> El número de issues abiertos no mide ausencia funcional. Cada fila separa
> implementación interna, pruebas locales, integración autenticada, homologación
> y despliegue; ninguno se deduce de otro.

## 7. Ejecución y pruebas

Desde la raíz del monorepo (`PROYECTO_MARKETPLACE_BACKEND`):

```powershell
# Unitarias
npm test

# E2E en memoria (Nest + repositorios mock); NO es E2E real
npm run test:e2e

# Tipos, lint y formato
npm run typecheck
npm run lint
npm run format:check

# Build del servicio
npm run build:inventory-svc

# Suites focalizadas
npx vitest run apps/inventory-svc/test/inventory-http-contract.e2e-spec.ts
npx vitest run apps/inventory-svc/test/inventory-g5-provider.e2e-spec.ts
npx vitest run apps/inventory-svc/test/inventory-commercial-demo.e2e-spec.ts
npx tsc -p apps/inventory-svc/test/tsconfig.g5.json
npx tsc -p apps/inventory-svc/test/tsconfig.demo.json

# DATA-004 (#14) — preparador offline, sin conexión
node --test apps/inventory-svc/data/data-f1/dry-run.test.mjs
node apps/inventory-svc/data/data-f1/dry-run.mjs --baseline apps/inventory-svc/data/data-f1/baseline-empty.json --report dist/inventory-data-f1-dry-run.json
```

### 7.1 Suite de integración real (PostgreSQL + RabbitMQ)

`test/inventory.real.integration.spec.ts` se habilita solo con
`INVENTORY_REAL_INTEGRATION=1`. Aprovisiona PostgreSQL y RabbitMQ efímeros en
Docker (credenciales y vhost aleatorios, puertos loopback, cleanup por
etiqueta) y aplica las migraciones de `../docs/datos/inventory-svc/`. Requiere
Docker operativo y el repositorio hermano `docs` sincronizado.

El job `inventory-integration` de GitHub Actions ejecuta esta suite en
Ubuntu/Node 24.15.0 con PostgreSQL 17 y RabbitMQ 3.13 efímeros. **La ejecución
local sin `INVENTORY_REAL_INTEGRATION=1` omite esos casos**: una omisión no es
una prueba aprobada.

## 8. Límites explícitos (no afirmaciones)

- Este servicio **no** acredita: grants G7 reales, integración bilateral con G5,
  broker/topología productiva, retry/DLX productivo, despliegue Oracle ni el
  recorrido React→Gateway→Inventory→PostgreSQL/RabbitMQ.
- La suite E2E global usa un artefacto Gateway de prueba y persistencia en
  memoria: **no** es integración con DB/broker reales.
- No se modifican contratos, migraciones aplicadas ni datos del schema
  compartido (Supabase). Ninguna escritura en Supabase sin autorización expresa
  de Marco y proceso de release aprobado (#14).

## 9. Trazabilidad

- [`AUDITORIA_MARCO_2026-10-17.md`](./AUDITORIA_MARCO_2026-10-17.md) — auditoría por hallazgo y evidencia por runtime.
- [`AVANCE_BLOQUE_01.md`](./AVANCE_BLOQUE_01.md) … [`AVANCE_BLOQUE_06.md`](./AVANCE_BLOQUE_06.md) — avance por bloque.
- [`CONFIGURACION.md`](./CONFIGURACION.md) — variables y arranque fail-closed.
- [`data/data-f1/README.md`](./data/data-f1/README.md) — preparación DATA-004.

## Integración Marketplace H4

**Corte documental:** rama `taco`, código de operación auditado en `b02615841f63ea3249d9ad16a0cf32f4ea2b20c2` y corte Hito 4 en `7a546e78629683c8258df1a6d9beab24e74ef136`; PR #10 sigue abierto en draft. CI GitHub Actions del SHA `7a546e7` (run 39524047809): PASS en validación general, PostgreSQL Taxonomy e Inventory PostgreSQL/RabbitMQ. Este CI no demuestra deploy Oracle, grant G7 ni E2E G1.

| OperationId | Método/ruta | Identidad/scope de contrato | Semántica |
|---|---|---|---|
| `consultarDisponibilidadComercial` | GET `/api/v1/inventario/disponibilidad/comercial` | `modulo-marketplace`, `api-productos`, `inventario:disponibilidad:leer` y allowlist OpenAPI | Proyección sin saldos/ubicaciones; cuatro estados comerciales. |
| `verificarCantidadComercial` | POST `/api/v1/inventario/disponibilidad/comercial/verificar` | Mismo cliente/audiencia/scope contractual por operación | `channel_id=MARKETPLACE`, modo `ENVIO_DOMICILIO`, `fulfillment_ref` solo con contexto válido, `lines[]` SKU/cantidad; `binding=false`; SUFICIENTE no reserva. |

D-INV-01 exige resolver una única ubicación ejecutable; nunca sumar saldos independientes. Mapeo de cumplimiento ausente/ambiguo produce `INDETERMINADO` (resultado comercial HTTP 200), no `AGOTADO` ni error de red. Contexto semánticamente inválido puede responder 422 según OpenAPI. El origen/semántica de `fulfillment_ref` no se inventa y se registra con owner G2/G5/G6 y cierre en [matriz H4](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/castilla/integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md).

`INVENTORY_DEMO_NO_AUTH_ENABLED` / allowlist de IP del Gateway es bypass demo limitado, no JWT real ni evidencia H4. G7 debe acreditar token y grant efectivos. CI PostgreSQL/RabbitMQ y pruebas locales no son deploy ni E2E Marketplace; documentar image digest/ambiente y recorrido BFF separadamente.
