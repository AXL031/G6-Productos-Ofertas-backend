# Decisiones de Marco registradas el 26/10/2026

Owner de implementación: Axel Cueva, rama cueva. Fuente: respuesta de Marco aportada por Axel en esta conversación; Axel autorizó registrar las decisiones y ejecutar el trabajo interno independiente. SHA-256 de los bytes de la comunicación: 7b18ed7af01e96ea9c8cc08cfab9a34d1bb8957a897eccc3de09780dcac00542.

Este registro no es una DEC-F nueva, una revisión de GitHub, homologación de consumidores ni autorización de carga, grants compartidos o release. Se mantienen las implementaciones y contratos existentes. Las decisiones se trasladan por separado a sus issues mediante gh; los estados externos no se infieren de la aprobación interna.

## #72 — composición v1 adoptada internamente

Marco aprueba la regla de PROPUESTA-COMBINACION.md: compatibilidad bilateral explícita por pareja; descuentos sucesivos sobre saldo elegible; orden ascendente por prioridad e ID estable; porcentaje sobre saldo; fijo una vez, limitado al saldo y repartido proporcionalmente. Evaluar subconjuntos permitidos y elegir el menor importe final con los desempates de v1.

Aritmética exacta; PEN escala 2 y otras monedas con escala explícita. Redondeo final mitad hacia arriba y reparto por mayor resto. promotion_id representa la primera promoción que aportó descuento según prioridad/ID, o null con solo Pricing/sin promoción. La validación individual del cupón conserva la identidad de su campaña real.

**IMPLEMENTAR_AHORA:** verificar el motor y proyección monetaria ya existentes contra esta decisión. La verificación inicial pasó 85 pruebas en cinco archivos: 26 de composición, siete monetarias y 52 de reglas/gates de runtime/dispatcher. El motor y la proyección no requirieron cambios para satisfacer la regla.

**BLOQUEADO_ESPECÍFICO:** activar composición en HTTP. Marketplace, Chatbot, Retail y Ventas/Postventa deben acreditar compatibilidad del identificador singular; si requieren reconstruir todos los beneficios, se necesita un desglose contractual versionado y homologado. Los límites técnicos de búsqueda conservados requieren revisión operativa antes de activar HTTP. No se crea un campo de respuesta ni se retira el gate actual.

## #73/#74 — HTTP e identidad

Se conservan operaciones y DTOs existentes. Para #73, consultas candidatas obtenerProducto, obtenerPrecioSku y consultarDisponibilidadComercial; nunca SQL cross-schema. #74 requiere fuentes administrativas autoritativas para existencia/actividad/consistencia de productos, SKU y categorías; selectores frontend no son evidencia autoritativa.

Poma, Vera, Taco, López y G7 deben concretar operación, identidad propia de Promotions, audiencia/scopes/allowlists y prueba autenticada. Las escrituras siguen userBearer/GESTOR_COMERCIAL. Sin identidades de canal prestadas, reenvío indiscriminado de tokens, endpoints nuevos o bypasses. Axel implementa los adaptadores cuando esa frontera esté definida; mientras tanto siguen bloqueados.

## #29/#33/#75 — AMQP

Se conservan po.comandos.x, po.eventos.x, po.resultados.x, po.sin-ruta.x; vhost g6-productos-ofertas y cola po.promociones.q. No se modifica el broker.

Marco/infra y G7 deben acreditar identidad/ACL mínimos y conectividad; G5/productores deben homologar bindings/routing keys y cuatro payloads/versiones. G5/Inventario deben proporcionar reserva confirmada y snapshot durable autorizados. Inbox/Outbox, idempotencia, confirms y ACK tras commit requieren prueba bilateral. Restauración vinculada al consumo original mediante consumption_operation_id conforme al perfil D-04; no endurecer el esquema general unilateralmente.

