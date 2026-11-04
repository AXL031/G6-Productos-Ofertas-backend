# DATA-002 — Evidencia preservada para el issue #12

**Estado:** lote corregido e integrado nuevamente al tip de `poma` y al alcance del PR #125 junto con el issue #44. No se escribió en Supabase compartido.

## Cambios y validaciones

- `001_preflight_readonly.sql` bloquea con `DATA002_PREFLIGHT_BLOCKED` si falta una referencia activa, un valor no pertenece a su característica o no existe una relación tipo/característica activa.
- `003_carga_catalogo.sql` ejecuta la misma guardia dentro de su transacción antes de insertar. La suite ejercita referencias faltantes, inactivas y relaciones inválidas; también prueba primera carga, repetición idéntica, postcheck y conflicto con contenido diferente.
- `004_postcheck_readonly.sql` es una consulta única de solo lectura compatible con SQL/MCP, sin metacomandos de psql. Devuelve cada comprobación con `PASS` o `FAIL`.
- `005_matriz_productos_imagenes.csv` conserva 18 filas de presentación y 15 columnas únicas.
- El manifiesto registra 36 referencias: 25 presentes y 11 ausentes de los manifiestos locales de Taxonomía. El estado de esas 11 referencias y de las relaciones contra el destino real permanece **NO VERIFICADO**. La fixture PostgreSQL es sintética y no prueba el estado de Supabase.

## Evidencia PostgreSQL descartable

Commit de código `de70d104cecb2ebf3e2aae9a1dc06c40d64aac3e`: [CI run #146](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39016061977). El job principal `Lint, Typecheck, Test, Build & Smoke Test` terminó `success`; el E2E registró 6/6 pruebas en `postgres.persistence.e2e-spec.ts`, incluida la validación DATA-002, y el total fue 361 pruebas aprobadas con 43 omitidas en otras suites.

El workflow completo tuvo un fallo aparte en el job `Taxonomy integration on disposable PostgreSQL` (`Connection terminated unexpectedly`). No corresponde a la suite PostgreSQL de Catálogo. No se modificó ese componente ni el workflow compartido.

## SHA-256 de los artefactos corregidos

- `002_manifest_catalogo.json`: `9e89065f9a0cc2f40f9fa0c1be3e89f162ceea5b4af685ea18b8186ffa9b639a`
- `001_preflight_readonly.sql`: `00d60aecfe75d3c14ededee87fc74e4dbc43a3d29b19c9eacbf2d2d2571d0b60`
- `003_carga_catalogo.sql`: `afd56282d02dd2e07191135a8757e3981ed6ccc23ef0a66dc41c1734c205f9b7`
- `004_postcheck_readonly.sql`: `d734539591f159d91994adc378a365d62d78b11d54e1481d63edf2313310c14b`
- `005_matriz_productos_imagenes.csv`: `8421776487664f97bd4b6b2329475fa89bcc48113513bbfd2564d536639e3e96`

Estos hashes identifican los artefactos auditados en la historia de `poma`; no autorizan su ejecución en ningún destino compartido.
