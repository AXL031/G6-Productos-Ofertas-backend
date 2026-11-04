# Promotions → Taxonomy real — 04/11/2026

**Taxonomy por ID: PASS_LOCAL. Integración H4 completa: PARTIAL.**

Se reemplaza el antiguo bloqueo de ruta 404 del corte `20146a50` por evidencia
del proveedor fusionado en PR #181. El consumidor real de Promotions distingue
categoría activa, inactiva e inexistente; los errores de autorización no se
convierten en referencias válidas ni en ausencias ficticias.

## Fuentes y entorno

| Fuente | SHA / evidencia |
| --- | --- |
| Backend master fijado, incluido merge de PR #181 | `7f1ffc1f1f490861ef55ed3d84757d05954a2d33` |
| CI del proveedor fusionado | [41870289150](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/41870289150), 18/18 SUCCESS |
| Código productivo de Promotions, sin cambios | `33054c365e6497c14f8bf43a1d259846447d6cb8`; comparación de `apps/promotions-svc/src` contra el corte nuevo sin diferencias |
| Contratos Docs | `80f208978c2c703e2b2d62064112365e7b9e1677`, OpenAPI rc.3 / AsyncAPI rc.4 |
| Evidencia de esta ejecución | [real-services-2026-11-04.json](test/evidence/real-services-2026-11-04.json) |

El harness usa `git archive`, verifica blobs antes/después y compila el snapshot.
Ahora también verifica Dockerfile, `.dockerignore` y `ops/oracle`, utilizados al
construir el runtime. No mezcla master en la rama personal ni cambia otros servicios.
El nuevo master es un corte explícito; no se atribuyen resultados a futuros cambios.

Se conservan PostgreSQL 17 con TLS `verify-full`, RabbitMQ 4.2.9 descartable,
usuarios restringidos y cinco procesos Nest separados en red interna. Solo el
emisor JWT es una fixture explícita; no se sustituyen datos HTTP comerciales,
repositorios, `fetch` ni providers. Se usan filas sintéticas reales del esquema
oficial: dos categorías, productos no activos y saldos/rutas de prueba.

## Matriz de la frontera Taxonomy

Todos los endpoints de esta tabla pertenecen al SHA Backend fijado arriba.
Los identificadores de evidencia corresponden a `checks[].id` del JSON.

| Recorrido / escenario | Endpoint o interfaz | Resultado | Evidencia |
| --- | --- | --- | --- |
| Categoría existente, JWT M2M autorizado | `GET /api/v1/categorias/{id}` | 200 y DTO completo, incluyendo estado, version y slug | `taxonomy-category-existing-real-pg` |
| Categoría inexistente | mismo endpoint, UUID ausente | 404 `CATEGORIA_NO_ENCONTRADA`, Problem Details | `taxonomy-category-missing-contract-error` |
| Categoría inactiva | mismo endpoint, fila INACTIVO | 200 con estado INACTIVO, no confundido con ausencia | `taxonomy-category-inactive-real-pg` |
| Sin bearer / issuer o audience incorrectos / expirado / firma inválida | mismo endpoint | 401 `TOKEN_INVALIDO` | `taxonomy-category-auth-anonymous`, `-wrong-issuer`, `-wrong-audience`, `-expired`, `-bad-signature` |
| Cliente o scope ajenos / humano sin rol | mismo endpoint | 403 `SCOPE_INSUFICIENTE` | `taxonomy-category-auth-wrong-client`, `-wrong-scope`, `-human-without-role` |
| ID inválido | mismo endpoint, no UUID | 400 `VALIDACION` | `taxonomy-category-invalid-id` |
| Token de lectura no habilita listados | `GET /api/v1/categorias`, `GET /api/v1/marcas` | 403 para modulo-productos | `taxonomy-read-token-cannot-list-categorias`, `-marcas` |
| Token de lectura no habilita escritura | `POST /api/v1/categorias` | 403, sin filas creadas | `taxonomy-read-token-cannot-write`, `read-only-http-does-not-create-business-rows` |
| Control de listado con cliente permitido | `GET /api/v1/categorias`, modulo-marketplace | 200; aparece la categoría activa y se excluye la inactiva | `taxonomy-real-pg-list-control` |
| Consumidor Promotions: activa | `PromotionsSvcModule` → `ADMIN_REFERENCES.verify` → HTTP Taxonomy → PostgreSQL | incluye el ID en `categories` | `promotions-nest-taxonomy-reference-active` |
| Consumidor Promotions: inexistente | misma interfaz | conjunto vacío por 404 contractual | `promotions-nest-taxonomy-reference-missing` |
| Consumidor Promotions: inactiva | misma interfaz | conjunto vacío por estado, con proveedor HTTP 200 | `promotions-nest-taxonomy-reference-inactive` |
| Consumidor Promotions: grant local denegado | misma interfaz con secreto de prueba inválido | `CommercialDependencyError`, sin referencia válida/ausencia ficticia | `promotions-nest-taxonomy-denied-grant-fails-closed` |

