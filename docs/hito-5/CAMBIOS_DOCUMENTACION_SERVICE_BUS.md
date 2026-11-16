# Cambios documentales preparados para Service Bus H5

Fecha: 2026-11-15. Estado: propuesta local para trasladar al repositorio oficial de Docs. No se editaron archivos remotos ni se cambió el estado de una decisión.

Actualización posterior al corte inicial: Docs master verificado en `f77c442485203695a5e877fce188a4d249c129fb`; ADR y plan H5 siguen propuestos. Backend oficial `48594fe708cf4a3fbc050612682e4211267daf96` ya contiene SDK Azure y candidato Catalog por PR #232. Conservar las fuentes iniciales como historia y actualizar evidencia de implementación por SHA antes de ejecutar los cambios. El [Issue piloto preparado](ISSUE_PILOTO_SERVICE_BUS.md) usa esta base nueva; su publicación quedó pendiente por acceso.

## Alcance de la reorganización

Podemos convertir los borradores H5 existentes en una guía ejecutable: separar decisión interna, catálogo de transporte, implementación por servicio y contrato externo; corregir referencias de versiones; añadir etapas, dependencias y evidencias. Mover archivos físicamente es innecesario para arrancar y rompería enlaces/pruebas que usan rutas concretas. Mantener las rutas actuales y ajustar sus secciones.

Una edición documental no concede permisos de archivos compartidos, no convierte una propuesta en una decisión aceptada y no sustituye una homologación G5/G7. El estado de adopción cambia solo al incorporar su evidencia. Las propuestas técnicas de este paquete se revisan antes de promoverse a fuente normativa.

## Cambios por archivo oficial

Todas las rutas de esta tabla son del repositorio `Taller-SW-Web/G6-Productos-Ofertas-docs`.

| Archivo | Cambio preparado | Criterio de cierre |
|---|---|---|
| `README.md` | Enlazar el paquete de implementación y separar H4 compatible de H5 candidato | Un lector distingue qué es vigente, propuesto, implementado y desplegado |
| `arquitectura/decisiones/ADR-H5-SERVICE-BUS-BASIC.md` | Separar la decisión interna de transporte de la frontera externa; documentar organización de adaptadores, Basic, activación por flujo e identidad | Mantener propuesta hasta evidencia de adopción; ninguna aceptación G5/G7 atribuida |
| `arquitectura/Arquitectura.md` | Añadir transición por ruta/familia, ownership SQL y referencias al plan; conservar contexto histórico | No declarar que el reemplazo del broker ya ocurrió |
| `contratos/eventos/TOPOLOGIA-SERVICE-BUS-BASIC-H5.md` | Añadir catálogo por mensaje/ruta, permisos, versión, transporte y readiness del handler; distinguir relaciones candidatas de recursos habilitados | Cada cola propuesta tiene productor, consumidor y gate comprobables |
| `contratos/eventos/INVENTARIO-40-MENSAJES-H5.md` | Añadir evidencia de handler por SHA y estado de migración por ruta; actualizar hallazgos históricos solo tras verificar código | Los 40 mensajes quedan trazados; no se deduce implementación de un binding |
| `integraciones/PLAN-MIGRACION-MENSAJERIA-H5.md` | Sustituir la sección de fases por el texto propuesto abajo; enlazar entregables y backlog | D1 externo deja de interpretarse como prerrequisito global del piloto interno |
| `arquitectura/operacion-service-bus-basic-h5.md` | Añadir recuperación del relay SQL, claims, renovación/pérdida de lock, cierre ordenado, ACA, RBAC por cola y corte | Quedan procedimientos verificables para caída y recuperación sin tráfico HTTP |
| `arquitectura/COSTOS-LIMITES-AZURE-H5.md` | Incluir costo de workers vivos, fan-out, pruebas reales y alternativa Standard si cambian requisitos | Cotización regional fechada separada de estimación; sin costos inventados |
| `tests/contratos/PLAN-VERIFICACION-SERVICE-BUS-H5.md` | Añadir casos de claim vencido, carrera entre relays, pendientes SQL con cero réplicas, rutas coexistentes y rollback | Identificadores nuevos propuestos y únicos; los casos existentes no se marcan PASS |
| `tests/contratos/test_service_bus_h5_documentation.py` | Ajustar pruebas de consistencia a los cambios aprobados, manteniendo invariantes comerciales/TTL/identidad | Validación estática pasa sin retirar aserciones funcionales para ocultar una regresión |
| `integraciones/MATRIZ-EXTERNOS-ASYNCAPI-H5.md` | Corregir referencia actual OpenAPI a rc.5 y aislar gates G5/G7 del desarrollo interno | Sigue distinguiendo contratos actuales de endpoints propuestos |
| `contratos/http/PROPUESTA-OPERACIONES-CUPONES-H5.md` | Conservar como propuesta externa; cerrar retención, autorización, DTO, errores y secuencia antes del OpenAPI futuro | Solo pasa al contrato ejecutable con evidencia requerida; no crear endpoints desde este plan |
| Modelos `datos/<servicio>/` y guías de migración aplicables | Documentar las tablas aditivas de entrega y la conversión de pendientes del servicio, cuando se prepare su Issue | Modelo/DDL/código alineados y migraciones históricas intactas |

## Texto propuesto: fases del plan de migración

Este texto reemplazaría la sección de fases, conservando las secciones de negocio y trazabilidad existentes:

