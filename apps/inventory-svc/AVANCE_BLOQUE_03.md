# Bloque 03 — Inbox, eventos y recuperación de Inventario

Fecha: 17 de octubre de 2026. Rama: `taco`. Base: `4d5d601` (bloque 02).

Issues: [#102](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/102) y [#103](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/103), consultados en GitHub en su versión del 17 de octubre. Estado de entrega: **PARTIAL**. El commit que incorpora este informe identifica la evidencia local; no cierra ninguno de los issues.

## Contratos y alcance

Se respetan `AGENTS.md`, ownership de Taco (`apps/inventory-svc`) y rama personal permanente. Docs consultado: `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`; AsyncAPI `0.6.0-rc.2`, `contratos/eventos/rabbitmq-topologia.md`, SPEC-015, registro DEC-F y modelo físico/migraciones oficiales de Inventario. DEC-F-002/009/010 fijan respectivamente autoridad de stock, idempotencia por identidad/intención/contenido y responsabilidad del TTL/expiración; las fronteras externas no se consideran homologadas.

Clasificación: `IMPLEMENTAR_PARCIAL`. Se implementan las reglas internas definidas y la entrada tipada de inicialización SKU. Ajustes Bulk y desactivación de SKU se mantienen como `BLOQUEADO_ESPECÍFICO`: sus mensajes usan `GenericData`, sin campos y semántica suficientes para un handler. No se inventaron DTOs, eventos, códigos HTTP, endpoints ni migraciones.

## Cambios implementados

- Inicialización SKU: valida envelope, productor declarado, operación, SKU/producto y ubicación; crea saldo cero/versión cero mediante `INSERT ... ON CONFLICT DO NOTHING`; nunca reinicia un saldo existente ni escribe Kardex artificial de cantidad cero. Sin ubicación explícita solo resuelve si existe una única ubicación activa; en otro caso guarda rechazo de negocio.
- Inbox/operación/saldo/Outbox se persisten en una sola transacción. Se usan locks transaccionales por mensaje y operación. Mismo mensaje/contenido es duplicado sin efectos; mismo identificador con contenido alterado falla. Otro mensaje con la misma operación compatible devuelve el resultado durable con la nueva `causation_id`. Una operación reutilizada con datos incompatibles devuelve rechazo sin modificar la operación original. Resultado durable corrupto provoca fallo técnico.
- Consumer AMQP con cola preexistente, prefetch 20 y ACK posterior al commit. Duplicados y rechazos de negocio durables reciben ACK. Fallos técnicos, JSON inválido y contratos bloqueados pausan y cierran sin ACK. Reconecta a 30 s por desconexión; la pausa exige intervención/resume/reinicio. No se implementó el circuito de tres retries/30 s/DLX, pendiente de homologación; no se presenta la pausa como su equivalente.
- `inventory.stock.changed` ahora incluye SKU, ubicación, on_hand, reserved, blocked, available, estado, stock_version y updated_at. Se conserva en la transacción en reservas, confirmación, liberación, expiración, reintegros, incidencias, recepción de traslados e inicialización. La expiración comparte operation_id entre sus eventos de saldo y reserva.
- Publicación Outbox con confirm/mandatory, persistencia y message_id estable; espera acotada también para el publicador inyectado y creación/cierre de canal. Los fallos conservan PENDING. Se distinguen ausencia de configuración y fallos de dependencias/consulta mediante `reason` interno.
- Timeout PostgreSQL para conexión, sentencia, locks y consulta; listener de errores del pool. Expiración propaga el fallo de consulta en vez de informar cero reservas. Worker continúa Outbox aunque falle expiración y contabiliza fallos/ciclos/duración sin solapar ciclos.
- Logs nuevos sanitizados y correlación UUID al pausar por fallo. Nunca se registra el cuerpo del comando; JSON inválido no expone el fragmento que puede incluir SyntaxError. Contadores accesibles internamente; no hay endpoint ni exportador de métricas.

## Archivos modificados

Todos bajo `apps/inventory-svc/`:

- Nuevos `src/inbox/inventory-command.service.ts`, `inventory-consumer.service.ts` y sus pruebas: handler transaccional y transporte.
- `src/repositories/{drizzle/drizzle-inbox.repository,interfaces/inbox.repository.interface}.ts`: se integran y ajustan los dos archivos Inbox preexistentes que estaban sin seguimiento; ahora forman parte de este bloque.
- `src/repositories/{drizzle/drizzle-stock-balance.repository,interfaces/stock-balance.repository.interface}.ts`: inserción inicial sin reemplazo del saldo.
- `src/outbox/{outbox.service,outbox-publisher.service}.ts`, `outbox-publisher.spec.ts` y nuevo `stock-changed.spec.ts`: snapshots, límites y recuperación.
- `src/{reservations,reintegros,incidencias,traslados}/*.service.ts`: emisión transaccional del snapshot completo; prueba de expiración ampliada.
- `src/database/database.service.ts` y `.spec.ts`, `src/workers/inventory-workers.service.ts`, `inventory-workers.spec.ts` y nuevo `deadline.ts`: resiliencia y observabilidad interna.
- `src/inventory-svc.module.ts`, `test/in-memory-database.mock.ts`, `CONFIGURACION.md` y este informe: cableado, soporte de pruebas y condiciones operativas.

El cambio preexistente de `test/inventory.real.integration.spec.ts` sigue intacto y queda excluido del commit: SHA-256 `07C4C9A86E66895349C259B3295EDFD62DE1A6E6790E48A1D960B39BF8E763AA`.

## Validaciones

| Comando | Resultado final |
| --- | --- |
| Pruebas focalizadas de Inbox/consumer, worker, Outbox, DB y expiración | PASS; ACK posterior a commit, duplicados, rollback, rechazo durable, recuperación, pausa, reconexión, timeout y no solapamiento |
| `npm.cmd test` | PASS: 221 pruebas; 18 omitidas; 31 archivos aprobados y uno omitido |
| `npm.cmd run test:e2e` | PASS: 69 pruebas en 10 archivos |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS |
| `npm.cmd run format:check` | PASS |
| `npm.cmd run build:inventory-svc` | PASS |
| `git diff --check` | PASS al cierre |
| Broker efímero, PostgreSQL real, CI remoto e integración autenticada | NO EJECUTADO |

La primera prueba nueva de liberación omitía el motivo obligatorio: se corrigió el dato de prueba a `ANULACION` y pasó. La primera revisión general detectó formato pendiente en Outbox y una advertencia de spread innecesario; ambos se corrigieron antes del cierre. Las pruebas nuevas usan transporte y persistencia simulados; no demuestran concurrencia real de PostgreSQL ni entrega real de RabbitMQ.

Node local `22.16.0`, inferior al rango declarado por el repositorio. No se cambiaron runtime ni dependencias. Docker permanece sin autorización de acceso tras el rechazo del bloque anterior; no se repitió la solicitud ni se ejecutaron los 18 casos opt-in.

## Dependencias y condiciones de desbloqueo

| Owner | Frontera pendiente | Condición verificable |
| --- | --- | --- |
| Marco/contratos y Castilla (Bulk) | `inventory.bulk.stock.adjust.requested` y sus resultados | Payloads tipados, reglas por línea/lote, versiones, errores y correlación acordados y pruebas provider/consumer |
| Marco/contratos y Poma (Catálogo) | `catalog.sku.deactivated` | Payload y efecto definido sobre saldo/reservas, idempotencia y resultado esperado |
| Marco/contratos y Poma (Catálogo) | Identificadores de inicialización | Resolver AsyncAPI string vs UUID físico en message_id/correlación; probar mensajes reales emitidos por Catálogo |
| Infraestructura G6 / #110 y G5 / #29 | Broker, vhost, grants, bindings, retry/DLX y consumidor externo | Evidencia de provisión y pruebas con broker real; homologación explícita de retry/DLX antes de activarlos |
| Taco / entorno de validación | Prueba aislada obligatoria del broker y PostgreSQL | Acceso autorizado a Docker y ejecución de suite real con Node admitido |
| Seguridad G7 e Infraestructura | Integración autenticada de HTTP | Claves, issuer, grants y JWT reales provisionados y pruebas de las vías autorizadas |
| Taco/operación de Inventario | Exportación de métricas y validación CI | Canal de instrumentación acordado sin nuevo endpoint contractual y suite ejecutada en CI |

`inventory.consumption.rejected` sigue pendiente como resultado de una operación admitida que termine rechazada; los rechazos previos a admisión conservan HTTP/Problem Details. No se fabricó un resultado asíncrono para solicitudes no admitidas. Los resultados de Bulk no se publican sin handler contractual.

Implementación interna: parcial, con cambios enumerados terminados. Pruebas locales: aprobadas con las omisiones indicadas. Integración autenticada, homologación externa y despliegue: no acreditados. No hay errores locales obligatorios pendientes. No hubo cambios fuera de Inventario, push, PR, merge, cierre de issues ni escritura en infraestructura compartida.
