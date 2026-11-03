# Integración local con servicios reales — H4, 03/11/2026

Estado: **PARTIAL**. El recorrido de contexto SKU funciona con el cliente real de
Promotions, Catálogo real, JWT RS256 del emisor local explícito y PostgreSQL real.
Los rechazos esperados son pruebas negativas PASS; no convierten en PASS una
operación comercial bloqueada. No se acredita todavía evaluación comercial
exitosa, homologación G7/G5, RabbitMQ compartido, Oracle ni READY_FOR_DEPLOY.

## Fuentes fijadas

| Fuente | SHA |
| --- | --- |
| Backend master al iniciar la ejecución final: Catálogo, Pricing, Inventario y Taxonomy | `20146a50d5e627c4749f225543a096edef51adbb` |
| Promotions, PR #159 ya fusionada | `33054c365e6497c14f8bf43a1d259846447d6cb8` |
| Docs, OpenAPI 0.6.0-rc.3 y AsyncAPI 0.6.0-rc.4 | `40b566976fb94d924116dcd01d41b3276c2bc9e3` |
| SQL histórico inmutable de Promotions | `51a5ce6e76bb0c61d93ef47416e46797bf5b9846` |

Se utilizó `git archive` de master, sin mezclar master en `cueva`. El harness
compara los blobs originales antes y después y comprueba que Promotions coincide
con PR #159. Incluye los cambios fusionados de PR #160 y de Pricing posteriores
al corte anterior `df5afa2`; los bloqueos históricos no se toman como actuales.

## Matriz por operación y escenario

Evidencia reproducible: [JSON de ejecución](test/evidence/real-services-2026-11-03.json).
La columna evidencia identifica `checks[].id`; allí figuran URL, status, cuerpo,
correlation ID y duración. `M` significa el SHA completo de master de la tabla
anterior y `P` el SHA completo de Promotions.

