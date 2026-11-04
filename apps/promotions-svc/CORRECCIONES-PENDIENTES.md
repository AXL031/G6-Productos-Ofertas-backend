# Correcciones locales de Promotions y DATA — 16/10/2026

## Revisión vigente después de sincronizar master

Ver [`REVISION-MASTER-2026-10-16.md`](REVISION-MASTER-2026-10-16.md) para los
resultados nuevos, la regresión de restauración y los pendientes de #33/#70/#15/#112.
La sincronización y la actualización de dependencias fueron autorizadas
expresamente en la revisión posterior a #116. Los resultados siguientes se
conservan como antecedentes; no sustituyen la validación del SHA final.

## Antecedentes de la entrega anterior

Rama: `cueva`. Base publicada: `86030ab67f263fefee41ee6bb18578877767fb08`.
Las pruebas siguientes se ejecutaron sobre cambios locales antes de su
publicación. El merge de #116 fue confirmado el 16/10/2026 a las 16:31:53
America/Lima, commit `c3a6b0aeb2e3230b17c5ef3ddf4a6d86483b263d`; integró
exclusivamente el Gateway aprobado. El usuario autorizó publicar después estos
avances en `cueva`, sin nuevo PR. No hay nueva rama, merge adicional, persistencia
compartida ni modificación de contratos, migraciones, grants o dependencias
adicionales a las dos dependencias preexistentes autorizadas de #33.

## #70 — IMPLEMENTAR_AHORA: probes reales y controles de arranque

`nativePromotionsDependencyProbes` comprueba PostgreSQL con autenticación,
TLS verify-full y `SELECT 1`, y RabbitMQ con autenticación y consulta pasiva de
`po.promotions.q`. Cierra sus clientes/canales y atiende cancelación; timeout
global de 1 segundo por probe, con límites del driver de 750 ms. No consume,
publica, crea topología ni escribe filas. Cola ausente, fallo TLS, credenciales
inválidas, error y timeout no dan `ready`.

`PROMOTIONS_DEPENDENCY_PROBES_ENABLED=false` por defecto. Desactivado devuelve
`disabled`/`not_ready`; activar la opción solo habilita comprobaciones bajo
demanda, sin iniciar trabajo de negocio. `/health` conserva liveness; no se
añaden rutas HTTP. Readiness de dependencias no prueba que el consumidor de
cupones esté operativo ni que #71 tenga todos sus permisos.

Validación real en contenedores descartables: siete comprobaciones con
PostgreSQL 17.11 TLS y RabbitMQ 4.1. Sin conexión a Supabase/broker compartidos.
El test verifica también cero consumidores y conservación de mensajes.

Reproducción: build de Promotions y
`node apps/promotions-svc/test/readiness.isolated.smoke.mjs`. Requiere Docker,
las dos imágenes locales y Python con `cryptography` para generar el certificado
sintético temporal. `G6_TEST_PYTHON` permite seleccionar ese intérprete; no es
configuración productiva ni agrega dependencias al monorepo. La clave temporal,
los contenedores y sus datos se eliminan al terminar.

## #33 — IMPLEMENTAR_PARCIAL: lifecycle y recuperación de Outbox

`CouponRuntime` conecta el consumidor y `CouponOutboxPump` al arranque/cierre de
Nest. Reutiliza el handler, Inbox, recibos, locks, transacciones, Outbox y publisher
confirm existentes. El pump publica una fila a la vez y recupera pendientes ante
fallos; el marcado sigue requiriendo confirm del broker. El cierre drena trabajo
antes de cerrar los recursos. Pérdida de canal detiene el consumidor y pump sin
ACK adicional. No se prescribe una reconexión/retry/DLX productiva no acordada.

`PROMOTIONS_COUPON_RUNTIME_ENABLED=false` por defecto. Con `true`, la frontera
actual rechaza el arranque **antes de abrir el consumidor o iniciar Outbox**.
Faltan evidencia, elegibilidad, dispatcher completo e identidad/ACL verificables.
No existe un modo de entorno que salte esa frontera. La delegación de eventos
ajenos al cupón conserva el fallo sin ACK cuando el handler no está disponible;
no se registra un handler vacío como implementación de #75.

El adaptador `COUPON_EVIDENCE_PROVIDER` sigue rechazando: no se sustituye por
evidencia sintética en producción. El comando solo aporta referencias opacas.
El GET de Inventario por `operationId`, autorizado a Ventas, no habilita a
Promotions a consultar por `reservation_id`. No se inventan endpoint, grant,
evento o acceso cross-schema para completar esa frontera.

El smoke descartable conserva los diez escenarios de concurrencia, duplicados,
restauración, rollback, ACK/redelivery y confirms; ahora verifica recuperación
mediante el pump continuo real. Usa prueba de evidencia aislada y no constituye
integración G5/Inventory ni homologación.

## #15 y #112 — preparación protegida; bloqueos específicos

La preparación existente ya genera los seis maestros con alcances y
recomendaciones únicamente cuando recibe referencias publicadas y precios
coherentes. Las 31 pruebas offline pasaron. La plantilla real sigue sin vincular;
no se completan campos con IDs o precios inventados. Borrador no ejecutable,
campañas/cupón inactivos, aprobaciones vacías y cero persistencia.

