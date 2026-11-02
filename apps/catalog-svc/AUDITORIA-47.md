# #47 — Auditoría de las doce escrituras HTTP

Rama `poma`; base funcional `6278b6867b5a87f5351f88b717798e0a0893ad5a`.
Normativa: Docs master `599c34f4e677c8792532e2cc31ac372473a10710`, OpenAPI
0.6.0-rc.1, SPEC-003/004/010, DEC-F-001/002/006/009/011/012 y modelo físico
Catalog. Se contrastaron las auditorías históricas con el código actual.

No se encontró un defecto adicional demostrable de las doce mutaciones que
requiera cambiar su implementación dentro de este encargo. No se reimplementan
ni se alteran rutas, DTO, autenticación, permisos o contratos.

| Operaciones OpenAPI | Implementación actual | Evidencia reproducible |
|---|---|---|
| crearProducto, crearVariante | BORRADOR, SKU explícito/único, colecciones/perfil/preparación/Outbox en una transacción | parser y dominio; PostgreSQL: creates simple and variant products atomically; unicidad concurrente |
| actualizarProducto, actualizarVariante | lock padre/hijos, catalogVersion, identidad inmutable, revalidación del agregado activo y rollback; Q-06 condicionado | tests input/type-correction; PostgreSQL: Q-06, invalid active edits including versions |
| activarProducto, activarVariante | datos/maestros/atributos/imágenes, perfil completo KG/CM, dependencias COMPLETED; sin Pricing por variante | dominio; PostgreSQL: partial draft, completed preparation, siblings |
| desactivarProducto, desactivarVariante | baja lógica, Outbox atómico, último hijo inactiva padre ACTIVO; preserva identidades/otros estados | PostgreSQL: serializes last-variant deactivation |
| reactivarProducto, reactivarVariante | revalida activación sin reactivar automáticamente padre/hijos | mismo caso PostgreSQL de independencia de reactivación |
| reintentarPreparacionProducto, reintentarPreparacionVariante | operación original, nuevo message_id causal, intento publicado/timeout explícito; exclusión concurrente; REJECTED bloqueado y COMPLETED terminal | parser/messages/dominio; PostgreSQL: admits only one manual retry, stale/terminal/Inbox |

Controladores invocan casos de uso reales; el guard existente exige usuario
GESTOR_COMERCIAL. `catalog-http.e2e-spec.ts` cubre las doce rutas, códigos de
éxito y denegaciones antes del caso de uso. Sus casos de uso son fixtures
explícitas: esa suite HTTP no acredita atomicidad PostgreSQL ni grants reales.
La atomicidad se comprueba aparte con la suite PostgreSQL desechable.

Validación local ejecutada en el bloque #49, antes de esta auditoría:
`npm test -- --maxWorkers=2 apps/catalog-svc`: 390 PASS;
`npm run test:e2e -- --maxWorkers=2 apps/catalog-svc`: 111 PASS / 45 SKIP.
Las suites omitidas incluyen PostgreSQL y RabbitMQ porque Docker no está
instalado. La CI exacta de `dadffd7f8926d9a014f9b07c142cac23b326cf72` está en
https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/40740259307;
consultar su resultado, no inferir PASS desde este enlace.

## Pendientes externos y estados independientes

| Owner | Operación afectada | Condición verificable | Capa |
|---|---|---|---|
| Marco/infra + G7 | preparación asíncrona tras las escrituras | red/vhost/ACL e identidades reales autorizadas; recuperación durable homologada | integración AMQP, no CRUD local |
| Vera + Taco + Poma | completado/rechazo/replay de preparación | SHA de cada productor/consumidor, mismo operation_id y causalidad, prueba bilateral con Inbox/Outbox sin duplicar efectos | integración/homologación |
| López + Marco + Poma | validación de maestros/esquemas y bajas seguras | productor/versiones/IDs autoritativos y protocolo probado conjuntamente; resultado CLEAR/IN_USE adecuado internamente en #48, sin homologación bilateral inferida | integración |
| Marco/proceso oficial BD | migraciones aditivas propuestas 0002/0003 preexistentes | aprobación, aplicación y postcheck por checksum/SHA en ambiente compartido | despliegue; no se aplicaron aquí |
| Owners de preparación + Marco | recuperación de REJECTED | causa concreta, operación correctiva publicada y replay idempotente probado por código | operación específica; continúa bloqueada con seguridad |

Estado recomendado #47: IMPLEMENTAR_PARCIAL / candidato implementado internamente,
pendiente de integración, homologación y evidencia de despliegue. Los éxitos
locales no autorizan cerrar el issue ni declarar READY_FOR_DEPLOY.
