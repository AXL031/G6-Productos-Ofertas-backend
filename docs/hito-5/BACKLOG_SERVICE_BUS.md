# Backlog listo para registrar — Service Bus H5

Fecha: 2026-11-15. Estado: borradores locales; no se crearon Issues, asignaciones ni comunicaciones externas. Los códigos SB-* solo identifican este plan. Responsables propuestos según ownership vigente, no compromisos aceptados por esas personas.

Cada Issue que se registre debe incluir: rama personal, archivos permitidos, SHA Backend/Docs, contratos aplicables, alcance excluido, pruebas, dependencias específicas y criterio de cierre. No agrupar todos los servicios en un PR. Los subpaquetes de un mismo Issue se entregan en PRs atómicos por owner.

Avance 2026-11-16: Axel autorizó la excepción acotada para implementar el piloto Pricing/Audit y SB-01 en `cueva` usando el Issue local. Después solicitó Azure real y despliegue: infraestructura aislada y pruebas autenticadas PASS, con redelivery, permisos cruzados y DLQ. CI/publicación y activación en apps actuales siguen pendientes. Evidencia [local](EJECUCION_PILOTO_SERVICE_BUS.md) y [Azure](EJECUCION_AZURE_SERVICE_BUS.md). No cambia las asignaciones permanentes ni cierra SB-04–08.

## Registro del primer Issue transversal — 2026-11-15

Se preparó [ISSUE_PILOTO_SERVICE_BUS.md](ISSUE_PILOTO_SERVICE_BUS.md), que reúne el arranque SB-00/01 y los criterios del piloto SB-02/03, manteniendo los paquetes y ownership separados. Destino: `Taller-SW-Web/G6-Productos-Ofertas-backend`. No hay Issue creado ni número asignado.

La revisión actualizó la base a Backend `48594fe708cf4a3fbc050612682e4211267daf96` y Docs `f77c442485203695a5e877fce188a4d249c129fb`. PR #232 ya añadió los SDK y un candidato Service Bus de Catalog: SB-01 verifica e integra ese antecedente en lugar de duplicar dependencias.

Intentos de publicación: conector GitHub → `403 Resource not accessible by integration`; CLI local → token inválido. La revisión automática rechazó acceder a la ventana Brave titulada WhatsApp por riesgo de exponer comunicaciones ajenas y rechazó abrir un formulario dedicado como alternativa de publicación sin autorización explícita de esa vía. Se detuvo la automatización del navegador. Desbloqueo: conexión GitHub con permiso de escritura válido o autorización explícita para la publicación mediante un navegador dedicado a GitHub; no se requiere acceso a WhatsApp.

## SB-00 — Delimitar y registrar el alcance interno H5

- **Responsabilidad propuesta:** coordinación G6/Marco; Axel prepara el paquete documental.
- **Estado:** `IMPLEMENTAR_AHORA` para preparación documental; activación pendiente de decisión registrada.
- **Dependencias:** ninguna para completar el plan. La adopción formal no se infiere de este archivo.
- **Rutas:** Docs ADR/plan/topología/pruebas indicados en [cambios documentales](CAMBIOS_DOCUMENTACION_SERVICE_BUS.md); documentación de planificación backend.
- **Aceptación:** separar adopción G6 de homologación G5/G7; fijar Basic y límites o registrar alternativa; base por SHA; autorizar expresamente archivos compartidos de los Issues siguientes; catálogo por ruta con handlers verificados; H4 y fixtures preservados.
- **Pruebas:** consistencia documental, enlaces y `git diff --check`; sin declarar pruebas runtime.

## SB-01 — Preparar SDK e infraestructura de Service Bus

- **Responsabilidad propuesta:** infra autorizada y coordinación; participación de Vera para el contrato técnico del piloto.
- **Estado:** `IMPLEMENTAR_PARCIAL`.
- **Dependencias:** SB-00 para alcance/adopción; Azure real solo tras habilitar entorno, identidades y presupuesto.
- **Rutas a autorizar expresamente:** `package.json`, `package-lock.json`, `ops/azure/service-bus/`, archivos ACA de render/preflight/pruebas que se enumeren en el Issue y, si hace falta, workflow específico. `libs/` queda fuera del primer paquete.
- **Entrega:** verificar los SDK ya fijados en master por PR #232; Bicep parametrizado para namespace Basic y cola piloto; RBAC por cola; configuración por entorno sin secretos; adaptadores técnicos y política de cierre documentados; manifiesto de rutas versionado. No duplicar la incorporación de dependencias.
- **Aceptación:** build; validación IaC sin propiedades incompatibles con Basic; runtime sin permisos de administración; identidad emisora/receptora segregada; modo antiguo conserva compatibilidad; configuración inválida falla sin fallback al otro broker.
- **Pruebas:** render/parseo/what-if; pruebas negativas de acceso en Azure real separadas de CI rápida. La aplicación de IaC y los grants se registran como acciones posteriores específicas.

## SB-02 — Persistencia y transporte del productor piloto Pricing

