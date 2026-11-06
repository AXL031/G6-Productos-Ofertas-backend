# Ficha — catalog-svc

## A. Identidad

Owner Poma. El SHA `a81f2d5fa735d7353b5df0ec0f095abac489e5d3` es la revisión histórica de `origin/poma` usada en el corte documental anterior, no el código actualmente integrado. La revisión Poma `263bd2655184c3cd559ab1f682a75f3730f5f85f` se integró mediante Backend PR #185 (merge `c18a91f51c4702b0e24a166cc0eb1d9cd478e6d6`); la corrección posterior de readiness, head `32a7824507994b5a83055506ca6947d856e234ff`, se integró mediante PR #191 (merge `9f1bed8abcab2f58677cf3cb63a40b7855e914a3`). Código actual de referencia: Backend `master` `921fcfa443499f0af9dc63360f664da7f4001d5d`. Esto identifica código integrado, no imagen desplegada. Puerto 3001 / `CATALOG_SVC_PORT`; schema `catalog`; proyecto/contenedor `g6-catalog-svc`; Compose genérico; `/etc/g6-catalog-svc/runtime.env`; estado `/var/lib/g6-productos-ofertas/catalog-svc`. La auditoría Oracle del 19-oct registró imagen `9205eb455c4965a82ccb9fc4714cf976e4c059b0` y `/health/ready` 503; la observación posterior del 20-oct encontró respuestas funcionales y readiness intermitente. Son cortes históricos de infraestructura, distintos del código hoy integrado; no se verificó aquí qué imagen está activa actualmente.

## Política de seguridad progresiva H4

Catalog se prepara junto con Taxonomy como primer candidato de revisión, sin autorización de exposición o despliegue. Ver [política operativa](../H4-MODO-DEMO-AUTH-REVERSIBLE.md). `G6_SECURITY_MODE` no está implementado. `G6_READ_ONLY_DEMO_ENABLED` y `GATEWAY_DEMO_NO_AUTH_ENABLED` mantienen sus defaults/semántica descritos en la política; `CATALOG_DEMO_GATEWAY_IPS` corresponde a la modalidad restringida existente. La observación HTTPS anónima de abajo es evidencia histórica del comportamiento observado en su fecha, no aprobación vigente de esos operationIds. Publicación requiere fila aprobada, evidencia y SHA.

## B. Configuración runtime

| Variable | Uso | Fuente/secreto | Consumidor / validación |
|---|---|---|---|
| `NODE_ENV`, `PORT`, `CATALOG_SVC_PORT` | Compose pone production y puerto | Compose | `config.ts`, `http-config.ts`; puerto requerido/validado |
| `CATALOG_SVC_HOST` | bind host; opcional | Dockerfile genérico define `CATALOG_SVC_HOST=0.0.0.0`; runtime solo si se sobrescribe | `http-config.ts`; Compose/Dockerfile ya lo inyecta para contenedor |
| `PGHOST`,`PGPORT`,`PGDATABASE`,`PGUSER`,`PGPASSWORD` | conexión PostgreSQL schema catalog | administrador DB suministra; `PGPASSWORD` secreto | `database.ts`; obligatorias, valid host/port/role |
| `PGSSLMODE`,`PGSSLROOTCERT` | TLS y CA | runtime path; CA montada por Compose en `/run/g6-certs/supabase-server-root.crt`; no secreto | `database.ts`; `verify-full`, CA legible |
| `G6_DATABASE_SCHEMA`,`G6_EXPECTED_ROLE`,`G6_CONNECTION_MODE` | schema/identidad/mode | Marco/DB owner autoriza rol | `database.ts`; schema literal `catalog`, expected role whitelist `catalog_dev_login`/`catalog_app`, mode `session`/`direct` |
| `G6_CONNECT_HOST` | opcional conexión con identidad hostname aparte | runtime; no secreto | `database.ts`; IP/hostname validado |
| `CATALOG_TAXONOMY_URL` | URL de Taxonomy; condicional según demo/uso | runtime; no secreto | `taxonomy-config.ts`; origin privado sin credenciales |
| `CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED` | default false; preview de demo | runtime privado | `config.ts`; bool; no autoriza datos falsos |
| `CATALOG_PRICING_URL` | requerida si preview true | runtime privado | `config.ts`; solo `http://pricing-svc:3002` |
| `DATABASE_URL` | no soportada como alternativa | no configurar | `CatalogConfig` exige variables `PG*`; el test de configuración rechaza que `DATABASE_URL` las sustituya |
| `SECURITY_ISSUER`, `SECURITY_DISCOVERY_URL`, `SECURITY_JWKS_URL` | opcionales, pero las tres deben configurarse juntas si se configura alguna | runtime.env; URLs públicas, no tokens | configuración integrada; validar valores contra el parser del SHA candidato |
| `RABBITMQ_URL`, `CATALOG_AMQP_PRODUCER_USERS` | opcionales al arrancar; activan AMQP si se configuran | runtime.env; URL/usuarios son sensibles | código integrado; conectividad y permisos de Oracle no verificados. Deploy AMQP sujeto a compatibilidad de nombres, red y permisos |
| `CATALOG_PREPARATION_TIMEOUT_MS` | opcional, entero positivo | runtime.env | límite de preparación; respetar validador del SHA |

Compose inyecta `NODE_ENV=production`, `PORT=3001`, `CATALOG_SVC_PORT=3001` y monta CA en solo lectura. El Dockerfile define `CATALOG_SVC_HOST=0.0.0.0`. El resto de valores requeridos/condicionales procede de `runtime.env`; no copies valores.

## C. Dependencias

