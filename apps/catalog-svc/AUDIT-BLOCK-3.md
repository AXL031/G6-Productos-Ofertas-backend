# Auditoría correctiva y bloque 3 — #49, #50 y #51

Fecha: 2026-10-17. Rama `poma`. SHA inicial/local/remoto comprobado:
`1fa3baed089a1852dc1566cc6fdf2950178f1c4f`.
Master remoto `2970df90babf2c8caa1849b179b02918fc74a005`, ya integrado.
No se realiza otro merge, rebase, creación de rama, PR ni despliegue.

## Fuentes y alcance autorizado

Se consultaron completos los issues backend #43–#51, #23, #42, #106, #107,
#109, #110 y #29, los comentarios disponibles de #44/#46/#107; frontend
#5/#6/#35, PR #40 y sus comentarios (sin comentarios al consultar).
Los issues mantienen el alcance del bloque anterior. #50 exige adaptador API real
y prohíbe habilitar llamadas userBearer en demo anónima sin resolución formal.

Normativa contrastada en G6-Productos-Ofertas-docs: SPEC/HU/FLOW-003/004,
arquitectura, registro DEC-F, matrices de trazabilidad/intermodular, modelo físico
y migración 0001 de Catálogo, catálogo de errores/eventos y topología RabbitMQ.
OpenAPI `0.6.0-rc.1`, blob `f64bfe9a097b2a0f74c2600988305443d92f640e`;
AsyncAPI `0.6.0-rc.2`, blob `a5552e51c651d1eabfcd6cbb9607abf8ab0573e9`.
No cambian los contratos consultados respecto del bloque anterior.

Aplican DEC-F-001 (identidad SKU), -002 (autoridad Inventory), -006 (autoridad
Pricing), -009 (idempotencia/intención), -011 (físicos) y -012 (evidencia y
compatibilidad). No se concede acceso por aparecer un scope en YAML.
Se mantienen las decisiones explícitas PEN, slug estable nombre normalizado +
UUID y SKU explícito. No se añade bypass de JWT ni una política ficticia.

Ownership: apps/catalog-svc. **Excepción expresa del usuario en esta ejecución:**
solo scripts/ci/marketplace-docker.sh y scripts/ci/issuer.mjs para reparar la
configuración de confianza del smoke; sin cambiar su aserción 400.

## A. Auditoría de issues anteriores

PASS requiere evidencia para el criterio indicado; no equivale a cierre integral.
La evidencia de CI anterior pertenece exclusivamente a 1fa3bae, no a este cambio.

| Issue / criterios | Encontrado y probado | Defecto/corrección actual | Dependencia / estado |
| --- | --- | --- | --- |
| #43: config fail-closed, health/readiness, logging | Configuración validada, TLS/identidad al arranque; health independiente; sondas concurrentes acotadas | Readiness ya no atribuye automáticamente cualquier fallo a BD; logs redactan objetos driver serializados y paths | Criterios locales cubiertos; integración de la nueva versión requiere CI |
| #44: 13 tablas, schema propio, provider, transacción y permisos | Drizzle/repo/Database existentes; CI 1fa3bae ejecutó 12/12 casos PG y 4/4 de runtime TLS | Timeouts 57014/55P03 y errores pg/pg-pool sin código ahora son indisponibilidad 503; pruebas de rollback y saturación añadidas | Sin migración histórica ni escritura Supabase; nuevo PG local SKIP |
| #45: estados, SKU, perfiles, preparación y transiciones | Dominio y casos transaccionales conservados; activación con COMPLETED, padre/hijos independientes y último hijo | Sin cambio funcional de reglas; pruebas anteriores sin regresión local | PARTIAL: Q-06 y fronteras normativas pendientes |
| #46: ocho lecturas, auth/DTO/Problem/paginación | Controladores/servicios/repositorios reales; casos HTTP y JWT | Reproducción HTTP de pagina=0: seguridad ausente 503; configuración válida 400; 401/403 conservados | PARTIAL: elegibilidad comercial/barcode específicos |
| #23: ID/slug/barcode, SKU opaco, 404 | Lookup ID/slug preparado con política explícita; validación barcode y ceros iniciales | No sustituir dependencia por lista vacía/404/200 | PARTIAL: D-CAT-01..06 |
| #47: doce mutaciones, locks/versiones/rollback/Outbox/retry | Casos de uso transaccionales existentes y 12 rutas HTTP; CI previo cubrió persistencia, conflictos y concurrencia | Nueva integración conjunta prueba coordinación durable, sin cambiar las reglas aprobadas | PARTIAL: recuperación REJECTED por código y SKU omitido aislados |
| #48: envelope, confirms, ACK, Inbox/Outbox, stale y reconnect | CI 1fa3bae ejecutó 5/5 pruebas de broker; dedupe/terminal/stale en PG | Cancelación remota del consumidor ya fuerza reconexión; shutdown tiene plazo incluso si close no responde; señales tras commit/confirm | PARTIAL: GenericData y homologación de infraestructura pendientes |