- **Responsabilidad propuesta:** Vera, rama `vera`.
- **Estado:** `IMPLEMENTAR_PARCIAL` hasta alcance normativo/técnico cerrado.
- **Dependencias:** SB-00/01; no depende de nuevos contratos G5.
- **Rutas:** `apps/pricing-svc/src/messaging/`, `src/config/environment.ts`, `src/persistence/`, pruebas de Pricing; modelo/migración aditiva oficial de Pricing identificado en el Issue de Docs.
- **Entrega:** Outbox por destino, claim durable con recuperación, transporte SDK y selección de rutas para el piloto. Mantener los campos de negocio del envelope.
- **Aceptación:** cambio y entregas se comprometen juntos; no se marca confirmada una entrega ante timeout ambiguo; mismo ID al reintentar; sin SQL largo abierto durante la espera de red; no se modifica la entrega de inicializaciones Catalog por activar el piloto; política de pendientes históricos explícita.
- **Pruebas:** PostgreSQL real aislado, dos relays concurrentes, lease vencido, caída post-send/pre-update, pérdida de confirmación y broker caído. Build/typecheck/lint y suites aplicables.
- **Exclusiones:** aplicar migraciones a base compartida, activar flag productivo, alterar reglas de precios y modificar otros servicios.

## SB-03 — Consumidor Price Audit y E2E del piloto

- **Responsabilidad propuesta:** Vera, rama `vera`; infra para identidad/entorno real.
- **Estado:** `IMPLEMENTAR_PARCIAL`.
- **Dependencias:** SB-01/02; entorno real solo para su evidencia Azure.
- **Rutas:** `apps/price-audit-svc/src/messaging/`, `src/config/environment.ts`, `src/price-audit-svc.module.ts`, health y pruebas exactas enumeradas; preserve decoder/persistencia de negocio existentes salvo cambio necesario autorizado.
- **Entrega:** Peek-Lock con finalización manual, validación de envelope, commit de auditoría/Inbox, manejo de redelivery/lock/DLQ y cierre ordenado.
- **Aceptación:** Pricing real produce una auditoría durable con correlación; dos entregas no duplican el efecto; caída antes de commit reintenta; caída después de commit/antes de complete recupera el resultado; emisor ajeno denegado; no se presenta el piloto como corte productivo de todas las rutas Pricing.
- **Pruebas:** H5-MSG-01–04/06–09/19/20 aplicables, con cada modo emulador/Azure/SQL identificado y sin resultados fingidos.

## SB-04 — Migrar inicialización y resultados entre propietarios

- **Responsabilidad propuesta:** Poma (`catalog`), Vera (`pricing`), Taco (`inventory`), cada uno en su rama.
- **Estado:** `IMPLEMENTAR_PARCIAL` por ruta.
- **Dependencias:** SB-03; contratos de inicialización vigentes y catálogo de rutas revisado.
- **Rutas:** `apps/catalog-svc/src/catalog-amqp.ts` y persistencia/pruebas autorizadas; `apps/pricing-svc/src/messaging/`; `apps/inventory-svc/src/inbox/`, `src/outbox/`, repositorios propios. Ningún owner modifica una app ajena para cerrar su parte.
- **Entrega:** comandos/resultados de inicialización y bajas que correspondan al grupo aprobado, con Outbox/Inbox y transporte por ruta; migraciones aditivas por schema cuando hagan falta.
- **Aceptación:** petición y resultado conservan identidades/correlación; timeouts no se convierten en éxito; replay y resultado tardío coherentes; cada grupo puede conciliarse y revertirse sin pérdida.
- **Pruebas:** E2E con servicios/SQL/broker reales, fallo de uno de los servicios y duplicados antes/después de commit. Conservar regresiones de preparación/activación.

## SB-05 — Fan-out y consumidores de Combos/Promotions

- **Responsabilidad propuesta:** owners productores; Castilla (`combos`); Axel (`promotions`, rama `cueva`).
- **Estado:** `IMPLEMENTAR_PARCIAL`; runtime de cupones conserva su bloqueo específico.
- **Dependencias:** SB-03, entregas por destino en productores y handlers/contratos verificados. SB-04 solo donde la operación concreta dependa de inicialización/baja.
- **Rutas de Axel:** `apps/promotions-svc/src/coupons/`, `src/infrastructure/config/`, persistencia/health y pruebas propias enumeradas. Rutas productoras y Combos en Issues de sus owners.
- **Entrega:** consumidores SDK de eventos asignados y proyecciones propias; catálogos/rutas verificables; una copia independiente por destinatario.
- **Aceptación:** caída de Promotions no pierde la copia de Combos ni provoca que el productor marque todo publicado; Inbox evita replay de proyecciones; datos/versiones tardías respetan invariantes; no se cambia consumo/restauración ni se retira el gate de identidad/evidencia por introducir Azure.
- **Pruebas:** H5-MSG-05/07/09; redelivery/reorden por cada proyección y contratos generados consistentes con la fuente oficial.