El consumidor se obtiene de **un contexto real de `PromotionsSvcModule`**, con sus
factories nativas de credenciales, JWT/JWKS y referencias, sin overrides. La
configuración de ese probe desactiva el monitor de dependencias para ejecutar
esta comprobación de referencias; el proceso HTTP de Promotions conserva su
propio monitor de la prueba general. Cada contexto se cierra al terminar.

Esta es una integración real de la frontera del consumidor, con HTTP/PG del
proveedor. No se inventa una ruta HTTP de Promotions para exponer categorías.
El flujo HTTP completo de escritura/evaluación de reglas sigue pendiente: sus
referencias de producto pasan primero por Catálogo, que aún rechaza la identidad
interna. Tampoco se atribuye esta ejecución al recorrido Gateway de López;
ese proveedor tiene su CI y sus pruebas de Gateway independientes.

## Resultados y reproducción

- `node apps/promotions-svc/test/real-services.isolated.e2e.mjs`: **58 PASS, cero FAIL**.
  Incluye 20 casos funcionales de Taxonomy/consumidor y dos controles adicionales
  de liveness/identidad PostgreSQL de Taxonomy. Estado global PARTIAL por otras fronteras.
- `node --test apps/promotions-svc/test/support/real-services-assertions.test.mjs`: **12 PASS**.
- `npm test -- apps/promotions-svc --maxWorkers=1`: **373 PASS**.
- `npm run test:e2e -- apps/promotions-svc/test/app.e2e-spec.ts apps/promotions-svc/test/local-demo.e2e-spec.ts --maxWorkers=1`: **11 PASS**.
- `npm run typecheck`, `npm run lint`, Prettier de los dos scripts y
  `git diff --check`: **PASS**. La CI de la entrega se registra por su propio SHA
  en la PR; los 58 escenarios reales fueron ejecutados localmente, no se atribuyen
  al workflow general.
- Build del snapshot fijado: PASS. Las verificaciones de hash, runtime, roles/TLS,
  ausencia de nuevas filas y eliminación de contenedores/volúmenes/red/certificados
  se registran en el JSON.
- El primer recorrido detectó una expectativa histórica: listar categorías con
  modulo-productos devolvió 403. Se mantuvo el control positivo con un cliente
  permitido y se añadieron negativos explícitos de listados; no se relajó el proveedor.

Desde la raíz, con dependencias instaladas, Git con el SHA disponible, Docker y
OpenSSL/Git para Windows, ejecutar el comando del harness anterior. Si falta la
imagen local `g6-promotions-real-test-runtime:7f1ffc1`, se construye automáticamente
desde el Dockerfile del snapshot. No requiere `.env.local` ni credenciales de
Supabase/Oracle/G7 compartido. Los hashes de migraciones históricas siguen fijados;
la revisión no altera SQL aplicado.

La evidencia histórica de PR #172 y sus 40 escenarios permanece en el JSON del
03/11. La nueva evidencia se guarda en otro archivo; no reemplaza retrospectivamente
los resultados del corte anterior.

## Pendientes que no cierra esta prueba

| Responsable | Frontera | Condición de desbloqueo |
| --- | --- | --- |
| Poma | lectura de producto de Catálogo | SHA fusionado que permita modulo-productos en obtenerProducto y 200 real para producto elegible; en este corte se reproduce 403 |
| Taco | GET comercial de Inventory | identidad/canal MARKETPLACE autorizados según contrato, conservando negativos; en este corte se reproduce 403 |
| Vera/Poma + Axel | precio positivo/evaluación comercial | SKU activo y tarifa vigente verificables para mismo canal/instante, con proveedores autorizados |
| G7 + responsables de integración | JWT y grants reales | emisión/autorización real y pruebas autenticadas compartidas; el emisor local no concede homologación |
| Infra/productores + Axel | AMQP compartido, E2E completo y despliegue | conectividad/ACL/topología y ejecución bilateral; autorización de release y smoke del entorno |

El probe pasivo del broker sigue siendo una instancia de readiness independiente;
no demuestra consumo AMQP operativo. Se mantienen los issues H4 abiertos y no se
declara READY_FOR_DEPLOY ni homologación externa por estos resultados.