| Servicio / operación | Endpoint | SHA | Resultado | Evidencia | Responsable / condición pendiente |
| --- | --- | --- | --- | --- | --- |
| Promotions → Catálogo, contexto SKU | `GET /api/v1/productos/skus/{sku}/contexto` | P → M | PASS | `promotions-native-token-reader-to-real-catalog`, `catalog-context-simple-real-pg` | Ninguno para los SKU de prueba no elegibles: HTTP 200 y relación SKU→producto real. No acredita SKU activo. |
| Catálogo, SKU opaco, inactivo y ausente | mismo endpoint | M | PASS | `catalog-opaque-sku-not-double-decoded`, `catalog-inactive-context`, `catalog-missing-context-contract-error` | Conserva `%2F`, espacio, `+` y `Ñ`; 404 `SKU_NO_ENCONTRADO` para ausencia. |
| Catálogo, seguridad y validación | mismo endpoint | M | PASS | `catalog-auth-*`, `catalog-invalid-correlation` | Sin bearer/firma inválida/expiración/issuer/audience: 401; cliente/scope/humano no autorizado: 403; correlación inválida: 400. |
| Catálogo, persistencia y cancelación | mismo endpoint | P → M | PASS | `catalog-context-persists-across-real-process-restart`, `real-pg-lock-timeout-cancellation-and-recovery` | Cambio local a INACTIVO persistido tras reiniciar el proceso; lock real PostgreSQL provoca timeout acotado y recuperación después de ROLLBACK. |
| Catálogo, `obtenerProducto` desde Promotions | `GET /api/v1/productos/{productoId}?canal=MARKETPLACE` | M | BLOCKED | `blocker-catalog-product`: HTTP 403 | **Poma**: habilitar `modulo-productos` / `catalogo:leer` en esta operación, con pruebas 200 y 401/403; conservar validaciones. |
| Pricing, precio de SKU inactivo desde Promotions | `GET /api/v1/precios/skus/{sku}?canal=MARKETPLACE` | M | PASS (negativa) | `pricing-real-catalog-inactive-sku-contract-error`: HTTP 404 `PRECIO_NO_ENCONTRADO` | El master nuevo ya permite `modulo-productos` y conecta contexto real. No se mantiene el bloqueo histórico por proveedor null/allowlist/canales. Positivo con precio vigente todavía no acreditado. |
| Pricing, lote no elegible | `GET /api/v1/precios?skus={sku}&canal=MARKETPLACE` | M | PASS | `pricing-real-catalog-batch-omits-ineligible-sku`: HTTP 200 `{"items":[]}` | **Axel + Vera/Poma**: preparar un SKU activo con ciclo de activación y tarifa vigentes verificables para acreditar el positivo. No se fabrican confirmaciones Pricing/Inventory. |
| Inventario, lectura de Promotions | `GET /api/v1/inventario/disponibilidad/comercial?skus={sku}&canal=MARKETPLACE` | M | BLOCKED | `blocker-inventory-commercial`: HTTP 403 | **Taco**: autorizar identidad contractual y canal solicitado. Cambiar solo la allowlist no basta: `CANAL_CLIENT_MAP` también rechaza a `modulo-productos`. |
| Inventario, control con cliente Marketplace autorizado | mismo endpoint | M | PASS | `inventory-real-pg-four-commercial-states` | PostgreSQL/ruta de cumplimiento reales: DISPONIBLE, STOCK_BAJO, AGOTADO, INDETERMINADO. No representa acceso exitoso desde Promotions. |
| Inventario, coherencia de canal | mismo endpoint, `canal=RETAIL` / `INVALID` | M | PASS (negativa) | `inventory-client-channel-mismatch`, `inventory-invalid-channel` | Marketplace→RETAIL: 403; canal inexistente: 400. Sin bypass demo. |
| Taxonomy, categoría administrativa por ID | `GET /api/v1/categorias/{categoriaId}` | M | BLOCKED | `blocker-taxonomy-category-id`: HTTP 404 de ruta | **López**: implementar `obtenerCategoriaAdmin`, DTO y seguridad del OpenAPI. La categoría existe en la base y en el listado de control; no es evidencia de categoría inexistente. |
| Taxonomy, listado real de control | `GET /api/v1/categorias` | M | PASS | `taxonomy-real-pg-list-control` | JWT válido y categoría leída desde PostgreSQL real. El listado no sustituye el GET por ID. |
| Promotions, readiness nativa PG/RabbitMQ | servicio interno `PromotionsReadinessService.check(true)` | P | PASS técnico | `promotions-native-readiness-real-pg-and-broker` | Ambas dependencias `up`. No se inventa `/health/ready`; `/health` sigue siendo liveness. |
| Promotions, evaluación con SKU inactivo | `POST /api/v1/promociones/evaluar` | P → M | PASS (rechazo) / BLOCKED para éxito comercial | `promotions-real-http-inactive-sku-fails-closed`: HTTP 503; `promotions-invalid-inbound-token`: 401 | **Axel** continúa la prueba positiva al disponer de datos activos verificables y de las operaciones anteriores autorizadas. Sin fallback comercial. |
| Flujo completo React → Gateway → Promotions → proveedores/PG y eventos | operaciones contractuales anteriores | P / M | BLOCKED | `blockers[]` y escenarios anteriores | Poma, Taco y López: entregar cambios fusionados y SHA verificable. G7/infra/productores: grants reales, configuración y sesión bilateral para el entorno compartido. No se declara E2E exitoso. |

## Aislamiento y límites de la evidencia

- PostgreSQL 17/TLS y RabbitMQ 4.2.9 descartables, roles runtime sin privilegios
  administrativos y esquemas oficiales. El JSON registra los blobs de migración.
- Los cinco servicios se ejecutan como procesos NestJS de producción compilados,
  en contenedores separados de una red Docker `internal`, sin puertos publicados.
  El driver entra mediante un puente TCP con destinos fijos y puertos aleatorios
  ligados únicamente a `127.0.0.1`. El puente no cambia SQL, TLS, bearer ni cuerpos.
- Pricing exige HTTPS para Catálogo fuera de loopback. Una terminación TLS de
  pruebas reenvía bytes HTTP al Catálogo real y conserva la autorización. No
  genera datos comerciales ni elude el guard.
- Solo G7 es un emisor explícito de pruebas. Se comprueban firma, issuer,
  audiencia y scopes; se conservan claims no secretos. No se usa token humano
  como credencial del servicio. Ningún `fetch`, repositorio o provider se sustituye.
