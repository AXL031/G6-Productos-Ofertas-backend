> **DOCUMENTO HISTÓRICO — NO REPRESENTA EL ESTADO ACTUAL.** Resultado fechado 2026-10-16; consultar [paquete H4 vigente](../../integraciones/g1-marketplace/README.md). Conservar la evidencia pasada, no asociarla a ramas/SHAs posteriores.

# INT-ASAP G1 — resultado local, 2026-10-16

## Rama, alcance y coordinación

Rama personal `castilla`, HEAD
`7b15faeb421e7a54bfbf3e8250d6718023dcc3bb`, snapshot de implementación antes del commit.
Issues #19/#21/#22/#23/#26; BACK #34/#35/#37 y #43/#44/#46 cubiertos
solo en el corte mínimo de lectura. No se declaran terminados esos BACK completos.

La autorización temporal de Marco y los tres comentarios preparados para
#19/#22/#23 constan en [INT-ASAP-INTERVENCION.md](INT-ASAP-INTERVENCION.md).
Son borradores locales, no comentarios publicados ni aceptación de López/Poma.
Sus ramas y ownership permanente permanecen intactos.

- PR #18 OPEN, `lopez` `4c1214862d106b66f9892bfc72e14450a6b31406`:
  incorporación exclusiva de la aplicación Taxonomy, sin DATA-001.
- PR #116 OPEN/DRAFT, `cueva`
  `98ad846a0046586cfe17cde5a2f9be8f101d8cb9`: aplicación Gateway exacta,
  verificada por blobs de sus 30 archivos, sin incorporar Promotions.
- PR #117 OPEN, head `castilla` igual al HEAD indicado: sin commit/push en el corte inicial,
  no se había agregado esta intervención al PR. Marco autorizó después commit y push a castilla para auditoría, aceptando la actualización de #117. La restricción inicial de
  aislamiento queda sustituida por esa instrucción posterior.
- `origin/poma` no contiene aplicación Catalog. Se extendió el scaffold oficial
  existente, sin crear otra aplicación.

## Estado por componente

| Componente | Operativo           | Implementación y prueba                                                                                                        | Integración HTTP                                                                                | Homologado / desplegado |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------- |
| Taxonomy   | IMPLEMENTAR_AHORA   | IMPLEMENTADO y PROBADO_LOCAL: provider PostgreSQL, categorías y marcas ACTIVO, TLS, identidad y cierre de pool                 | INTEGRADO_HTTP local con Gateway e issuer de prueba firmado                                     | No / no                 |
| Catalog    | IMPLEMENTAR_PARCIAL | IMPLEMENTADO parcial y PROBADO_LOCAL: conexión, consultas internas parametrizadas, filtros propios, paginación/orden y mapping | Rutas conectadas; 503 contractual por elegibilidad pendiente. No hay GET comercial exitoso real | No / no                 |
| Gateway    | IMPLEMENTAR_PARCIAL | Implementación reutilizada sin alterar JWT/RS256/scopes/allowlists; pruebas locales PASS                                       | Taxonomy real y bloqueo Catalog propagado; negativos firmados PASS                              | No / no                 |

## Operaciones y SQL acreditados

- `GET /api/v1/categorias`: 200 real a través del Gateway. La respuesta proviene
  de PostgreSQL por Nest → repositorio → Drizzle → pg.Pool, filtrando exclusivamente
  `taxonomy.categories.estado = ACTIVO`. Puede ser una lista vacía.
- `GET /api/v1/marcas`: mismo recorrido real y estado exacto ACTIVO; no se convierte
  PENDING_DEACTIVATION en ACTIVA.
- `GET /api/v1/productos?canal=MARKETPLACE&q=...` y
  `GET /api/v1/productos/por-slug/{slug}?canal=MARKETPLACE`: 503
  SERVICIO_NO_DISPONIBLE real a través del Gateway. El puerto interno de
  elegibilidad falla cerrado antes de consultar/exponer candidatos.
- Consultas internas Catalog: COUNT/SELECT de productos ACTIVO, texto parametrizado,
  categoría/marca como referencias opacas, estado sin ampliación de visibilidad,
  NOMBRE_ASC/NOMBRE_DESC con desempate por ID, LIMIT/OFFSET y snapshot repeatable
  read/read only. La selección autoritativa se aplica antes de COUNT/paginación.
- SELECT reales acreditados sobre products, variants, product_images,
  variant_images, product_attribute_values y variant_attribute_values propios.
  Consulta por slug inexistente y selección de elegibilidad vacía: PASS.
- **Se observaron cero productos ACTIVO.** No se ejecutó una respuesta positiva
  de detalle real, ni composición positiva de variantes reales. Mapping simple/
  variantes, SKU con ceros iniciales, proyección, 200 y 404 se probaron además
  con fixtures aisladas, que no son evidencia PostgreSQL comercial.
- Marca y validación de filtros maestros usan HTTP Taxonomy. Sus pruebas aisladas
  acreditan frontera, proyección y fallos; el detalle comercial real todavía no
  puede ejercer esa composición. No existe JOIN cross-schema.
