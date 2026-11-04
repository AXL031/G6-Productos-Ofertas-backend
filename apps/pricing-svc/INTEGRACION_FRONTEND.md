# Integración de Pricing MK-013 — 2026-10-17

Estado: **PARTIAL**. Implementación interna y adaptador preparados; el recorrido
React → cliente compartido → Gateway → Pricing → PostgreSQL no está acreditado.
No se habilitan escrituras con un payload Outbox inventado.

## Git y fuentes

| Repositorio | Rama | SHA inicial | Base de los commits de entrega |
|---|---|---|---|
| Backend | vera | 3071a1a5687f4bdcf78cc7e561aa91e4e2550483 | 2970df90babf2c8caa1849b179b02918fc74a005 |
| Frontend | vera | 97bdd1631238943d783e6effabb0cad9efc9ff1b | 97bdd1631238943d783e6effabb0cad9efc9ff1b |
| Docs oficial | master, solo lectura | c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b | sin modificaciones |

Backend `vera` se adelantó a `origin/master` con autorización explícita del
solicitante, sin merge conflictivo. Los cinco archivos de trabajo se respaldaron
en stash `697bb9db73341dab61115ada5ab6593e98e480d7`, se restauraron y se verificaron
sus hashes SHA-256. Se conserva ese respaldo. `cueva@edd655d` permanece conservada.
La actualización del lockfile de Backend procede de master; no es una decisión
nueva sobre dependencias de Pricing.

Fuentes leídas: OpenAPI 0.6.0-rc.1, blob
`f64bfe9a097b2a0f74c2600988305443d92f640e`; AsyncAPI 0.6.0-rc.2;
SPEC/HU/FLOW-013; registro DEC-F, matriz de trazabilidad y matriz intermodular;
`apps/pricing-svc/AUDIT-OPEN-ISSUES.md`; Frontend
`docs/COORDINACION_PRICING_API.md`; puerto/repositorio, runtime y páginas Pricing;
controladores, guard, casos de uso, persistencia y rutas contractuales de Gateway.
SPEC/HU/FLOW, AsyncAPI y las tres matrices/registro locales coinciden por hash
con los blobs del SHA oficial citado. Aplican DEC-F-001/006/009/012.