Retry/DLX conserva su gate independiente de recuperación. Runtime consumidor/pump permanece deshabilitado y protegido aunque las pruebas aisladas pasen.

## #15 — aceptación interna y propuesta de locking

Preparación fusionada aceptada como implementación interna. **No hay autorización de carga ni de modificar permisos/migraciones compartidos.** Axel y López deben proponer y validar con BD una solución mínima al FOR UPDATE del seed, compatible con append-only y probada con rol restringido; sin UPDATE general ni rol owner como alternativa de carga.

La candidata local de [PROPUESTA-LOCKING-SEED.md](../../scripts/seed/mcp/promotions/PROPUESTA-LOCKING-SEED.md) necesita revisión de López/BD y aprobación específica de Marco. El fixture SQL solo se instala en un contenedor descartable; el generador, gate productivo y migraciones oficiales permanecen intactos.

Poma/Vera deben aprobar referencias publicadas, variantes, precios/canales/vigencias y contenido. Marco autorizará después manifiesto/versión/hash, SQL exacto, tablas/destino, proceso transaccional, rollback y postcheck. Las campañas conservan inicio 02/11, posterior a H4; no cambiar fechas ni activar sin revisión comercial.

## #76–#78/#111 — disponibilidad y release

Se distinguen liveness (proceso), readiness técnico (dependencias utilizadas), readiness funcional (identidades/fuentes/adaptadores del alcance) y E2E desplegado reproducible. No se crean rutas de salud fuera de contrato; /health, CI y pruebas locales no acreditan disponibilidad comercial.

Axel aporta implementación/evidencias. Marco/infra define gates y autoriza cada release con SHA exacto, imagen/digest, entorno/configuración, dependencias, smoke y recuperación/rollback. No se habilitan nueve servicios ni flujos comerciales bloqueados automáticamente.

## Registro y cierres

Cada issue debe registrar decisión, responsable, dependencia, condición de desbloqueo y evidencia. Permanecen abiertos #72/#73/#74/#33/#75/#15/#76/#77/#78 y los gates de Marco #29/#111 hasta acreditar sus criterios propios. #70/#71 ya cerrados por alcance interno no se reabren. Prioridad H4: decisiones internas e integraciones mínimas, sin ampliar el alcance.

## Evidencia ejecutada de esta entrega

| Comando / alcance                                                      | Resultado real                                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Cinco suites de composición v1, dinero y gates, comando exacto en JSON | PASS: 85 pruebas; [conformidad y hashes](test/evidence/composition-approval-2026-10-26.json).                                                |
| `node scripts/seed/mcp/promotions/test/seed-locking-proposal.mjs`      | PASS: siete grupos con PostgreSQL 17.11, login seed autenticado, guard de identidad heredada, locks concurrentes y retirada de la candidata. |
| Regresión node:test seed/DATA/restore                                  | PASS: 50 pruebas.                                                                                                                            |
| `npm test`                                                             | PASS: 973; 17 optativas Bulk omitidas.                                                                                                       |
| `npm run test:e2e`                                                     | PASS: 390; 91 optativas omitidas en 11 suites.                                                                                               |
| `npm run typecheck`, `npm run lint`, `npm run format:check`            | PASS.                                                                                                                                        |

Las omisiones generales requieren flags/entornos de otros servicios y no se
declaran ejecutadas. Las pruebas se asocian al contenido mediante SHA-256, con
base 546bced6586ac7cfc275d452d35c3493a28f03c9; no se ejecuta despliegue ni
integración compartida. La CI remota se verificará para el SHA publicado y se
registrará en el PR/los issues. El workflow existente no ejecuta el nuevo runner
node de propuesta: ese PASS es local, separado de los checks generales.

Código runtime, DTOs, contratos, migraciones históricas, SQL del generador,
grants compartidos, datos comerciales y flags productivos no se modifican.
Solo se incorporan decisiones, pruebas/evidencia y un fixture SQL descartable.
