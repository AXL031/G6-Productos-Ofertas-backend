# Bloque 02 — Invariantes y contratos HTTP de Inventario

Fecha: 17 de octubre de 2026. Rama: `taco`.

Issues: [#99](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/99), [#100](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/100) y [#101](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/101).

## Referencias y entrega

Base local: `a47f870`, commit del bloque 01, registrado con autorización de Taco. Los tres issues se consultaron en su versión vigente en GitHub, actualizada el 17 de octubre; sus prerrequisitos para programar constan como ninguno. Las dependencias de integración no se usan como bloqueo general del desarrollo interno.

Docs local y `master` remoto: `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`. Se contrastaron:

- `AGENTS.md` de Backend y alcance actual de los tres issues.
- OpenAPI `0.6.0-rc.1`: consulta detallada, operaciones, umbrales, dashboard, traslados y mutaciones; schemas de respuestas, seguridad `userBearer`/`serviceBearer`, scopes y allowlists.
- `SPEC-015`, `HU-015`, `FLOW-015` y arquitectura consultados en el bloque anterior; en particular SPEC §7.2 y §24.5, HU CA-29–35 y CA-49–56.
- `contratos/http/Contrato_Api.md`: identidad humana y rol `GESTOR_COMERCIAL`.
- `REGISTRO_DEC_F.md` y `MATRIZ_TRAZABILIDAD_DEC_F.md`: DEC-F-002/009/010/013/014/015 y los límites de la conciliación offline.
- AsyncAPI `0.6.0-rc.2`: referencias de eventos existentes; las brechas del ciclo de publicación quedan identificadas para #102.

El commit que incorpora este informe identifica la entrega. No se hizo push, PR, merge, cierre de issues, despliegue ni escritura en una base compartida.

## #100 — Consultas y autorización

- Se conserva `InventoryAuthGuard` en el controlador técnico. Únicamente la consulta detallada, que declara ambos esquemas en OpenAPI, habilita también el guard humano mediante metadatos explícitos.
- La vía humana ahora verifica issuer configurado, firma, audiencia, vencimiento, identidad y rol `GESTOR_COMERCIAL`. Las capacidades locales de traslados se exigen además del rol. Los JWT de servicio no se aceptan como humanos; los humanos no acceden a operaciones técnicas ni crean reservas por esta vía.
- Se rechazan JWT expirados cuando `now >= exp`, expiraciones no finitas y estructuras JWT que no sean objetos.
- La consulta detallada exige ubicación explícita cuando los saldos abarcan más de una ubicación (SPEC §7.2); no se toma una ubicación arbitraria. Se validan los filtros UUID de disponibilidad, dashboard y traslados antes de enviarlos a PostgreSQL.
- La recuperación durable conserva el mapeo de estados, incluyendo `REQUIRES_REVIEW`. Registros históricos sin fechas válidas, pedido utilizable o `result_code` requerido para `REJECTED` se tratan como resultado histórico insuficiente, con el 404 ya utilizado por ese caso; no se publica una respuesta contraria al schema.
- Los errores técnicos no reflejan sus mensajes al consumidor. Errores conocidos de conexión/indisponibilidad se traducen al `503 SERVICIO_NO_DISPONIBLE` publicado; los demás mantienen `500 ERROR_INTERNO` sin detalles internos.

Los tests existentes de disponibilidad positiva se ajustaron para enviar una ubicación explícita, preservando sus aserciones. Nuevos tests verifican tanto el rechazo de la ambigüedad como la consulta sin ubicación cuando existe una sola.

## #99/#101 — Invariantes y escrituras existentes

- Se corrigen las líneas nulas/arrays y UUID representados como arrays para que reservas y reintegros devuelvan `400 VALIDACION` antes de persistir, en lugar de fallar con TypeError o errores de PostgreSQL.
- Reservas, reintegros, incidencias y recepciones rechazan cantidades que JavaScript no puede representar como enteros seguros. Se conservan los códigos de error contractuales de cada operación.
- Las regresiones HTTP comprueban que las entradas inválidas no cambian saldos, reservas, operaciones, Kardex ni Outbox. Se mantiene la implementación transaccional/idempotente previa, las allowlists y la referencia opaca de pedido de Ventas.
- Se implementa y prueba la política **interna y pura** `planOfflineConsumption`, correspondiente a SPEC §24.5: aplica únicamente stock libre, conserva lo no aplicado para revisión, no consume unidades reservadas/bloqueadas y no propone movimiento de cantidad cero. Se comprueban invariantes en 1365 combinaciones de saldos/cantidades válidas, además de casos inválidos.

La política offline no está conectada a HTTP, persistencia ni mensajería. No implementa deduplicación de venta ni decide identidad, mapeo de tienda o autorización. DEC-F-013/014/015 prohíben inferir esas decisiones; no se creó un endpoint operativo inseguro ni una nueva clave/índice/DTO para aparentar integración.

## Archivos del bloque

Todos dentro de `apps/inventory-svc/`:

- `src/auth/{auth.constants,auth.decorators,inventory-auth.guard,user-auth.guard,user-token-verification}.ts`: separación de vías y validación criptográfica/claims.
- `src/inventory.controller.ts`: vía humana acotada a la consulta declarada en OpenAPI.
- `src/disponibilidad/disponibilidad.service.ts`, `.spec.ts` y `src/dashboard/dashboard.service.ts`: ubicación inequívoca y filtros.
- `src/operations/operations.service.ts` y `.spec.ts`: respuestas durables válidas y pruebas de estados/histórico.
- `src/errors/problem-details.filter.ts`: respuestas técnicas minimizadas y 503 contractual.
- `src/{reservations,reintegros,incidencias,traslados}/*.service.ts`: validaciones locales de las operaciones existentes.
- Nuevos `src/conciliacion/offline-consumption.policy.ts` y `.spec.ts`: regla interna offline; sin frontera pública conectada.
- Nuevo `test/inventory-http-contract.e2e-spec.ts`: regresiones HTTP de seguridad, lectura y entradas inválidas.
- `test/app.e2e-spec.ts` y `test/crypto-test-token.helper.ts`: ubicación explícita y claims de prueba.
- `CONFIGURACION.md` y este informe: condiciones de acceso y evidencia.

## Validaciones finales

| Comando desde Backend | Resultado |
| --- | --- |
| `npm.cmd test` | PASS: 191 pruebas; 18 omitidas; 28 archivos aprobados y uno omitido |
| `npm.cmd run test:e2e` | PASS: 69 pruebas en 10 archivos |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS |
| `npm.cmd run format:check` | PASS |
| `npm.cmd run build:inventory-svc` | PASS |
| `git diff --check` | PASS al cierre |
| PostgreSQL/RabbitMQ reales, integración autenticada externa y despliegue | NO EJECUTADO |

Las pruebas HTTP usan Nest, firmas RSA de prueba y persistencia de prueba en memoria; no acreditan credenciales G7 ni bases reales. Node local: `22.16.0`, fuera del rango declarado por Backend; se mantiene pendiente validar con Node admitido y dependencias reales. No se actualizaron runtime ni dependencias.

Se conservaron sin editar y con los mismos SHA-256 del bloque 01 los cambios preexistentes en `test/inventory.real.integration.spec.ts`, `src/repositories/drizzle/drizzle-inbox.repository.ts` y `src/repositories/interfaces/inbox.repository.interface.ts`. No se incluyen en el commit de este bloque.

## Estado y pendientes concretos

**PARTIAL**: las correcciones locales y pruebas enumeradas están completas; los issues amplios permanecen abiertos.

- **#99/#101, conciliación offline:** Marco y owners G4/G5/G7 deben homologar identidad estable/ámbito de unicidad de la venta, correlación con `offline_sale_id`, invocador, resolución/autorización de ubicación y representación mínima. Desbloqueo: contrato y decisiones verificables que permitan persistir/deduplicar sin segundo descuento ni acceso indebido. La política interna ya puede desarrollarse/probarse independientemente.
- **#99/#102, inicialización/ajustes/eventos:** todavía requieren implementar los handlers contractuales de inicialización SKU y ajuste absoluto de Bulk, y completar `inventory.stock.changed` a lo largo del ciclo. No se declara que las invariantes completas de #99 hayan quedado acreditadas por este bloque.
- **#100, filtros de Catálogo en dashboard:** producto/categoría/marca siguen sin proveedor que resuelva sus SKU. Owner: Catálogo/Poma y composición Gateway. Se desbloquea con un puerto/contrato ejecutable y pruebas; no se consultan tablas ajenas ni se ignoran los filtros.
- **G7:** falta provisión/grants y validación de JWT reales con rol/capacidades, issuer, firma, audiencia y scopes del consumidor. No se deduce de los tokens sintéticos usados en los tests.
- **Entorno real:** permanece pendiente acceso autorizado a Docker y ejecución aislada con PostgreSQL/RabbitMQ y una versión de Node admitida; no se repitió la solicitud de acceso rechazada en el bloque anterior.
- **Taco:** cada push a `taco` requiere permiso previo; PRs y merges a `master` son exclusivos del usuario. No se hizo ningún cambio fuera del ownership de Inventario.
