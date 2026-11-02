# Avance de issues de Axel — 01/11/2026

Rama `cueva`, base de validación `b4cc18f070667602c31af41331c5b483e5abed18` más los cambios de esta entrega, probados antes de su publicación. Este corte reemplaza los pendientes anteriores de este día. Seguridad/G7 queda diferida por instrucción de Axel. La publicación y el SHA resultante se registran en la PR #143.

Normativa: Docs `5124eeae4ec65b22ea9146cd7b1ce3888c617c10` (PR #106), OpenAPI `0.6.0-rc.2`, blob `54164d48c7919854ac4636a27162ab880cb202aa`, y AsyncAPI `0.6.0-rc.4`, blob `52443be2510c6ca344b4cd18689c21d8245d5766`. Aplican DEC-F-007/008/009/012 y DEC-G6-INT-01–13.

## Implementación y condiciones de cierre

| Issue                       | Avance comprobado                                                                                                                                                                                                                                                                                                             | Pendiente para cerrar y responsable                                                                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #15 DATA                    | Preparación, validación, reconciliación y rollback de seis maestros inactivos. Locking reforzado contra rol ausente y escape mediante SET ROLE de login NOINHERIT; runtime separado y contención real probados.                                                                                                               | **Poma/Vera/Taco:** referencias, precio, canal, vigencia y disponibilidad actuales verificables. **BD/Marco:** aprobación del locking y del lote/hash/destino/proceso antes de cargar. La aceptación condicionada de López no autoriza ejecución.                                 |
| #33 Cupones AMQP            | Consumo/restauración, concurrencia, D-04, idempotencia, recibos/Inbox/Outbox y ACK tras commit. Reintento local transitorio limitado a tres intentos totales con backoff; luego pausa/alerta sin ACK.                                                                                                                         | **G5/Inventario + Marco:** fuente contractual operativa de reserva definitivamente confirmada y snapshot durable vinculados al pedido. **Infra/productores:** procedencia, ACL/red, bindings y prueba bilateral. Runtime sigue protegido.                                         |
| #72 Reglas                  | Invariantes y motor interno de composición; recomendaciones con variantes y mínimo efectivo desarrolladas según INT-02/03.                                                                                                                                                                                                    | **Marco/consumidores:** aceptación verificable de promotion_id singular y validación operativa de límites antes de conectar composición multibeneficio al HTTP público. Límites: 12 campañas, 100 líneas, 250000 unidades, 100 ms.                                                |
| #73 Consultas               | Diez handlers; proveedor HTTP registrado con URLs explícitas de Catálogo/Pricing/Inventario. Resuelve SKU→producto, preserva SKU opaco y clasifica incoherencia producto/SKU como 400. Recomendaciones excluyen falta de evidencia positiva, sin inventar AGOTADO ni precio cero.                                             | **Poma/Vera/Taco:** servicios conformes a rc.2, contexto/canales conectados, URLs y datos operativos. Prueba compartida de cada tramo con SHA. G7 se registra aparte.                                                                                                             |
| #74 Escrituras              | Doce handlers y adaptador administrativo registrado sobre obtenerProducto, obtenerContextoSku y obtenerCategoriaAdmin. Valida DTO/identidad/actividad; 404 contractual excluye referencia, fallo técnico produce 503 sin guardar. Cupones y desactivaciones independientes de estas lecturas.                                 | **Poma/López:** proveedores conformes y disponibles, incluyendo operación/permisos actualizados; prueba compartida de alta/edición/activación y referencias inactivas. El selector del navegador no reemplaza la autoridad.                                                       |
| #75 Eventos                 | Cuatro adaptadores rc.4 registrados detrás de gates. Bajas Catalog con versiones de entidad separadas. Price/stock generan invalidación durable en Inbox, sin reconstruir precios ni disponibilidad desde snapshots parciales. Datos inválidos con envelope válido se rechazan duraderamente antes de ser elegibles para ACK. | **Poma/Vera/Taco:** emisiones conformes y transición coordinada. **Marco/infra:** procedencia, ACL/red y prueba bilateral antes de activar. **BD/Marco:** mecanismo aprobado para registrar envelopes brutos que no caben en Inbox; actualmente pausan sin ACK, sin inventar DLX. |
| #76 Robustez/observabilidad | Timeouts/cancelación, logs sanitizados, probes técnicos, cierre ordenado, aviso de Outbox pendiente por racha y reintentos limitados. Salud técnica y disponibilidad funcional separadas.                                                                                                                                     | **Infra/Marco:** colector/alertas y evidencia operativa de desconexión/recuperación. No se crean /health/live ni /health/ready fuera de OpenAPI.                                                                                                                                  |
| #77 React/Gateway           | Circuito local de navegador React→Gateway→Promotions→PostgreSQL PASS: CRUD/estados y persistencia tras recarga, con errores visibles; una prueba comercial y cinco desde la entrada real. Frontend/Gateway sin cambios.                                                                                                       | **Integración + owners:** circuito compartido con providers/datos conformes y evidencia por SHA; JWT compartido diferido. Los fixtures locales no acreditan ese entorno.                                                                                                          |
| #78 E2E / #144 demo         | Desarrollo local explícito sin JWT en loopback. Suite HTTP/PG con proveedores reales del módulo y servidores HTTP fixture; éxito, referencias inválidas, fallo sin escritura y cesta solo SKU. Suites PG/Rabbit desechables conservadas.                                                                                      | **Marco/infra + owners:** datos y entorno acordados, release autorizado por SHA/digest y E2E compartido reproducible. Sin despliegue ni carga compartida en esta entrega.                                                                                                         |

## Fronteras implementadas

- Transporte HTTP por servicio con timeout total, cancelación, máximo de 1 MiB, JSON UTF-8 válido y sin redirects. El modo normal requiere token propio; nunca reenvía el bearer entrante. Demo explícita restringe destinos a loopback/alias de servicio.
- Sin configuración necesaria se conserva 503. Los fixtures están exclusivamente en pruebas; no sustituyen las fuentes de producción.
- Stock se invalida por SKU conservando location_id y stock_version. Price se invalida por SKU/canal; PRODUCTO invalida conservadoramente el canal mientras no exista un mapa local completo producto→SKU. Precio global invalida todos los canales del destino.
- Una proyección invalidada devuelve ausencia de caché. Los casos comerciales consultan HTTP autoritativo. No se rehabilita caché desde snapshots de eventos ni existe aún un refresco homologado. No se modificaron tablas, migraciones ni grants.
- El rechazo durable registra `handled:false`, `rejected:true` y motivo interno en Inbox.result, sin presentar una proyección aplicada. Un fallo SQL revierte y no habilita ACK.
- Mensajes malformados o sin procedencia válida no se reintentan ciegamente. Sin almacenamiento aprobado permanecen sin ACK y se pausa el canal. El rechazo durable nuevo cubre los cuatro eventos asignados; las validaciones previas de comandos de cupón se conservan.

## Validación del código final

| Comando                                                                                     | Resultado                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test -- apps/promotions-svc --maxWorkers=1`                                            | 310 PASS                                                                                                                                                                                                                                       |
| `npm test -- --maxWorkers=1`                                                                | 1039 PASS, 17 omisiones optativas                                                                                                                                                                                                              |
| `npm run test:e2e -- --maxWorkers=1`                                                        | 397 PASS, 87 omisiones optativas                                                                                                                                                                                                               |
| `npm run typecheck`, `npm run lint`, `npm run build:promotions-svc`                         | PASS; lint sin advertencias                                                                                                                                                                                                                    |
| `npm run build:api-gateway`                                                                 | PASS; sin cambios en Gateway                                                                                                                                                                                                                   |
| `node apps/promotions-svc/test/persistence.isolated.smoke.mjs`                              | 20 grupos PASS: PostgreSQL 17/TLS, runtime restringido, cuatro eventos H4 y proveedores HTTP del módulo                                                                                                                                        |
| `node apps/promotions-svc/test/coupons.isolated.smoke.mjs`                                  | 23 grupos PASS: PostgreSQL 17.11 y RabbitMQ 4.1 desechables                                                                                                                                                                                    |
| Runner de persistencia con `G6_PROMOTIONS_GATEWAY_E2E=true` y `G6_PROMOTIONS_FRONTEND_ROOT` | 25 grupos PASS; navegador comercial 1 PASS y entrada real 5 PASS. Frontend ca6d4d6cfcdd7d5a240bb1ce6f2d9592b28f0ecd CLEAN; backend base más working tree MODIFIED. Sesión G7 usa fixture contractual explícito, sin integración G7 compartida. |
| Locking DATA y regresión offline ejecutadas en esta entrega                                 | 9 grupos PostgreSQL + 50 pruebas offline PASS; sin carga compartida                                                                                                                                                                            |

Se usó TEMP/TMP de la tarea y ejecución fuera del sandbox para HTTP loopback y Docker. Un intento falló por caché temporal EPERM antes de ejecutar tests. Los primeros tests de recuperación usaron un reloj simulado que no controlaba node:timers/promises; se corrigieron para observar temporizadores reales y se repitió la suite. No se omitieron pruebas fallidas.

## Estados independientes

Implementación interna: **IMPLEMENTAR_PARCIAL**, con los avances anteriores. Pruebas locales: las detalladas arriba. Integración compartida/autenticada: **no acreditada**. Homologación externa: **pendiente**. La CI del SHA publicado se registra separadamente en la PR #143; los resultados locales no la sustituyen. Despliegue: **no ejecutado**. No se cerraron issues ni cambiaron otros servicios. Axel autorizó publicar los cambios en PR después de este corte de validación.

Cambios: `apps/promotions-svc/` y archivos propios de propuesta/test DATA en `scripts/seed/mcp/promotions/` autorizados por #15. Ver [guía local](DESARROLLO-LOCAL.md) y [respuestas y trazabilidad](RESPUESTAS-Y-AVANCES-2026-11-01.md).

## Archivos modificados

- `apps/promotions-svc/AVANCE-ISSUES-2026-11-01.md`
- `apps/promotions-svc/DESARROLLO-LOCAL.md`
- `apps/promotions-svc/RESPUESTAS-Y-AVANCES-2026-11-01.md`
- `apps/promotions-svc/ROBUSTEZ-OBSERVABILIDAD.md`
- `apps/promotions-svc/src/coupons/assigned-event-dispatcher.ts`
- `apps/promotions-svc/src/coupons/assigned-h4-contract.generated.ts`
- `apps/promotions-svc/src/coupons/catalog-h4-adapters.spec.ts`
- `apps/promotions-svc/src/coupons/catalog-h4-adapters.ts`
- `apps/promotions-svc/src/coupons/coupon-consumer.ts`
- `apps/promotions-svc/src/coupons/coupon-outbox-pump.spec.ts`
- `apps/promotions-svc/src/coupons/coupon-outbox-pump.ts`
- `apps/promotions-svc/src/coupons/coupon-providers.ts`
- `apps/promotions-svc/src/coupons/coupon-recovery.spec.ts`
- `apps/promotions-svc/src/coupons/h4-event-adapters.spec.ts`
- `apps/promotions-svc/src/coupons/h4-event-adapters.ts`
- `apps/promotions-svc/src/coupons/schema-validator.ts`
- `apps/promotions-svc/src/domain/commercial-context.ts`
- `apps/promotions-svc/src/http/local-demo.spec.ts`
- `apps/promotions-svc/src/http/promotions-identity.ts`
- `apps/promotions-svc/src/http/query-controller.ts`
- `apps/promotions-svc/src/infrastructure/config/promotions-config.spec.ts`
- `apps/promotions-svc/src/infrastructure/config/promotions-config.ts`
- `apps/promotions-svc/src/infrastructure/http/admin-references-http.spec.ts`
- `apps/promotions-svc/src/infrastructure/http/admin-references-http.ts`
- `apps/promotions-svc/src/infrastructure/http/commercial-http.spec.ts`
- `apps/promotions-svc/src/infrastructure/http/commercial-http.ts`
- `apps/promotions-svc/src/infrastructure/http/integration-providers.spec.ts`
- `apps/promotions-svc/src/infrastructure/http/integration-providers.ts`
- `apps/promotions-svc/src/infrastructure/http/internal-http.ts`
- `apps/promotions-svc/src/infrastructure/http/upstream-contract.generated.ts`
- `apps/promotions-svc/src/infrastructure/persistence/repositories.ts`
- `apps/promotions-svc/src/infrastructure/resilience/commercial-deadline.spec.ts`
- `apps/promotions-svc/src/infrastructure/resilience/commercial-deadline.ts`
- `apps/promotions-svc/src/main.ts`
- `apps/promotions-svc/src/promotions-svc.module.ts`
- `apps/promotions-svc/test/generate-assigned-h4-contract.mjs`
- `apps/promotions-svc/test/generate-upstream-contract.mjs`
- `apps/promotions-svc/test/local-demo.e2e-spec.ts`
- `apps/promotions-svc/test/persistence.isolated.smoke.mjs`
- `apps/promotions-svc/test/support/h4-invalidation-checks.mjs`
- `apps/promotions-svc/test/support/http-upstream-checks.mjs`
- `scripts/seed/mcp/promotions/PROPUESTA-LOCKING-SEED.md`
- `scripts/seed/mcp/promotions/test/evidence/seed-locking-proposal-2026-11-01.json`
- `scripts/seed/mcp/promotions/test/seed-locking-proposal.mjs`
- `scripts/seed/mcp/promotions/test/support/seed-locking-proposal.sql`