- Credenciales usadas directamente desde los dos archivos externos privados;
  sin copia/modificación, grants ni escrituras compartidas. Identidad/schema
  y ausencia de privilegios administrativos/owner comprobadas por SELECT.

Las evidencias anteriores de aislamiento y TLS negativo se reutilizaron comprobando
que su hash coincide con el probe actual; no se presentan como una nueva ejecución.
Ver [evidencia previa](POSTGRES-RUNTIME-2026-10-16.md).

## Validaciones

| Validación ejecutada                                       | Resultado                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Unitarias generales, Vitest, un worker                     | PASS: 151                                                                                              |
| HTTP generales, Vitest e2e, un worker                      | PASS: 310; 9 casos runtime optativos omitidos en esa ejecución                                         |
| Nuevas pruebas PostgreSQL Taxonomy                         | PASS: 2, ejecución explícita real                                                                      |
| Nuevas pruebas PostgreSQL Catalog                          | PASS: 4, ejecución explícita real; positivo de detalle no ejercido por falta de activos                |
| Gateway → procesos compilados → PostgreSQL                 | PASS: 4 casos integrados locales, incluye 15 rechazos de seguridad en los tres GET y caída de Taxonomy |
| Configuración/lifecycle después del ajuste de logging idle | PASS: 44 pruebas enfocadas                                                                             |
| Typecheck: tsc --build --noEmit                            | PASS                                                                                                   |
| Lint: oxlint apps/                                         | PASS                                                                                                   |
| Formato: Prettier apps/**/*.ts                             | PASS                                                                                                   |
| Build oficial equivalente a build:all: tsc --build         | PASS, nueve aplicaciones                                                                               |
| Sonda readiness existente Gateway                          | PASS con proveedores HTTP aislados; no acredita readiness comercial real                               |
| CLI readiness Taxonomy                                     | PASS: ready/database ready                                                                             |
| CLI readiness Catalog                                      | Cierre correcto, exit 1: not_ready/database ready/eligibility unverified                               |
| Smoke marketplace.live.mjs existente                       | NO EJECUTADO: faltan configuración/fixture elegible; el script lo informa sin atribuir PASS            |
| Escaneo de secretos y comparación exacta Gateway #116      | PASS, sin emitir secretos                                                                              |
| git diff --check                                           | PASS                                                                                                   |
| npm ci / instalación reproducible                          | PASS: 402 paquetes instalados con lock en carpeta temporal; node_modules original conservado           |
| G1 BFF real, G7 efectivo, homologación, despliegue         | NO EJECUTADO                                                                                           |

El fallo inicial de una subconsulta EXISTS se corrigió y su repetición real pasó.
Un error de sintaxis inicial del harness Windows también fue corregido antes
del PASS integrado. No quedan FAIL técnicos conocidos en las comprobaciones ejecutadas.

Evidencias nuevas:

- [Taxonomy real](../taxonomy-svc/test/evidence/postgres-readonly-2026-10-16.json).
- [Catalog real](../catalog-svc/test/evidence/postgres-readonly-2026-10-16.json).
- [HTTP integrado parcial](test/evidence/marketplace-postgres-partial-2026-10-16.json).
- [Manifiesto de fuentes y hashes](test/evidence/intervention-manifest-2026-10-16.json):
  identifica HEAD sin commit, fuentes, contrato y versiones locales; no equivale
  a un commit publicado ni a integración G1.

## Configuración y reproducción

Usar Node soportado. Se verificó Node 24.19.0 del runtime local, pg 8.23.1,
Drizzle 0.45.4 y tipos pg 8.23.1 instalados. Node global 24.3.0 no cumple
el engines del monorepo. No se alteró la instalación global.

Variables obligatorias de cada servicio: PGHOST, PGPORT, PGDATABASE, PGUSER,
PGPASSWORD, PGSSLMODE=verify-full, PGSSLROOTCERT (ruta absoluta a CA),
G6_DATABASE_SCHEMA, G6_EXPECTED_ROLE y G6_CONNECTION_MODE (session/direct).
Se conserva la distinción G6_CONNECT_HOST para transporte / PGHOST para TLS.
Roles permitidos: dev_login propio o app propio, sin identidad admin/owner.

Puertos opcionales: TAXONOMY_SVC_PORT / CATALOG_SVC_PORT. Ambos procesos nuevos
escuchan exclusivamente loopback. CATALOG_TAXONOMY_URL configura el origen HTTP
interno del owner, sin path/credenciales. No agrega un contrato HTTP.

Desde la raíz Backend, con el Node soportado primero en PATH:

```powershell
node node_modules/typescript/bin/tsc --build
$env:G6_READONLY_INTEGRATION='taxonomy'
node --env-file="C:\Users\marec\Desktop\G6-PostgresRuntime-Privado\taxonomy\.env.local" node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts apps/taxonomy-svc/test/postgres.readonly.e2e-spec.ts --maxWorkers=1
$env:G6_READONLY_INTEGRATION='catalog'
node --env-file="C:\Users\marec\Desktop\G6-PostgresRuntime-Privado\catalog\.env.local" node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts apps/catalog-svc/test/postgres.readonly.e2e-spec.ts --maxWorkers=1
$env:G6_HTTP_POSTGRES_INTEGRATION='1'
node node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts apps/api-gateway/test/marketplace.postgres.e2e-spec.ts --maxWorkers=1
node apps/api-gateway/test/verify-intervention.mjs
```

