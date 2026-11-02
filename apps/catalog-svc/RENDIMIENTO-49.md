# #49 — Preview agrupado de Marketplace

Base: `poma@6278b6867b5a87f5351f88b717798e0a0893ad5a`.
Contrato consultado: Docs `master@599c34f4e677c8792532e2cc31ac372473a10710`,
OpenAPI 0.6.0-rc.1, AsyncAPI 0.6.0-rc.3; SPEC-003/004,
DEC-F-001/002/006/009/011/012 y paquete operativo G1 H4.

## Cambio y equivalencia

`listDemoCandidates` mantenía una consulta de candidatos, una consulta de
imágenes por producto, otra de variantes por producto sin imagen propia válida,
y otra de atributos por producto con imagen válida. Ahora usa candidatos,
imágenes propias agrupadas por IDs, fallback agrupado solo para IDs sin imagen
propia válida, y atributos agrupados. Máximo cuatro SELECT, tres sin fallback,
uno si no hay candidatos; BEGIN/COMMIT no incluidos en ese recuento.

Se reutiliza la agrupación de atributos de `listCandidates`; las galerías
mantienen políticas separadas. Preview conserva principal DESC/posición/ID,
fallback posición/ID de imagen/ID de variante, duplicados y galerías sin límite
de 100. El modo interno read-demo conserva su política previa. No cambia el
predicado comercial ni la paginación SQL del modo normal.

Los filtros y maxCandidates+1 permanecen en la primera consulta. El snapshot
sigue siendo repeatable read/read only. Pricing conserva cuatro workers y el
descarte previo al total/paginación; no se modifica su cliente ni su servicio.

`CatalogTelemetry.measure` registra duración transcurrida, etapa y éxito,
también ante fallo, mediante SanitizedLogger. Etapas: DEMO_CANDIDATES_SQL,
DEMO_ENRICHMENT_SQL, DEMO_PRICING y DEMO_LIST_TOTAL. Pricing mide el tiempo del
conjunto concurrente, no la suma de latencias individuales. No se registran
consultas, cuerpos, URLs ni errores privados.

## Evidencia local y reproducción

Antes de editar producción se ejecutó `demo-list-equivalence.spec.ts`:
11 PASS contra el método anterior. La misma fixture y aserciones completas
se conservan: páginas 1/2 de 4/24, ASC/DESC, imágenes, atributos, ausencia de
imagen/precio, vacío, límite, filtros parametrizados y fallos DB/Pricing.

| Driver controlado (no PostgreSQL) | Antes | Después |
|---|---:|---:|
| SELECT, 4 candidatos | 10 | 4 |
| SELECT, 36 candidatos | 79 | 4 |
| Respuestas completas de las ocho páginas | baseline | equivalentes |

Comandos ejecutados durante esta fase:

- `npm test -- --maxWorkers=2 apps/catalog-svc`: 390 PASS.
- `npm run test:e2e -- --maxWorkers=2 apps/catalog-svc`: 111 PASS, 45 SKIP.
- `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run build:catalog-svc`, `git diff --check`: PASS.
- TypeScript explícito de los archivos E2E y helper legacy: PASS.

Vitest requiere TEMP/TMP en directorio escribible y permisos para HTTP local;
los fallos iniciales EPERM del sandbox no son fallos de la aplicación.
Docker no está disponible localmente. Los SKIP no acreditan persistencia/broker.

La prueba `PERF-49` de `postgres.persistence.e2e-spec.ts` ejecuta la referencia
congelada en `test/support/legacy-demo-list.ts` y la versión nueva contra los
mismos 36 productos PostgreSQL desechables. Compara respuestas completas,
filtros, desempates, galerías repetidas >100, placeholders, atributos y límite.
Emite JSON con consultas, duración SQL, Pricing y total por página de 4/24.
Pricing es una fixture explícita de 2 ms por llamada: no acredita su latencia
real ni autenticación. Ejecutar con Docker/OpenSSL mediante el script E2E
existente, también ejecutado por CI. Resultados remotos se registrarán en el PR.

## Límites

Sin benchmark Oracle nuevo ni Pricing real: presupuesto G1 de 7 segundos
NO VERIFICADO. Los 12,379/12,261/12,808 s del issue son históricos del SHA
9205eb4, no resultados de este cambio. No se puede concluir si Pricing sigue
siendo el cuello de botella hasta medir las cuatro etapas en el entorno real.
Owner Poma/Marco: ejecutar medición autorizada sobre el SHA desplegado, con el
mismo dataset y condiciones. Esto afecta validación de latencia/despliegue,
no la implementación local. No se hicieron cambios de base compartida,
autenticación, contratos, otras apps, infraestructura, merge ni despliegue.

## Revisión posterior del PR #125 — listado comercial normal

Base de esta corrección: `a3cade1ede7ad10534623af67b60a0c7ca2420a7`.
El usuario priorizó explícitamente el listado normal tras la auditoría y pidió
identificar el resto sin ampliar innecesariamente #49. Ownership: Poma,
únicamente apps/catalog-svc; operación listarProductos, contrato/decisiones
citados arriba. Estado de implementación de este alcance: IMPLEMENTAR_AHORA.

`listCandidates(readDemo=false)` todavía ejecutaba COUNT + página + dos SELECT
por producto devuelto. Ahora comparte las lecturas agrupadas de imágenes propias
y atributos por los IDs de la página, reutilizando groupedAttributes. No consulta
las imágenes de variantes en el modo normal. Conserva imágenes propias sin
filtrarlas, reordenarlas por principal, deduplicarlas ni aplicar fallback: esas
políticas siguen separadas de ambos modos demo.