### Cobertura contractual preservada

- Lecturas: listarProductos, obtenerProducto, consultarDatosFisicos,
  obtenerProductoPorSlug, obtenerPreparacionProducto, listarVariantesProducto,
  obtenerVariante, resolverCodigoBarras.
- Escrituras: crearProducto, actualizarProducto, activarProducto,
  desactivarProducto, reactivarProducto, reintentarPreparacionProducto,
  crearVariante, actualizarVariante, activarVariante, desactivarVariante,
  reactivarVariante, reintentarPreparacionVariante.
- No se agregan rutas ni contratos. Las discrepancias de 400 no documentado en
  algunas lecturas permanecen registradas en AUDIT-BLOCKS-1-2.md.
- BORRADOR incompleto permitido; edición activa inválida revierte completa;
  identidad estable; no perfil/Inventory del padre con variantes; sin Pricing
  ficticio de variante; desactivación lógica conserva identidades/estados hijos.
- El retry manual requiere intención vigente reconstruible y umbral explícito
  para PENDING; COMPLETED terminal. La regla de recuperabilidad REJECTED no se
  infiere por silencio o por transcurso de tiempo.

## B. Investigación y reparación del CI

- Run: https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39031944960
- SHA: 1fa3baed089a1852dc1566cc6fdf2950178f1c4f.
- Job 117394009685, paso 29: Positive Marketplace containers with disposable
  PostgreSQL and TLS. Otro job Taxonomy terminó correctamente.
- Log: servicios sanos a 12:22:01 UTC; a 12:22:02 UTC falla
  `/api/v1/productos?canal=MARKETPLACE&pagina=0`, actual 503, expected 400;
  stack en marketplace-probe.mjs:10 y :31; salida 1 y cleanup posterior.
- Antes del smoke: 633 unitarias y 540 E2E aprobadas/57 omitidas. Catálogo:
  12/12 PG, 4/4 runtime PG y 5/5 RabbitMQ ejecutadas en ese SHA.

**Salto que produce 503:** CatalogAuthGuard → CatalogTokenVerifier.loadKeys,
sin configuración SECURITY. El guard se ejecuta antes del controlador/parser.
Gateway sí autentica y reenvía Bearer en el modo normal. El 503 de Catálogo se
conserva como Problem por Gateway. La falta de elegibilidad no explica pagina=0:
con autenticación correcta, el parser rechaza primero ese parámetro con 400.

**Configuración responsable:** marketplace-docker.sh solo configuraba AUTH_*
para Gateway. El env de Catálogo no incluía SECURITY_* ni la CA de confianza del
emisor. issuer.mjs tampoco publicaba discovery: devolvía un token para cualquier
ruta que no fuese /keys. Añadir solo las variables habría sido insuficiente.