> La implementación interna de Service Bus y el cambio de frontera con G5 son líneas independientes. El acuerdo externo no es un prerrequisito del adaptador interno ni del piloto Pricing→Price Audit. El retiro de las rutas AMQP externas sí depende de su homologación y permisos efectivos.

| Fase propuesta | Resultado | Gate específico |
|---|---|---|
| D0 | Base por SHA, decisión interna delimitada e Issues con alcance | Evidencia de decisión y archivos autorizados antes de activar/escribir código transversal |
| I1 | SDK, IaC, RBAC y entrega por destino para piloto | Build, configuración y persistencia aislada; aplicación Azure separada |
| I2 | Piloto aislado Pricing→Price Audit | Emisor/consumidor reales, Inbox/Outbox, identidad, duplicados y recuperación |
| I3 | Inicializaciones y resultados Catalog/Pricing/Inventory | Cada operación cierra con correlación y resultado durable |
| I4 | Distribución Catalog/Inventory/Pricing a destinatarios internos | Fallos independientes por destinatario y gates de handlers conservados |
| I5 | Bulk y Taxonomy | Payload compatible con 256 KB y negocio completo por ruta |
| D1/PX | Contratos y adaptación HTTP G5 | Línea independiente: aceptación bilateral y autorización G7 antes de exposición/corte |
| I6 | Corte gradual por grupo aprobado de rutas | Consumidores, pendientes y rollback conciliados; nunca flag global ciego |
| I7 | Retiro final RabbitMQ | Inventario cero dependencias, incluidas G5, y autorización de retiro |

Esta sustitución es una propuesta de organización, no una adopción registrada de H5.

## Candidata de transporte H5 y contratos canónicos

Preparar, tras revisar la decisión interna, una candidata AsyncAPI de transporte H5 separada. Su ruta y versión se fijan explícitamente en el Issue de Docs; no asignar en este paquete una versión que parezca publicada. Debe tener:

- Envelope y schemas internos aprobados, sin alterar nombres ni campos de negocio por conveniencia del SDK.
- Destino físico por productor/consumidor, canal/operación y seguridad que represente Service Bus; sin copiar exchanges RabbitMQ como si fueran entidades Azure.
- Clasificación por cada mensaje/ruta: interno implementable, pendiente de handler, externo que conserva compatibilidad H4 o externo propuesto HTTP.
- Reglas de `message_id`, correlación, idempotencia, tamaño y entrega por destinatario; referencia a la política H5 de fallos.
- Validación con herramientas que soporten la candidata y bindings elegidos. Si falta un binding aplicable, documentar el límite y validar el manifiesto; no fingir soporte del generador actual.

El AsyncAPI canónico H4 se conserva mientras existan consumidores que dependan de él. Los nuevos endpoints de cupones y reserva no se añaden silenciosamente al OpenAPI rc.5. Preparar su candidata independiente y promoverla cuando se cierre el alcance externo. La coexistencia se documenta por ruta para que el cambio interno no parezca retiro de G5.

## Comprobaciones para el paquete Docs

1. Leer `AGENTS.md`, `README.md`, SPEC/HU/FLOW y fuentes de modelo/pruebas aplicables antes de editar artefactos normativos. El backend tiene instrucciones de ownership adicionales.
2. Validar todos los enlaces relativos modificados; mantener rutas usadas por pruebas existentes o cambiar ambos lados dentro del mismo alcance autorizado.
3. Ejecutar desde Docs `python -m unittest discover -s tests/contratos -p 'test_service_bus_h5_documentation.py'` con sus dependencias instaladas. Añadir la validación del inventario/contratos aplicable según las herramientas del checkout real.
4. Comparar H4 y sus fixtures antes/después: sin eliminaciones, endurecimientos de schemas ni cambio de destinatarios externos en el paquete de reorganización.
5. Ejecutar `git diff --check` y revisar el diff completo. Las pruebas estáticas no acreditan identidad, entrega, homologación ni despliegue.

No se ejecutaron estas validaciones en Docs: el repositorio no está disponible como checkout local. Se revisó su archivo de pruebas remoto para preparar el comando; no se afirma resultado.

## Fuentes inmutables de la propuesta

Base Docs `0a4c333f9339c187bf68dceda20de6556124b001`:

- [Instrucciones Docs](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/0a4c333f9339c187bf68dceda20de6556124b001/AGENTS.md).
- [ADR H5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/0a4c333f9339c187bf68dceda20de6556124b001/arquitectura/decisiones/ADR-H5-SERVICE-BUS-BASIC.md).
- [Plan H5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/0a4c333f9339c187bf68dceda20de6556124b001/integraciones/PLAN-MIGRACION-MENSAJERIA-H5.md).
- [Topología H5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/0a4c333f9339c187bf68dceda20de6556124b001/contratos/eventos/TOPOLOGIA-SERVICE-BUS-BASIC-H5.md).
- [Plan de pruebas](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/0a4c333f9339c187bf68dceda20de6556124b001/tests/contratos/PLAN-VERIFICACION-SERVICE-BUS-H5.md).
- [Pruebas documentales](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/0a4c333f9339c187bf68dceda20de6556124b001/tests/contratos/test_service_bus_h5_documentation.py).

Plan local: [PLAN_IMPLEMENTACION_SERVICE_BUS.md](PLAN_IMPLEMENTACION_SERVICE_BUS.md). Backlog local: [BACKLOG_SERVICE_BUS.md](BACKLOG_SERVICE_BUS.md).
