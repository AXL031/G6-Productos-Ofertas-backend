# [H5][TRANSVERSAL] Preparar Azure Service Bus Basic y habilitar piloto Pricing → Price Audit

**Estado vigente:** publicado como [Backend #234](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/234). El bloqueo CLI fue resuelto y las excepciones de migración/autoaprobación quedaron registradas. El usuario delimitó el cierre al piloto aislado para no omitir consumidores. Ver [cierre](CIERRE_PILOTO_234.md); el texto siguiente conserva el borrador y sus gates iniciales como antecedente.

Estado de publicación: pendiente. No se creó un Issue ni se asignó número. El conector devolvió 403 y el token CLI no fue válido; la alternativa de navegador fue rechazada por revisión automática. El texto siguiente es el cuerpo preparado para el repositorio oficial.

Actualización 2026-11-16: el usuario autorizó expresamente ejecutar localmente el piloto Pricing/Price Audit y SB-01 en `cueva`, usando este Issue hasta recuperar publicación. El [informe de ejecución](EJECUCION_PILOTO_SERVICE_BUS.md) registra implementación y validaciones; los checkboxes siguientes conservan el alcance y no se convierten automáticamente en evidencia Azure, aprobación de Marco ni despliegue.

Continuación autorizada el mismo día: «continua con el azure real y despliegue». Se desplegó infraestructura aislada y pasó el flujo real SDK/broker/SQL, redelivery/idempotencia, denegación de permisos cruzados y DLQ. Ver [informe Azure](EJECUCION_AZURE_SERVICE_BUS.md). El cómputo temporal fue retirado; no se activó producción ni se aplicaron migraciones compartidas. Los checkboxes históricos no sustituyen la evidencia por fase.

## Objetivo

Completar la base de Azure Service Bus Basic y demostrar el flujo interno **Pricing → pricing.price.changed → Service Bus → Price Audit**, con persistencia real, entrega recuperable e idempotencia.

Issue transversal de coordinación e implementación por paquetes pequeños. Su apertura registra el trabajo solicitado por Axel; **no atribuye aprobación de Marco, homologación G5/G7, permisos Azure ni autorización de despliegue**. La adopción interna y las autorizaciones pendientes se registran con evidencia antes de activar el transporte.

## Base verificada — 2026-11-15

- Backend oficial: `48594fe708cf4a3fbc050612682e4211267daf96`, merge de [PR #232](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/232).
- Ese SHA ya incluye `@azure/service-bus@7.10.0` y `@azure/identity@4.14.1`; **no volver a instalar ni actualizar esos SDK sin necesidad comprobada**.
- Existe candidato Catalog: `catalog-service-bus.ts`, `catalog-service-bus-relay.ts` y migración aditiva candidata de entregas. Su README indica que falta integrar el escritor exclusivo y el arranque del worker; no acredita corte ni Azure real. Usar su diseño y lecciones como referencia, sin importar código de otra aplicación.
- Checkout local de preparación: `cueva`, SHA `8bf6b6ecf3e60730c945fe707769f95ffa450a8e`, fork AXL031. El estado local anterior no se presenta como el estado actual de master.
- Docs oficial: `f77c442485203695a5e877fce188a4d249c129fb`. ADR y plan H5 continúan como propuestas.
- Búsqueda de Issues equivalentes por “Service Bus” en el repositorio oficial: sin resultados al registrar este trabajo. Los Issues H4 #29 y #75 conservan su alcance histórico y no se cierran con este piloto.

## Paquetes de trabajo

### A. Alcance y contrato interno

- [ ] Registrar adopción interna o resolución de la propuesta Basic, sin convertirla en homologación externa.
- [ ] Fijar versión/SHA del contrato de negocio y candidata de transporte H5; preservar nombres, envelope e invariantes de `pricing.price.changed`.
- [ ] Aprobar catálogo de rutas y cola piloto `g6.price-audit.from.pricing`: productor, consumidor, permisos y estados.
- [ ] Registrar expresamente las autorizaciones de archivos compartidos solicitadas abajo.
- [ ] Mantener aisladas las nuevas operaciones HTTP G5. Su homologación no es prerrequisito del desarrollo/piloto interno.

### B. Infraestructura y configuración

- [ ] Preparar IaC Bicep para namespace Basic, cola piloto, parámetros por entorno y permisos por entidad.
- [ ] Identidades runtime separadas para emisor/receptor; Sender/Receiver mínimos, sin Data Owner ni creación de colas desde runtime.
- [ ] Validar configuración candidata `MESSAGING_PROVIDER` / `SERVICE_BUS_NAMESPACE_FQDN`, lifecycle SDK, cierre y fallos sin fallback automático.
- [ ] Preparar runtime ACA que consuma y recupere el Outbox SQL sin depender de una petición HTTP. Una regla por longitud de cola no recupera por sí sola trabajo que aún está solo en SQL.
- [ ] Validar IaC y costo/región/SKU. El aprovisionamiento, RBAC real y despliegue se autorizan y evidencian por separado.

### C. Productor Pricing

- [ ] Persistir negocio + mensaje + entregas obligatorias en la misma transacción local.
- [ ] Incorporar entrega por destinatario, unicidad de mensaje/destino, claim durable con vencimiento y recuperación; migración aditiva, sin tocar históricos.
- [ ] Enviar fuera de una transacción SQL larga y marcar confirmado solo tras resultado positivo del SDK.
- [ ] Ante envío ambiguo, reintentar con el mismo `message_id`; no convertir `published_at` histórico RabbitMQ en evidencia de Azure.
- [ ] Definir selección de rutas/versión y política de pendientes del piloto. No desviar inicializaciones y resultados Catalog al cambiar el proveedor de Pricing.
- [ ] Configurar explícitamente la publicación de `pricing.price.changed` en el entorno aislado del piloto.

### D. Consumidor Price Audit

- [ ] Recibir con Peek-Lock y finalización manual.
- [ ] Reutilizar el decoder productivo registrado y la persistencia del dominio; validar contrato, IDs y procedencia mediante ruta/RBAC, sin autenticar por `producer` del payload.
- [ ] Commit de Inbox + auditoría antes de `completeMessage`.
- [ ] Redelivery tras commit/settlement fallido recupera resultado sin duplicar auditoría.
- [ ] Clasificar fallos temporales, pérdida de lock e inválidos permanentes; política H5 de reintento/DLQ explícita por flujo, sin alterar por inferencia la política RabbitMQ H4.

## Archivos y ownership

**Alcance solicitado, pendiente de registrar aprobación donde AGENTS.md la exige:**

| Paquete | Archivos/rutas | Ejecución |
|---|---|---|
| Planificación | `docs/hito-5/`; ADR/topología/plan/pruebas H5 de Docs en su propio repositorio | Axel prepara; coordinación registra decisión |
| SDK | `package.json`, `package-lock.json` solo si un cambio adicional resulta necesario y aprobado; los SDK ya existen en master | Owner transversal autorizado |
| Infra nueva | `ops/azure/service-bus/` para Bicep, manifiesto y ejemplos sin secretos | Infra autorizada |
| ACA | `ops/azure/container-apps/render-deployment.mjs`, `phase3-preflight.mjs`, `deploy-release.mjs` y sus pruebas existentes solo para configuración/identidad/worker del piloto; enumerar el diff exacto antes de implementar | Owner transversal autorizado |
| Pricing | `apps/pricing-svc/src/messaging/`, `src/config/environment.ts`, `src/persistence/`, módulo/composición y pruebas propias necesarias | Vera, rama `vera` |
| Audit | `apps/price-audit-svc/src/messaging/`, `src/config/environment.ts`, `src/price-audit-svc.module.ts`, health y pruebas propias necesarias | Vera, rama `vera` |
| Persistencia oficial | Modelos y migraciones aditivas de Pricing/Audit, con rutas concretas registradas en el Issue de Docs antes de editar | Owner del servicio + proceso de datos |

Los responsables son propuestas conforme a ownership, no asignaciones aceptadas. `cueva` no autoriza modificar aplicaciones de Vera. No imports entre `apps/*`, entidades compartidas ni nueva aplicación central de negocio. `libs/`, Gateway y `.github/` quedan fuera de este paquete salvo nueva autorización expresa. No crear ramas automáticas, sincronizar masivamente ni hacer rebase/force-push.

## Aceptación y evidencia mínima

- [ ] Cambio real de Pricing → Outbox SQL → SDK → cola → consumidor real → auditoría e Inbox persistidas.
- [ ] Broker caído deja intención durable recuperable.
- [ ] Timeout ambiguo conserva identidad; duplicado y caída post-commit no repiten el efecto.
- [ ] Dos relays, claim vencido, pérdida de lock, shutdown y recuperación probados.
- [ ] Emisor/receptor ajenos son rechazados en Azure real; cliente SDK y payload no sustituyen RBAC.
- [ ] Tamaño completo de mensaje/lote respeta Basic; excederlo no marca la entrega como publicada.
- [ ] Pruebas de persistencia con PostgreSQL real aislado; emulador identificado como tal. No usar dobles como evidencia de Azure.
- [ ] Pruebas enfocadas, unitarias/E2E aplicables, typecheck, lint, build y `git diff --check` con comando y resultado real por SHA.
- [ ] Recuperación de pendientes SQL sin tráfico HTTP y efectos ante revisiones/réplicas concurrentes verificados.
- [ ] Procedimiento de corte/rollback por grupo de rutas: inventario de consumidores RabbitMQ, pendientes/en vuelo e Inbox; sin dual-write ni reemisión ciega.
- [ ] Registrar por separado documentación, adopción G6, implementación, CI, Azure autenticado, homologación y despliegue. No declarar READY_FOR_DEPLOY por CI/health.

Casos de referencia: H5-MSG-01–09, 19 y 20 aplicables; añadir casos de claim/ACA/rollback al plan sin marcarlos ejecutados por documentarlos.

## Dependencias específicas

| Responsable requerido | Operación | Desbloqueo verificable |
|---|---|---|
| Coordinación G6/Marco | Adopción interna y archivos transversales | Decisión y alcance expresos registrados en este Issue/documento enlazado |
| Infra Azure | Pruebas autenticadas y ejecución continua | Entorno de prueba aprobado, identidades, RBAC por cola, configuración y presupuesto verificados |
| Vera | Productor/consumidor piloto | Paquetes en su rama, SHA y pruebas reales por componente/flujo |
| G5/G7 | Futura frontera HTTP y retiro de sus flujos AMQP | Contrato homologado y permisos efectivos; **no bloquea el piloto interno** |

## Fuera de alcance

Retirar RabbitMQ, activar cupones, crear endpoints/scopes G5, cambiar reglas comerciales, tocar servicios ajenos, aplicar migraciones en base compartida, conceder permisos o desplegar recursos sin su autorización específica.

## Fuentes normativas

- [ADR H5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/f77c442485203695a5e877fce188a4d249c129fb/arquitectura/decisiones/ADR-H5-SERVICE-BUS-BASIC.md).
- [Plan de migración H5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/f77c442485203695a5e877fce188a4d249c129fb/integraciones/PLAN-MIGRACION-MENSAJERIA-H5.md).
- [Topología H5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/f77c442485203695a5e877fce188a4d249c129fb/contratos/eventos/TOPOLOGIA-SERVICE-BUS-BASIC-H5.md).
- [AsyncAPI](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/f77c442485203695a5e877fce188a4d249c129fb/contratos/eventos/asyncapi.yaml).
- [Plan de pruebas](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/f77c442485203695a5e877fce188a4d249c129fb/tests/contratos/PLAN-VERIFICACION-SERVICE-BUS-H5.md).
- [Candidato Catalog y sus límites](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/48594fe708cf4a3fbc050612682e4211267daf96/apps/catalog-svc/migrations-candidate/h5/README.md).
- [SDK ya incorporados](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/48594fe708cf4a3fbc050612682e4211267daf96/package.json).

Estado inicial: **IMPLEMENTAR_PARCIAL**; seguimiento abierto, sin pruebas Azure/deploy ni adopción atribuida por esta apertura.