**Cambio mínimo autorizado:** SECURITY_ISSUER, SECURITY_DISCOVERY_URL,
SECURITY_JWKS_URL y NODE_EXTRA_CA_CERTS para catalog.env; discovery con issuer y
jwks_uri exactos en el emisor efímero. No cambia la aserción, el proxy ni JWT.
Sintaxis Node/Bash validada. El smoke completo requiere Docker; se verificará
en Actions para el SHA publicado, sin reutilizar el resultado anterior.

Regresiones: catalog-security.provider.spec.ts usa controlador, guard, RS256,
discovery/JWKS, parser y política comercial reales. Prueba 503 sin config, 400 con
config, 401 ausente/expirado/firma inválida, 403 scope/cliente/audiencia y 503 de
elegibilidad no resuelta. marketplace-ci.config.spec.ts fija el cableado y 400.

## C. Implementación del bloque 3

### #49 — IMPLEMENTAR_AHORA / verificación de infraestructura parcial

- JWT comparte una sola carga discovery/JWKS entre 100 validaciones concurrentes;
  error no queda cacheado como salud. Conserva claims, expiración, firmas y auth.
- Errores PostgreSQL: 57014/55P03 y mensajes exactos pg/pg-pool de timeout/cierre
  sin SQLSTATE se traducen a conexión no disponible (503); dominio, constraints
  y permisos conservan su clasificación. No se registra SQL/driver/parameters.
- Cancelación remota AMQP (delivery null) deja de abandonar silenciosamente el
  consumidor; se cierra la conexión y el ciclo recupera el consumo.
- Shutdown acotado a cinco segundos tanto para entregas como close handshake;
  no afirma cancelar un commit en curso. La recuperación depende de redelivery
  e Inbox; un resultado confirmado permanece durable aunque su ACK no llegue.
- Indicadores internos acotados por código: conexión/cancelación AMQP,
  Outbox PUBLISHED/PENDING, Inbox APPLIED/STALE/TERMINAL/DUPLICATE y retry/DLQ
  confirmados. Se registran después del commit/confirm correspondiente.
- Logs HTTP: método, status, duración y correlationId. Sin URL/query, body,
  headers ni identidad personal. IDs de operación/mensaje solo UUID válidos.
- Logger redacta headers, payload/body, consultas, parámetros, detail, stack,
  paths privados, tokens y URLs con credenciales, también en JSON serializado.
- No hay endpoint público nuevo de métricas ni se infiere backlog de contadores.
- Liveness sigue separada de readiness. RabbitMQ no se convierte en un gate
  global: una mutación confirmada puede persistir Outbox durante su caída. Eso
  no acredita preparación ni elegibilidad. PendingCommercialEligibility sigue
  cerrada y ninguna dependencia no comprobada se presenta como saludable.

Límites existentes conservados: pool 4; conexión/query/statement 10 s; lectura
HTTP de dependencias 5 s y 1 MiB; confirms AMQP 5 s, prefetch 20 y ciclo 2 s.
La nueva prueba de saturación usa otro pool pequeño solo en el test, sobre la
misma instancia PG desechable; no agrega un pool a producción.

### #50 — IMPLEMENTAR_PARCIAL

Gateway real compilado en directorio temporal + Catálogo real en loopback:
tres pruebas sin reemplazar proxy/guard/servicio demuestran 401 al operar en demo
con y sin Bearer entrante, y 404 para ruta desconocida. El harness corrige un
problema inicial de compilación sin emisión; usa el proyecto real de Gateway y
comprueba el artefacto antes de arrancar. No modifica fuente de Gateway.

Frontend inspeccionado en modo lectura: master
`679e797c1557539bbed1260f2aa9b161f1fd7fe2`; PR #40 OPEN,
head `8cdc6296bb0445a78e70d4bf227864de808dc721`.
catalogServices.ts permite inyectar apiCatalog/apiTaxonomy, pero por defecto api
usa unavailableApiCatalogRepository, que lanza error explícito para todas las
operaciones; no implementa HTTP ni fallback mock. DataMode solo admite mock/api,
no un modo híbrido implementado. No se localizó transporte HTTP compartido en
el árbol consultado. PR #40 declara solo integración mock.