- Los datos son filas sintéticas en esquemas reales: productos BORRADOR/INACTIVO,
  categoría, ubicación, ruta de cumplimiento y saldos de prueba. No se insertan
  confirmaciones de activación ni se afirma venta/elegibilidad activa.
- RabbitMQ acredita conectividad y readiness pasiva de Promotions sobre una cola
  de prueba con nombre contractual. Los consumidores de cupones y los enlaces
  AMQP de los otros proveedores no se activan en este recorrido HTTP. No prueba
  publicación bilateral, consumo/restauración ni homologación del broker compartido.
- Se eliminan contenedores, volúmenes descartables, red y certificados creados por
  la ejecución. No se lee `.env.local` ni se accede a Supabase/Oracle/RabbitMQ compartidos.

El runtime Docker se fija por image ID en el JSON. Solo aporta Node y dependencias;
`dist` se monta desde el SHA compilado, en modo lectura. Las nueve dependencias
directas de producción coinciden exactamente con el lockfile fijado. El JSON
registra hashes del harness, aislamiento, roles/TLS, resultados y limpieza.

## Reproducción

Desde la raíz del repositorio, con dependencias instaladas, Docker Desktop activo
y el commit fijado disponible mediante `git fetch origin master`:

```powershell
$env:G6_TEST_OPENSSL = 'C:/Users/axel.cueva/AppData/Local/Programs/Git/usr/bin/openssl.exe'
node apps/promotions-svc/test/real-services.isolated.e2e.mjs
```

El harness crea una copia `git archive` si falta, valida blobs, compila con
`npm run build:all` y descarga únicamente SQL oficial fijado cuando falta en caché.
Un fallo de hash detiene la ejecución. No acepta URLs comerciales ni credenciales
compartidas. Para otra máquina sin la imagen local, construir primero el runtime
con `Dockerfile.service` del snapshot fijado:

```powershell
docker build -f node_modules/.cache/promotions-work/real-svc-20146a5/Dockerfile.service --build-arg SERVICE_NAME=promotions-svc -t g6-local-real-runtime node_modules/.cache/promotions-work/real-svc-20146a5
$env:G6_TEST_RUNTIME_IMAGE = 'g6-local-real-runtime'
node apps/promotions-svc/test/real-services.isolated.e2e.mjs
```

El tag se resuelve a image ID y se verifica contra versiones del lockfile antes de
arrancar aplicaciones. El primer intento sin imagen puede generar el snapshot y
detenerse al resolver el runtime; después se construye y se repite el comando.
`PARTIAL` con salida 0 significa que los escenarios definidos pasaron y subsisten
bloqueos explícitos; nunca equivale a E2E completo. Un escenario inesperado produce
`FAIL` y salida 1. Tras cambios de proveedores, actualizar el manifiesto y las
expectativas según el contrato, y volver a probar el SHA fusionado.

## Validación de esta entrega

- Harness real: **31 escenarios PASS, cero FAIL**, resultados exactos en el JSON; estado PARTIAL por
  las fronteras descritas, no por una regresión de los servicios.
- `npm run build:all` del snapshot de master: PASS.
- `npm test -- apps/promotions-svc --maxWorkers=1`: 373 PASS.
- `npm run test:e2e -- apps/promotions-svc/test/app.e2e-spec.ts apps/promotions-svc/test/local-demo.e2e-spec.ts --maxWorkers=1`: 11 PASS.
- `npm run typecheck`: PASS.
- `npm run lint`, Prettier de los cinco scripts y `git diff --check`: PASS.
- CI del nuevo harness: se registra por SHA en la PR de entrega; no se infiere
  del verde de PR #159.

Durante la preparación se corrigieron incidencias del entorno/harness (motor
Docker detenido, acceso del driver a red interna, permisos temporales del owner
de migraciones y carga ESM en Windows). Vitest inicialmente no pudo cargar suites
por EPERM del temporal del sandbox; la ejecución normal pasó. Un filtro E2E inicial
apuntaba a archivos inexistentes y se corrigió a las dos suites reales. Ninguna
corrección modificó código, permisos runtime ni SQL histórico de otro servicio.