El restore conserva dry-run, `shared=verify_only`, cero lotes aprobados, cero
ejecuciones y ausencia de modo apply. Su validador pasó y verificó los tres
hashes históricos. No se duplican seeds ni datasets de otros owners.

## Dependencias y condiciones concretas

| Owner | Operación | Condición verificable |
| --- | --- | --- |
| Inventory/G5/Marco | Adaptador de evidencia #33 | Fuente contractual y autorización para resolver pedido/reserva y confirmar su resultado definitivo; fuente versionada y verificable del snapshot comercial y su vínculo con el comando. |
| Axel/Promotions | Elegibilidad de cupón | Repositorios/reglas autoritativos propios de #71/#72 implementados y probados; no delegar las invariantes al emisor. |
| G5/owner mensajería G6/Marco | Activación del consumidor | Identidad/ACL y contrato operativo acordados, topología disponible y dispatcher duradero para los seis routing keys de la cola. |
| Marco/revisión BACK | Inicio de #71 | #70 probado, aceptado y su PR fusionado; además coordinación/autorización del manifiesto y lock con Drizzle. |
| Marco/revisión BACK | Inicio de #72/#75 | #71/#74 respectivamente probados, aceptados y fusionados, según los gates expresos de esos issues. |
| Poma, DATA #12 | Alcances y recomendaciones #15 | Referencias activas y estables, publicación/versionado y revisión semántica deportiva. |
| Vera, DATA #13 | Coherencia económica #15 | Matriz publicada de SKU, precio exacto, moneda, canal y vigencia para las referencias seleccionadas. |
| Marco/Axel/López, revisión BD | INSERT de maestros con seed restringido | Resolver el requisito de UPDATE de locks en triggers invoker de forma compatible con la política append-only; no ampliar grants para lograr PASS. |
| Marco y owners | Persistencia DATA/restauración | Aprobación expresa del contenido/hash, schema/tablas y destino exactos; proceso y postcheck autorizados. |

Los gates de #71/#72/#75 son explícitos en los issues; no se inicia Drizzle,
reglas o proyecciones nuevas de esos bloques por inferencia. No bloquean estas
correcciones independientes de #70/#33. La propuesta experimental de paquetes
del informe anterior no autoriza modificar el package/lock compartido.

## Evidencia y límites

| Comando ejecutado | Resultado real |
| --- | --- |
| `npm test -- apps/promotions-svc --maxWorkers=1` | PASS: 67 unitarias. |
| `npm run test:e2e -- apps/promotions-svc --maxWorkers=1` | PASS: 6 HTTP. |
| `npm test -- --maxWorkers=1` | PASS: 133 unitarias generales. |
| `npm run test:e2e -- --maxWorkers=1` | PASS: 325 HTTP; cuatro escenarios Gateway PostgreSQL optativos NO EJECUTADOS. |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | PASS. |
| `npm run build:promotions-svc`, `npm run build:all` | PASS. |
| `node apps/promotions-svc/test/startup.smoke.mjs` | PASS: liveness y rechazo de activación sin adaptadores autorizados, sin exponer valores privados. |
| `node apps/promotions-svc/test/coupons.isolated.smoke.mjs` | PASS: diez escenarios PostgreSQL/RabbitMQ descartables, incluido pump continuo. |
| `node apps/promotions-svc/test/readiness.isolated.smoke.mjs` | PASS: siete comprobaciones reales en contenedores descartables. |
| `node --test scripts/seed/run.test.mjs scripts/seed/mcp/promotions/validate-draft.test.mjs scripts/seed/mcp/promotions/prepare-batch.test.mjs scripts/seed/validate-restore-plan.test.mjs` | PASS: 31 pruebas offline. |
| `node scripts/seed/mcp/promotions/validate-draft.mjs` | PASS: inactivo/no ejecutable; referencias aún pendientes. |
| `node scripts/seed/validate-restore-plan.mjs` | PASS: dry-run, tres hashes verificados, cero SQL y cero persistencia. |

Los resultados generales se obtuvieron antes de desacoplar la validación de los
drivers de probes respecto al helper de cupones; después de ese único ajuste se
repitieron las unitarias de Promotions, tipos, lint, formato, build de Promotions,
smoke de probes y smoke de arranque. Las dependencias y lock locales preexistentes
no se modificaron ni reinstalaron en esta revisión.

Ver `test/evidence/pending-corrections-2026-10-16.json` para comandos, resultados
y hashes del árbol local que se probó antes de actualizar estas notas de publicación, y
`test/evidence/coupon-runtime-corrections-2026-10-16.json` para el smoke de cupones.

La preparación inicial del smoke de probes encontró que la eliminación
condicional de una cola quorum no está soportada en RabbitMQ 4.1. Se corrigió
solo la limpieza del fixture propio después de comprobar mensajes/consumidores;
la ejecución final completa pasó. No se relajó autenticación ni el probe real.

Referencias técnicas: [pg Client](https://node-postgres.com/apis/client),
[amqplib](https://amqp-node.github.io/amqplib/channel_api.html),
[limitación de borrado quorum](https://github.com/rabbitmq/rabbitmq-server/issues/10543).

Implementación/pruebas locales se separan de integración autenticada compartida,
homologación externa y despliegue, que siguen **NO EJECUTADOS**. Los cuatro casos
PostgreSQL y smoke externo pendientes del Gateway no se ejecutan ni modifican en
esta tarea. No cerrar issues ni alterar #116.