El harness levanta Taxonomy/Catalog compilados con archivos externos, Gateway con
las variables existentes GATEWAY_TAXONOMY_SVC_URL/GATEWAY_CATALOG_SVC_URL, y usa la
fuente de claves firmada de prueba del propio PR #116. Conserva verificación de
firma/issuer/expiración/audiencia/scopes/allowlist. Cierra procesos y pools al
terminar. No crea credenciales G7 ni listeners públicos.

Readiness es CLI interna, sin inventar rutas HTTP. /health conserva liveness.
Gateway sigue reportando upstreams unverified cuando no tienen ruta readiness
HTTP acreditada; no se configura /health como sustituto.

## Bloqueos específicos y entrega a owners

| Owner                                             | Operación afectada                              | Desbloqueo verificable                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marco/Poma, coordinación G6                       | Los dos GET comerciales Catalog                 | Aprobar D-CAT-05/06: fuente, persistencia/default y regla autoritativa por canal; implementar el adaptador del puerto y demostrar positivos/negativos |
| Marco/Poma DATA #12, López DATA #11 según fixture | Positivo real simple/variantes y smoke completo | Fixtures válidas y elegibles existentes. Cualquier carga compartida exige autorización separada; esta intervención no escribe                         |

| Poma/Vera/Pricing y coordinación funcional | precioMin/precioMax | Semántica product-level y frontera Pricing aprobadas, implementadas y probadas. Actualmente 503, nunca filtro ignorado |
| G7/G1/G6 | E2E externo del BFF | Identidad/grant efectivos, entorno/version acordados, conformidad bilateral y requests reproducibles desde G1 |

López deberá absorber configuración/provider/schema de lectura, lifecycle,
readiness interna, ajuste defensivo de estado pendiente y pruebas de Taxonomy.
Poma deberá absorber la infraestructura y consultas Catalog, tipos comerciales,
frontera HTTP Taxonomy, puerto de elegibilidad y pruebas, conservando la regla
pendiente aislada. Cueva no necesita absorber alteraciones al Gateway original:
solo se añade un harness de integración y evidencia de coordinación.

Archivos cambiados en package.json/package-lock.json (autorizados) y apps/taxonomy-svc, apps/catalog-svc y
apps/api-gateway. Las fuentes exactas y su inventario están en el manifiesto;
se distingue código incorporado de #18/#116 de los adaptadores nuevos. Sin
modificar contratos, migraciones, frontend, permisos, scripts DATA ni ops.
Publicación de commits y push a castilla autorizada posteriormente por Marco para auditoría. Esta instrucción sustituye el aislamiento inicial de #117: el PR existente recibirá los commits por compartir rama. No se crean ramas ni PR nuevos, no se hace merge ni despliegue. Los hashes del manifiesto identifican el snapshot previo al commit.

**Estado final: PARTIAL.** El siguiente paso funcional es aprobar la política
de elegibilidad y disponer de fixtures. Después se puede ejecutar el smoke
completo; E2E G1 requiere además su BFF y la identidad técnica efectiva.

## Actualización: dependencias y publicación autorizadas

Marco autorizó package.json/package-lock.json para pg 8.23.1, drizzle-orm 0.45.4
(runtime) y @types/pg 8.23.1 (desarrollo). Las versiones previamente fijadas
conservan version/resolved/integrity; no hubo actualización ajena al alcance.

Con la instalación limpia pasaron 145 pruebas unitarias enfocadas y 304 HTTP
(10 optativas omitidas en esa ejecución), typecheck, lint, formato y build de las
nueve aplicaciones. Se ejecutaron además explícitamente las 2 pruebas PostgreSQL
Taxonomy, 4 Catalog y 4 Gateway→servicios compilados→PostgreSQL desde esa misma
copia limpia, usando los archivos externos originales sin copiarlos. Persiste
el aviso previo de peer opcional tsconfck/TypeScript; no impidió instalación ni
validaciones. La fuente TypeScript y el lock de la copia coinciden por hash.

[Evidencia de instalación limpia](test/evidence/dependencies-clean-2026-10-16.json).
Esta dependencia queda resuelta; D-CAT-05/06, fixtures y E2E G1 siguen separados.
Los artefactos locales preexistentes de smoke/runtime se incorporan sin cambios
para que la auditoría publicada conserve sus referencias y evidencia histórica.

> **DOCUMENTO HISTÓRICO — NO REPRESENTA EL ESTADO ACTUAL.** Resultado local fechado 2026-10-16. Se conserva como evidencia histórica; el estado operativo se consulta en [`integraciones/g1-marketplace/`](../../integraciones/g1-marketplace/README.md), con SHA vigente por rama. Ninguna fila de este corte histórico certifica un SHA posterior.