El código actualmente integrado contempla PostgreSQL TLS verify-full y Taxonomy por URL privada; Pricing solo para preview. La auditoría física del 19-oct observó `g6-http`, pero no verifica la membresía ni el runtime actual. El código incluye configuración AMQP de Catalog; no hay evidencia aquí de conectividad, permisos o operación RabbitMQ en Oracle. Ver [red](../MATRIZ_DEPENDENCIAS.md) y [compatibilidad RabbitMQ](../RABBITMQ_COMPATIBILIDAD.md).

## D. HTTP / seguridad

La revisión normativa Docs `master` consultada al corte de esta actualización es `a7778ec1a22811c1213a94ef096ab905911342cc` (OpenAPI `0.6.0-rc.3`, AsyncAPI `0.6.0-rc.4`); no usar la referencia histórica `c36bd9a...` / rc.1 como contrato vigente. La guía de demo `apps/api-gateway/INT-ASAP-MARKETPLACE.md` registra respuestas HTTPS anónimas observadas el 2026-10-19: (1) `GET /api/v1/categorias` → **200** (lo atiende Taxonomy, no Catalog); (2) `GET /api/v1/productos?canal=MARKETPLACE&q=codex-audit&pagina=1&tamanio=24` → **200**, lista vacía (`items=0`); (3) `GET /api/v1/productos/por-slug/codex-audit-nonexistent?canal=MARKETPLACE` → **404** para slug deliberadamente inexistente. Son evidencia histórica de respuestas HTTP, no aprobación pública vigente, producto comercial positivo ni readiness general. El corte de la matriz Docs consultado tiene cero `PUBLICA_APROBADA`. No atribuir el endpoint de categorías a Catalog ni usar la ruta fallback `/productos/{productoId}` como endpoint probado.

**Observación complementaria 2026-10-20 00:08 UTC (no reemplaza la sonda previa ni la auditoría del 19-oct):** mediante `curl.exe` PowerShell, sin autenticación y con validación TLS normal (`ssl_verify_result=0`), el Gateway público devolvió `GET /api/v1/productos?canal=MARKETPLACE` **200** en 13.021927 s (`items=15`, `pagina=1`, `tamanio=20`, `total=15`); la respuesta incluyó Nike Academy. `GET /api/v1/productos/por-slug/nike-academy-hv4386-100?canal=MARKETPLACE` devolvió **200** en 3.163814 s, JSON, `product_id=2ee6399e-2333-5916-847b-f6d2a0f03527`, SKU base `NIK-ACADEMY-HV4386-05`, precio 129.9 PEN, oferta nula, cero variantes y una imagen. Las dos respuestas fueron JSON UTF-8. `GET /api/v1/categorias` respondió 200 en 1.936968 s con 8 categorías; ese endpoint lo atiende Taxonomy. Estos GETs exitosos acreditan rutas/datos para la demo y no readiness global.

Por SSH de solo lectura a las 00:09 UTC del 2026-10-20, el contenedor Catalog llevaba dos días y Docker aparecía `healthy`, con imagen tag `9205eb455c4965a82ccb9fc4714cf976e4c059b0`; esa imagen era distinta de la revisión Poma `a81f2d5...` documentada entonces y también es anterior a los merges #185/#191. Las sondas internas de `/health/ready` fueron intermitentes: 503 a las 00:07:06, y 200 a las 00:09:31 localmente y desde Gateway. No se atribuye la intermitencia a falta de datos ni a un componente concreto sin diagnóstico adicional. Estos son cortes históricos; readiness e imagen activas deben verificarse antes de release.

## E. RabbitMQ

El código integrado contiene configuración/productores AMQP, pero su presencia no acredita broker conectado en Oracle. La auditoría física del 19-oct observó Rabbit aislado y nombres físicos distintos de los candidatos documentados; antes de activar cualquier flujo se debe verificar contrato, exchange/queue/routing key, bindings, ACK y permisos mínimos. La identidad física `g6_catalogo` no concede permisos por sí misma. No se afirma integración ni despliegue RabbitMQ.

## F. Persistencia

Schema `catalog`, rol limitado esperado, select queries para readiness y demo. El código integrado y CI contienen fixtures PostgreSQL aislados y pruebas de grants; confirmar migraciones aplicables al SHA candidato antes de release. Bootstrap verifica identidad y no debe ejecutar migraciones.

## G. Pruebas y aceptación

`npm run build:catalog-svc`; `npm test -- apps/catalog-svc`; `npm run test:e2e -- apps/catalog-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh catalog-svc`; build `Dockerfile.service`; PostgreSQL desechable, TLS/readiness y smoke list/detail con datos autorizados. La CI y el código de `master` recibieron cambios posteriores, incluidos PR #185 y #191; revisar los jobs del SHA candidato y no trasladar automáticamente el estado de CI del corte anterior a una release Oracle.

## H. Bloqueos y entrega

La investigación y correcciones de Catalog/readiness se integraron en PR #185 y PR #191; los 503/200 descritos arriba son observaciones históricas, no un diagnóstico de runtime vigente. Antes de una release, comprobar readiness y smoke funcional contra el SHA e imagen candidatos, rol/runtime y autorización individual. La conectividad y compatibilidad RabbitMQ siguen siendo gates separados; no se infieren del código ni de pruebas locales.

## Marketplace H4 — Catalog

Operaciones consumidas: `listarProductos` (`GET /api/v1/productos`) y `obtenerProductoPorSlug` (`GET /api/v1/productos/por-slug/{slug}`); `listarCategorias`/marcas pertenecen a Taxonomy. Mantener elegibilidad comercial y SKU vendible; no derivar SKU de IDs. Filtros múltiples/precio solo se consideran implementados con contrato y prueba Provider de resultado global. El estado/owner, PR y evidencia por SHA se mantienen en la [matriz H4](../../../integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md). No tomar un HEAD de rama personal como implementado en master ni CI/deploy.