Adaptación exacta pendiente en frontend (#5/#6/#35; composición #109/#45):
conectar puertos al cliente común vía Gateway, inyectar providers por feature,
mapear DTO camel/snake, perfil dimensionesCm anidado y atributo valor_id,
paginación/estados, OperationAccepted y flags backend. La UI tiene filtros de
tipo/modelo y detalle administrativo que no deben enviarse como queries nuevas
ni resolverse asumiendo que el GET comercial expone borradores. Mapear errores
400/401/403/404/409/422/503, timeout/cancel y red; sin retries automáticos de alta.
No se implementa frontend ni su configuración compartida en este PR.

### #51 — IMPLEMENTAR_PARCIAL

Se conservan los casos de producto/variante de persistencia (fixtures de maestro
aisladas, identificadas como pruebas de provider, no React E2E).
La suite PG pasa de 12 a 15 casos:

1. JOINT-01: fixture interna BORRADOR + preparación + Outbox en transacción;
   requested por relay real, respuesta de protocolo con usuario broker distinto,
   consumer/Inbox/COMPLETED reales, replay sin doble Inbox, caída del broker,
   nuevo agregado pendiente y republicación después de reconectar. Una instancia
   PG TLS y un broker por suite; sin dobles de transporte, DB ni coordinación.
   Es integración conjunta backend de coordinación, no alta HTTP/Taxonomy/React.
2. PG-FAULT-01: statement timeout real, rollback completo y recuperación del pool.
3. PG-FAULT-02: pool ocupado, adquisición vence de forma segura, libera y recupera.

No se afirma que la fixture de preparación sea una ejecución del servicio real
Pricing/Inventory. No hay E2E navegador sin adaptador API/frontend integrado ni
política demo de Catálogo aprobada. Playwright no se ejecuta contra mocks para
presentarlo como recorrido integral.

## D. Matriz de integración

| Frontera | Código / prueba aislada | Integración autenticada real | Homologación / despliegue |
| --- | --- | --- | --- |
| Gateway | Proxy existente; nuevo provider real Gateway→Catalog demuestra demo 401 | JWT del smoke pendiente de Actions nuevo SHA | No acreditados |
| React | Puertos/mock y adaptador no configurado inspeccionados, sin cambios | BLOCKED_SPECIFIC: adaptador y política userBearer/demo | No acreditados |
| Taxonomía | Cliente HTTP acotado, Bearer, validación y errores; casos provider | No acreditada con runtime real Taxonomy nuevo SHA | No acreditados |
| Pricing | Requested/resultados tipados, sin precio propio | Emisor de protocolo de prueba; no servicio Pricing real | No acreditados |
| Inventory | Requested/resultados tipados, sin stock propio | Emisor de protocolo de prueba; no servicio Inventory real | No acreditados |
| PostgreSQL | Pool/TLS/roles/schema/transacciones, PG anterior en CI | Pruebas nuevas locales SKIP; pendientes del CI entregado | No implican Supabase desplegado |
| RabbitMQ | Transporte real; lifecycle con doubles unitarios; broker anterior CI | Nuevo JOINT-01 pendiente de CI | No implica Oracle/G5 |
| Seguridad | RS256/discovery/JWKS locales reales; 401/403/503 | No integración G7 ni grants efectivos acreditados | No acreditados |

## E. Evidencia reproducible

Las pruebas corresponden al commit de código `b068aefa50119b5cda6f331a749b307d0e733216`,
derivado de 1fa3bae. La matriz por escenario está en
`test/evidence/block-3-local.json` (SHA, contrato, entorno, componentes,
resultado esperado/obtenido y clase de prueba). El resultado remoto debe
vincularse al SHA exacto publicado en Actions, no al run histórico.

| ID / tipo | OperationId o protocolo / versión | Componentes y resultado esperado | Evidencia local |
| --- | --- | --- | --- |
| SEC-01/provider | listarProductos, OpenAPI rc.1 | Config ausente 503, config válida+pagina=0 400 | PASS; catalog-security.provider.spec.ts |
| SEC-02/provider | listarProductos/crearProducto, OpenAPI rc.1 | 401/403 y JSON inválido VALIDACION, sin filtración | PASS; mismo archivo |
| AUTH-01/unit | JWT G7/RS256 | 100 concurrentes: 2 fetch; recuperación tras error | PASS; catalog-auth.spec.ts |
| GW-01/integración HTTP | listarProductos, OpenAPI rc.1 + excepción #107 | Gateway demo elimina Bearer; Catalog 401; unknown 404 | PASS 3 casos; gateway-catalog.provider.e2e-spec.ts |
| DB-01/unit | SQLSTATE/pg | 503 técnico, errores seguros, dominio conservado | PASS; database-errors.spec.ts |
| LOG-01/unit | Indicadores internos #49 | Contadores/IDs y logs sin payloads/secretos | PASS; catalog-telemetry.spec.ts, sanitized-logger.spec.ts |
| MQ-01/unit | AsyncAPI rc.2 | Reconnect/cancel, ACK post-commit, retry no confirmado sin ACK, shutdown acotado | PASS 5; catalog-amqp.runtime.spec.ts |
| JOINT-01/conjunta backend | inventory initialization, AsyncAPI rc.2 | PostgreSQL+relay+RabbitMQ+Inbox+replay+caída/recuperación | SKIP local sin Docker; postgres.persistence.e2e-spec.ts |
| PG-FAULT-01/integración | Transacción/57014 | Timeout revierte agregado; mismo pool recupera | SKIP local; mismo archivo |
| PG-FAULT-02/integración | Adquisición pool | Saturación 503; libera y recupera | SKIP local; mismo archivo |
| CRUD/provider | Doce mutaciones y ocho consultas, OpenAPI rc.1 | DTO/auth/estados/errores; fixtures explícitas | Casos HTTP locales PASS; PG dependiente de Docker |
| BROWSER-01/E2E navegador | MK-003/MK-004 | React→Gateway→Catalog sin fallback | BLOCKED_SPECIFIC; no adaptador real/decisión demo |

| Comando exacto | Resultado local final |
| --- | --- |
| npm run build:catalog-svc | PASS |
| npm test -- --no-file-parallelism apps/catalog-svc | PASS: 268 pruebas, 29 archivos |
| npm run test:e2e -- --no-file-parallelism apps/catalog-svc | 38 PASS / 28 SKIP, 5 archivos PASS / 4 SKIP |
| npm test -- --no-file-parallelism | PASS: 655 pruebas, 64 archivos |
| npm run test:e2e -- --no-file-parallelism | 522 PASS / 81 SKIP, 18 archivos PASS / 8 SKIP |
| npm run typecheck | PASS |
| npm run lint | PASS |
| npm run format:check | PASS |
| npm run build:all | PASS |
| git diff --check | PASS |
| npx tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext --target ES2023 --experimentalDecorators --emitDecoratorMetadata --esModuleInterop --skipLibCheck --types vitest/globals apps/catalog-svc/test/postgres.persistence.e2e-spec.ts apps/catalog-svc/test/gateway-catalog.provider.e2e-spec.ts | PASS |
| node --check scripts/ci/issuer.mjs | PASS |
| bash -n scripts/ci/marketplace-docker.sh (Bash de Git) | PASS |

Las suites locales omiten Docker y eso nunca equivale a PASS de infraestructura.
La publicación requiere consultar Actions por el SHA final y comunicar su
resultado al cerrar la ejecución, separado de esta evidencia local.

Entorno local: Windows/Node 24.16.0, loopback, TEMP/TMP aislado. Docker no
disponible; OpenSSL de Git está instalado fuera de PATH. Bash inicialmente fue
bloqueado por sandbox; la comprobación con permiso de ejecución pasó.
Ningún fallo se oculta quitando aserciones o deshabilitando seguridad.

## F. Git y archivos

- Rama poma, inicial 1fa3bae. Código: `b068aef`. Commits/SHA final: git log del bloque; el propio
  commit fija el snapshot del informe sin una referencia circular.
- Se permite push normal al pasar validaciones: actualizará automáticamente el
  PR #125 OPEN. No se cambia título/descripción/estado en esta ejecución.
- Sin PR nuevo, merge, force push, reset, deploy ni escritura Supabase.
- Se preservan los cambios locales previos de scripts/seed/mcp/catalog y el
  certificado prod-ca-2021.crt; no se incluyen en los commits.
- Modificados: app.module.ts, bootstrap.ts, catalog-amqp.ts, catalog-auth.ts/spec,
  catalog-message.service.ts, database-errors.ts/spec, readiness.ts,
  sanitized-logger.ts/spec; nuevos catalog-telemetry.ts/spec,
  catalog-amqp.runtime.spec.ts, catalog-security.provider.spec.ts,
  marketplace-ci.config.spec.ts; pruebas postgres.persistence.e2e-spec.ts,
  gateway-catalog.provider.e2e-spec.ts y support/disposable-catalog-broker.ts;
  este informe/README; los dos scripts CI autorizados.

## G. Bloqueos y siguiente acción

| Owner | Operación / problema | Fuente | Desbloqueo exacto |
| --- | --- | --- | --- |
| Marco/arquitectura + poma | Gateway demo no reenvía Bearer; Catalog exige identidad | #107, #50, OpenAPI user/serviceBearer | Decisión formal y acotada del dueño de seguridad Catálogo; no inferirla del flag de Gateway |
| Frontend Gabriel + Marco/composición | MK-003/004 no llaman API por defecto, hybrid/cliente común pendiente | Front #5/#6/#35/#45, backend #109/#50, código consultado | Adaptador HTTP real con DTO/error mapping, provider injection y contrato de detalle administrativo definido |
| Arquitectura/Marco + poma + Retail | Barcode y elegibilidad D-CAT-01..06 | SPEC-003/004, DEC-F-001/-012 | Política/asociación persistente y defaults aprobados, contrato ejecutable y migración si procede |
| Arquitectura + Taxonomy/lopez | Q-06 y protocolo de maestros | Modelo físico, SPEC-010 referenciada, GenericData | Resolución oficial del cambio de tipo y semántica/versiones/barreras tipadas |
| Arquitectura + Bulk/castilla | Handler Bulk GenericData | AsyncAPI rc.2 | Payload/intención/resultados y secuencia aprobados |
| Pricing/vera + Inventory/taco + arquitectura | REJECTED recuperable | SPEC/HU/FLOW-003/004 | Política verificable por código y operación publicada que corrige la causa |
| Operación G6 | PENDING prolongado | SPEC-003/004 | Umbral CATALOG_PREPARATION_TIMEOUT_MS aprobado, configurado y probado |
| Owner producto | SKU omitido | Decisión actual del usuario | Nueva regla expresa; mientras tanto enviar SKU |
| Infra G6/Marco, G5 y Seguridad | AMQP productivo/exposición | #110/#29 y topología | Permisos mínimos, credenciales, red privada y homologación verificados; no es este despliegue |
| Infra local/CI | Nuevos escenarios conjuntos/fallos PG | #49/#51 | Docker/OpenSSL y ejecución del SHA exacto; diferenciar CI de integración externa |

Estado antes de validar el CI nuevo: #43/#44 con criterios internos probados y
ampliaciones PG pendientes de ejecución; #45/#46/#23/#47/#48 PARTIAL por sus
fronteras específicas; #49 IMPLEMENTAR_PARCIAL por evidencia infra nueva pendiente;
#50 PARTIAL; #51 PARTIAL. Ninguna implementación local implica homologación o
despliegue. El cierre de la ejecución debe añadir el resultado real del CI.