| SELECT por listado normal (sin BEGIN/COMMIT) | Antes | Después |
|---|---:|---:|
| Página con 4 productos | 10 | 4 |
| Página con 24 productos | 50 | 4 |
| Página vacía, incluso fuera de rango con total positivo | 2 | 2 |

COUNT y página mantienen el predicado comercial ACTIVO/EXISTS de variante
ACTIVA, q literal, categoría/marca, IDs filtrados por precio, orden nombre/ID,
LIMIT/OFFSET y total en el mismo snapshot repeatable read/read only. Las
consultas administrativas de estado conservan su predicado. El modo read-demo
interno conserva su fallback/deduplicación y cinco SELECT para página no vacía;
el preview Marketplace optimizado conserva su método independiente.

Baseline ejecutada antes de cambiar producción: 13 pruebas PASS en
commercial-list-equivalence.spec.ts. Las mismas proyecciones completas se
comparan después para páginas 1/2, tamaños 4/24 y ASC/DESC; incluye colecciones
vacías, placeholders/URLs repetidas conservados, valores JSON, parámetros SQL,
IDs monetarios, total fuera de rango y rollback de fallos. Solo el presupuesto
de SELECT cambia de 2+2*N a cuatro. Driver controlado, no PostgreSQL real.

PERF-49-COMMERCIAL añade a la suite PostgreSQL desechable 30 productos activos
con preparación real local, 48 combinaciones de página/orden/filtros y una
restricción de IDs. Compara la página completa con las proyecciones del lector
de detalle no modificado y cuenta cuatro SELECT (dos en páginas vacías).
Taxonomy y los resultados de preparación son fixtures explícitas; esta prueba
no acredita integración autenticada externa ni latencia HTTP de producción.
Docker no está disponible localmente: su ejecución real y el SHA/resultado de CI
se registran en el PR; SKIP local no es PASS PostgreSQL.

Validación local de esta revisión: `npm test -- --maxWorkers=2 apps/catalog-svc`,
416 PASS; `npm run test:e2e -- --maxWorkers=2 apps/catalog-svc`, 111 PASS / 47 SKIP.
Typecheck, lint, format:check, build:catalog-svc, tipos explícitos de E2E y
git diff --check ejecutados correctamente. CI del nuevo commit se informa en el
PR por SHA, sin reutilizar como propia la CI anterior de a3cade1.

## N+1 restantes confirmados y prioridad para Hito 4

| Flujo | Sobrecosto confirmado | Impacto / siguiente paso | Estado |
|---|---|---|---|
| listDemoCandidates | Hasta cuatro SELECT por conjunto; corrección previa verificada | Preview público de listado; no confundir con Pricing ni otros lectores | Corregido previamente |
| listCandidates normal | Antes dos SELECT por producto; ahora cuatro SELECT por página no vacía | Listado comercial autenticado de canales; prioridad de esta revisión | Corregido ahora |
| demoPrices | N GET de Pricing por producto candidato, cuatro workers, antes de paginar | Alta prioridad de medición H4: sigue pudiendo dominar el preview. Medir DEMO_PRICING real por SHA antes de decidir un lote. Poma/Vera deben confirmar equivalencia de precio por producto frente a los contratos batch por SKU; no sustituirla por inferencia ni crear endpoints | Pendiente; sin cambio de cliente, concurrencia o semántica |
| findCandidateBySlug / findCandidateByProductId; también detalle preview por slug | Dos SELECT por variante para atributos e imágenes, además del costo fijo del detalle | Ficha/galería H4: priorizar con cardinalidad real de variantes y latencia de detalle; agrupar por IDs preservando estados, orden y separación de atributos identificadores | Pendiente identificado; sin cambios en esta revisión |
| adminVariants | Tres SELECT por variante: atributos, imágenes y perfil físico | Backoffice; prioridad posterior a lecturas H4 si no hay evidencia de impacto mayor. Mantener perfil nullable, estados/versiones y orden al agrupar | Pendiente identificado; sin cambios en esta revisión |

Los pendientes de agrupación interna son de Poma; no están declarados bloqueados
por defecto. Un eventual cambio del transporte a Pricing requiere contrato
existente equivalente y prueba con Vera, sin tocar su servicio unilateralmente.
No se afirma que esta corrección SQL elimine los timeouts de 7 s de G1: falta
medir el SHA nuevo con PostgreSQL/Pricing reales en el recorrido autorizado.

## Respuestas del equipo y correlación — 29/10/2026

Vera confirmó que el preview consultaba el GET administrativo por producto,
no el precio comercial SKU/canal, y que faltaba X-Correlation-Id. Se corrige
su propagación desde el listado y detalle a PricingClient, así como desde el
servicio a las etapas DEMO_CANDIDATES_SQL/DEMO_ENRICHMENT_SQL. Las cuatro
etapas de listado comparten ahora la correlación HTTP entrante. El cliente
valida el UUID o genera uno técnico para llamadas independientes sin contexto.
No cambia endpoint, semántica de precio global, timeout, concurrencia ni SQL.

La prueba de regresión reprodujo cuatro fallos antes de la corrección;
26 casos de cliente/equivalencia pasan después. Cinco casos HTTP reales
locales entre Catalog y un servidor Pricing de fixture cubren listado,
detalle 200/404/503 y aislamiento de peticiones simultáneas. No representan
un Pricing real ni evidencia de 7 s, y no sustituyen la CI del SHA nuevo.

Marco confirmó que no hay una captura integral actual de logs de las tres
capas con sus revisiones ejecutadas. La matriz por owner, las discrepancias
históricas y el paquete de evidencia de solo lectura pendiente están en
[RESPUESTAS-BLOQUE-A.md](RESPUESTAS-BLOQUE-A.md). Presupuesto G1: NO VERIFICADO.