## SB-06 — Bulk y Taxonomy con límites de Basic

- **Responsabilidad propuesta:** Castilla (`bulk`), Lopez (`taxonomy`) y owners de los destinos.
- **Estado:** `IMPLEMENTAR_PARCIAL`; cada operación sin negocio definido conserva `BLOQUEADO_ESPECÍFICO`.
- **Dependencias:** SB-03; catálogo y handlers aceptados por ruta, contratos masivos completos.
- **Rutas:** `apps/bulk-svc/src/messaging/` y persistencia/config/pruebas; `apps/taxonomy-svc/src/domain/taxonomy-amqp.runtime.ts` y persistencia/config/pruebas; adaptaciones de destinos en sus Issues.
- **Entrega:** fragmentación semántica o claim-check con integridad, permisos y retención; correlación/resultados por fila; barreras de maestros y sus resultados persistentes.
- **Aceptación:** mensaje/lote supera 256 KB contando propiedades → no se marca publicado; unidad indivisible grande usa la alternativa aprobada; reintento no duplica fila; ningún handler `BLOCKED_CONTRACT` se anuncia operativo; bajas/versiones conservan barreras reales.
- **Pruebas:** límite con SDK real, archivo referenciado ausente/alterado/expirado, fallos parciales, duplicación y recuperación; no truncamiento silencioso.

## SB-07 — Contratos y adaptación de frontera G5 por HTTP

- **Responsabilidad propuesta:** Docs/coordinación G6, G5, G7; Axel para Promotions, Taco para Inventory; Gateway con owner/Issue explícitos.
- **Estado:** `BLOQUEADO_ESPECÍFICO` para exposición/corte; preparación contractual y dominio interno definido pueden avanzar.
- **Dependencias:** aceptación bilateral, OpenAPI candidato aprobado por operación y seguridad G7; SB-01/02/03 como base técnica de worker cuando aplique. No es prerrequisito del piloto interno.
- **Rutas:** primero propuesta HTTP/matriz externa/contratos de Docs; después rutas exactas de Promotions/Inventory/Gateway autorizadas en Issues separados. G5 modifica únicamente su repositorio.
- **Entrega:** admisión de consumo/restauración con operación+Outbox atómicas, cola interna `g6.promotions.commands`, worker idempotente y consulta de resultado; estado de reserva y reconciliación durable del owner G5.
- **Aceptación:** 202 solo tras commit; POST repetido usa la misma identidad; GET no reejecuta y protege pertenencia; UUID no actúa como autorización; reserva efectiva precede al cupón, pago precede a confirmación definitiva del stock; expiración posterior a creación es conciliada en G5; no compartir credenciales del broker.
- **Pruebas:** H5-MSG-10–18 y 21–33 aplicables; emisión/autorización G7 reales y E2E bilateral distinguidos de pruebas locales.

## SB-08 — Operación ACA, cortes por ruta y retiro RabbitMQ

- **Responsabilidad propuesta:** infra/coordinación y owners del grupo a cortar.
- **Estado:** `IMPLEMENTAR_PARCIAL`; retiro final bloqueado solo por las dependencias aún existentes.
- **Dependencias:** SB-03 para piloto operativo; SB-04/05/06 por grupo; SB-07 para retirar frontera externa.
- **Rutas:** IaC/ACA/preflight/observabilidad/runbooks exactos autorizados; cambios de workers en sus ramas personales. No modificar infraestructura Oracle histórica para aparentar migración.
- **Entrega:** workers capaces de recuperar SQL sin peticiones HTTP, métricas de edad/reintentos/DLQ, procedimiento de corte/reconciliación/rollback y reporte por ruta/SHA.
- **Aceptación:** broker caído mantiene intención durable; reinicio recupera claims; escala/revisión no duplica efectos; migración no desvía rutas no preparadas; rollback concilia mensajes ya enviados; retiro RabbitMQ solo tras inventario cero dependencias y aprobación específica.
- **Pruebas:** interrupción del proceso, Outbox pendiente sin tráfico HTTP, dos réplicas, coexistencia de revisiones, rollback y replay autorizado de DLQ; costo y límites con evidencia fechada.

## Orden para abrir y cerrar trabajo

1. Registrar SB-00 y el alcance de SB-01; no esperar a G5 para delimitar el trabajo interno.
2. SB-02 y SB-03 forman el primer flujo demostrable; entregar su evidencia antes de ampliar a otros dominios.
3. SB-04/05/06 avanzan por disponibilidad de handlers y owners; SB-07 conserva sus gates externos.
4. SB-08 se prepara desde el piloto y se ejecuta para cada grupo; el retiro final espera el cierre de todas las dependencias.

En cada Issue mantener estados separados de documentación, adopción interna, implementación, pruebas locales, Azure autenticado, homologación y despliegue. Este backlog no modifica las asignaciones reales ni crea permisos de edición.

Plan principal: [PLAN_IMPLEMENTACION_SERVICE_BUS.md](PLAN_IMPLEMENTACION_SERVICE_BUS.md).