Issues consultados: Backend #24/#55/#56/#59/#109 y Frontend #38/#45. Su cierre
administrativo no se interpreta como implementación. Frontend tiene la
[PR #47 existente](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/pull/47),
anterior a esta entrega. El solicitante autorizó publicar los avances en `vera`
y pidió repetir primero Docker. Esa comprobación posterior pasó: Docker 29.0.1,
PostgreSQL 16.15 y 37 pruebas aprobadas sin omisiones. Se publica una entrega
parcial; no se declara completado React→Gateway ni se fusiona a master.

## Cambios de esta entrega

- `src/http/pricing-reads.ts`: valida escala, rango y viaje decimal antes de
  convertir precios/programaciones a JSON number; mantiene null y versiones.
- `src/http/pricing-reads.spec.ts`: límites de dinero, precisión y desborde.
- `src/http/pricing-write.dto.ts`: parsers internos de PrecioUpdateRequest y
  ProgramacionPrecioRequest compatibles con los casos de uso existentes. PATCH
  conserva priceVersion; POST no inventa versión. No construyen actor ni PriceFact
  y no registran rutas HTTP. La versión cero admitida por OpenAPI se conserva
  para que el caso de uso decida el conflicto; no se redondean importes.
- `src/http/pricing-write.dto.spec.ts`: contratos internos y conexión de tipos
  con PricingMutations, null, motivo, moneda, fechas y validación de dominio.
- `test/blocked-writes.e2e-spec.ts`: seis operaciones sin handler continúan
  sin alcanzar mutaciones ni transacciones. Usa dobles explícitos del provider,
  no demuestra ausencia de cambios en una base viva.
- `test/evidence/frontend-gateway-diagnostic-2026-10-17.json`: diagnóstico local
  real Gateway→Pricing, sin JWT y con DB de prueba deliberadamente inaccesible.
- `test/evidence/frontend-gateway-postgres-read-2026-10-17.json`: comprobación
  posterior de lectura real 200 desde Gateway con PostgreSQL 16.15 aislado,
  fixture persistida y relectura por rol runtime; sin cliente React compartido.
- Este informe. No se editaron Gateway, Compose, CI/CD, contratos ni otros servicios.

## Las 13 operaciones

| operationId | Código Backend | Disponibilidad real / bloqueo |
|---|---|---|
| consultarPrecios | Sin handler | BLOCKED_CONTRACT: contexto autoritativo de Catálogo |
| obtenerPrecioSku | Resolver puro existente; sin handler | BLOCKED_CONTRACT: contexto SKU/estado/elegibilidad |
| actualizarPrecioSku | Mutación transaccional existente; DTO preparado | BLOCKED_CONTRACT: P-PRI-02, handler y autorización de escritura |
| listarProgramacionesPrecioSku | IMPLEMENTADO, existente | PROBADO en PostgreSQL aislado; React PENDIENTE_INTEGRACION |
| programarPrecioSku | Caso de uso existente; DTO preparado | BLOCKED_CONTRACT: P-PRI-02, handler y autorización de escritura |
| prevalidarImportacionPrecios | Sin parser productivo ni handler | BLOCKED_CONTRACT: P-PRI-01; frontend no envía archivos |
| crearImportacionPrecios | Sin handler ni método en el puerto frontend | BLOCKED_CONTRACT: P-PRI-01/02 |
| obtenerImportacionPrecios | IMPLEMENTADO, existente | PROBADO en PostgreSQL aislado; React PENDIENTE_INTEGRACION |
| descargarReporteImportacionPrecios | Sin handler | BLOCKED_CONTRACT: P-PRI-01; cliente solo acepta CSV recibido por HTTP |
| obtenerPrecioBaseProducto | IMPLEMENTADO, existente; serialización reforzada | PROBADO 200 por Gateway→Pricing→PostgreSQL aislado; React PENDIENTE_INTEGRACION |
| actualizarPrecioBaseProducto | Mutación transaccional existente; DTO preparado | BLOCKED_CONTRACT: P-PRI-02, handler y autorización de escritura |
| listarProgramacionesPrecioProducto | IMPLEMENTADO, existente | PROBADO en PostgreSQL aislado; React PENDIENTE_INTEGRACION |
| programarPrecioBaseProducto | Caso de uso existente; DTO preparado | BLOCKED_CONTRACT: P-PRI-02, handler y autorización de escritura |

Los cuatro handlers existentes no son nueve handlers nuevos. Las pruebas de DTO
y cliente no demuestran disponibilidad del endpoint. Ninguna escritura se
expone como operativa. CAS, locks, snapshots, cierre de vigencias, canales,
rollback y Outbox transaccional existentes no se modificaron.

## Dependencias concretas

| Owner | Archivo/frontera y operaciones | Fuente y condición verificable de desbloqueo |
|---|---|---|
| Poma/Catálogo + Marco/arquitectura | Contexto de consulta SKU y selección frontend; consultarPrecios/obtenerPrecioSku/histórico | SPEC-013 §§2/4, DEC-F-001/006, OpenAPI y AUDIT-OPEN-ISSUES: provider autoritativo ejecutable que entregue identidad, estado y elegibilidad por SKU; búsqueda textual no lo sustituye |
| Marco/arquitectura + Vera y consumidores del evento | pricing-mutations.ts, las cuatro escrituras individuales/programadas | P-PRI-02 del encargo/AUDIT; AsyncAPI PricingPriceChanged todavía referencia GenericData: publicar payload aprobado y constructor del hecho, conservar atomicidad y acreditar autorización contractual |
| Marco/arquitectura + Vera | Prevalidación, admisión y reporte de importación | P-PRI-01/02 del encargo/AUDIT y OpenAPI: publicar formato/cabeceras, política de admisión/reporte y payload; no inferirlos de JSON genérico |
| Castilla, Frontend #45 / Backend #109 | src/main.tsx, src/app/config/**, transporte compartido y AuditRuntimeContext | Inyectar cliente común y provider autoritativo en createPricingRuntime("api", {api}), componer hybrid y Audit mock explícito; verificar React→Gateway real |
| Vera + Catálogo/arquitectura | Retail y contrato decimal | Coordinar channelId de escritura con Canal de lectura y escala numeric(12,2). OpenAPI no publica escala máxima; rechazar precisión no soportada y no modificar su formato unilateralmente |
| Operador del entorno local | IsolatedPostgres.start, pruebas PostgreSQL | RESUELTO antes del push: Docker 29.0.1, PostgreSQL 16.15 y 37 pruebas PASS sin omisiones |

## Pruebas y entorno

Backend final: Node 24.19.0, npm 11.6.2, Vitest 4.1.11. Frontend:
Node 22.22.3 para las validaciones finales, Vitest 5.0.5 y Chromium/Playwright
con un único worker y viewport 1440×900. Los primeros npm ci con el Node global
24.11.1 emitieron avisos de engines; se usaron runtimes compatibles para las
validaciones finales. Backend se reinstaló con Node 24.19.0 al integrar master.

| Comando | Resultado de esta ejecución |
|---|---|
| npm ci | PASS con lockfile de master y Node 24.19.0 |
| npm test -- apps/pricing-svc | PASS: 214 |
| npm test | Sobre master: 548 PASS y 1 FAIL por timeout en Taxonomía |
| npm test -- --maxWorkers=1 --no-file-parallelism | PASS: 549, sin omisiones ni cambios en Taxonomía |
| npm run typecheck | PASS |
| npm run lint | PASS |
| npm run format:check | PASS |
| npm run build:pricing-svc | PASS |
| npm run build:api-gateway | PASS; fuentes compartidas intactas |
| PRICING_TEST_POSTGRES=1 npm run test:e2e -- apps/pricing-svc --reporter=verbose | Reejecución final PASS: 37, sin omisiones, PostgreSQL 16.15 real |
| TypeScript estricto incluyendo tests | PASS tras tipar retornos de DTO; primera pasada detectó widening de enums |
| git diff --check | PASS |

Los fallos previos no se silencian. El comando estricto adicional fue:

```powershell
$pricingSources = @(rg --files apps/pricing-svc -g '*.ts')
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --experimentalDecorators --emitDecoratorMetadata --esModuleInterop --skipLibCheck --types node,vitest/globals @pricingSources
```

La ejecución obligatoria
`$env:PRICING_TEST_POSTGRES='1'; npm run test:e2e -- apps/pricing-svc --reporter=verbose`
en su primer intento terminó **FAIL**: 10 pruebas provider aprobadas, suite PostgreSQL fallida al
agotar 60 s en docker run; 27 casos no ejecutados por el fallo de beforeAll.
No se añadió skip ni se usó Supabase para evitar ese fallo. El log de Docker
identificó el error local al inicializar Secrets Engine y retirar
`AppData/Local/docker-secrets-engine/engine.sock`. No se reseteó Docker ni se
modificaron sus datos.

Después de que el solicitante abrió Docker, se repitió el mismo comando antes
de publicar: **37 PASS, cero omisiones**. El bloqueo del entorno queda resuelto;
el fallo previo se conserva únicamente como antecedente de esta ejecución.

El diagnóstico Gateway/Pricing compilados usó loopback y puertos efímeros,
demo explícita y un puerto PostgreSQL inaccesible. Pricing readiness dio 503;
el provider real de readiness de Gateway dio not_ready; el GET de precio vía
Gateway respondió 503 SERVICIO_NO_DISPONIBLE sanitizado. Se usó el identificador
de prueba `pricing-diagnostic`, que no representa un producto existente. La
ruta contractual es GET /api/v1/precios/productos/{productoId}; no se verificó
ningún producto local real. Ese diagnóstico negativo no acredita funcionalidad
de consulta ni disponibilidad real del endpoint. Los puertos habituales
3000/3002 no tenían listeners al comprobarlos después. Gateway no publica
GET /health/ready: su readiness es provider/CLI documentado. Se cerraron ambas
aplicaciones al terminar. Esto acredita propagación de fallo, no persistencia.

La comprobación posterior con Docker disponible sí persistió una fixture
exclusiva de Pricing en PostgreSQL aislado mediante el rol runtime y consultó
su ID existente por Gateway. Pricing readiness fue 200, Gateway readiness
fue ready para Pricing y GET respondió 200 con 99.99 PEN, oferta null y versión
1; la relectura de la base devolvió 99.99. Se conservó la evidencia separada
`frontend-gateway-postgres-read-2026-10-17.json`. El producto es una fixture
del harness, no un producto comercial publicado en Catálogo. Se cerraron los
procesos y eliminó exclusivamente el contenedor efímero creado por el harness.
No intervino React ni el cliente compartido de Castilla.

## Estado independiente de integración

| Comprobación | Estado |
|---|---|
| Backend interno | IMPLEMENTAR_PARCIAL; dinero/DTO y pruebas preparados |
| Backend con PostgreSQL real en esta ejecución | PROBADO: 37 pruebas, sin omisiones |
| Gateway conectado localmente a Pricing | PROBADO: GET 200 con fixture persistida y readiness; también fallo 503 |
| Adaptador HTTP | IMPLEMENTADO y PROBADO con transporte/respuestas de prueba |
| React conectado al Gateway real | PENDIENTE_INTEGRACION: Castilla/Catálogo |
| Flujo E2E real completo | BLOCKED; no sustituido por el harness de UI |
| Modo híbrido global | PENDIENTE_INTEGRACION: Castilla #45 |
| Homologación externa / integración autenticada real | NO ACREDITADAS; se conserva el modo autenticado existente |
| Oracle | NO EJECUTADO |
| Vercel | NO EJECUTADO |

No se cierran issues, se fusionan PR ni se atribuye aceptación externa.

> **Actualización normativa G1 H4 (2026-10-20):** G6 aceptó y comunicó M-01–M-09. Este informe conserva sus mediciones históricas; el estado vigente por operación está en la [matriz H4](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/castilla/integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md) y el [acuerdo G1–G6](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/docs/g1-marketplace-homologacion-lote03/integraciones/ACUERDO_G1_G6_H4_2026-10-20.md).

`obtenerPrecioSku` (`GET /api/v1/precios/skus/{sku}`) sigue siendo una brecha específica en HEAD `48afbf7a6845db4aaba6b58eb336396fa0e85ea7`: OpenAPI lo define, pero el controller observado no tiene handler individual `GET skus/:sku`. Se necesita fuente autoritativa de Catalog para asociar identidad/elegibilidad SKU↔producto, y semántica contractual de canal, vigencia efectiva y composición base/oferta. No inferir SKU ni precio padre; no convertir resultados del adapter, datos mock o ruta `/productos/{productoId}` en provider de `/skus/{sku}`. Este SHA no tiene check-runs CI asociados en la consulta; no reutilizar CI anterior como evidencia.

No se declara deploy, autorización G7 ni React→Gateway→Pricing→PostgreSQL real por estos ensayos. El corte previo y sus resultados se conservan como evidencia temporal, no como estado actual.
