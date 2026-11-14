# OpenAPI 3.1 — snapshots oficiales para validación offline

Fuente OpenAPI Initiative, licencia Apache-2.0 adjunta. Copias sin cambios,
descargadas el 06/11/2026; SHA-256 sobre UTF-8 con LF verificado por la prueba.
No hay descargas ni instalaciones durante las pruebas/CI.

| Archivo | Fuente | SHA-256 |
| --- | --- | --- |
| schema-2025-09-15.json | https://spec.openapis.org/oas/3.1/schema/2025-09-15 | d0a3955182364c7b5fdebfd0583ecad259a870b4a2fe86a1b0fe8785f8224fed |
| schema-base-2025-09-15.json | https://spec.openapis.org/oas/3.1/schema-base/2025-09-15 | 740186b45574c93647b1ca6184a96310efd384fbeed16bebd07f572eedfbddd4 |
| dialect-2024-11-10.json | https://spec.openapis.org/oas/3.1/dialect/2024-11-10 | 647f32dfff64949d5020a28ecd1af4ffeffb1e9c695f861a52255a8004e07460 |
| meta-2024-11-10.json | https://spec.openapis.org/oas/3.1/meta/2024-11-10 | 80706a9a404affedbf84ac4dc1328c9ce0d2a00804cdfc4d95c0ddd0053121dd |

Se usa Ajv 2020-12 y ajv-formats ya fijados en package-lock por Nest CLI /
@angular-devkit/core; no se cambian dependencias del monorepo. El YAML real se
lee con el parser incluido en Prettier y se decodifica su AST JSON-compatible,
sin espejo JSON manual. Tags/anchors, claves duplicadas y múltiples documentos
se rechazan explícitamente en esta convención del fragmento.

El esquema oficial estructural cierra las propiedades OpenAPI. Los Schema
Objects se evalúan con el dialecto OAS/JSON Schema 2020-12 oficial separado.
Se liga explícitamente el meta por defecto: Ajv 8.20, con el $dynamicRef meta
anidado del wrapper, trataba erróneamente un Parameter.schema como Parameter.
La adaptación en memoria sustituye SOLO ese enlace dinámico por el enlace
estático al evaluador del dialecto; los snapshots se mantienen intactos. Los
const de dialecto del schema-base se conservan. Se prueban documentos válidos,
propiedades espurias de Response, tipos inválidos y referencias sin resolver.

La validación detecta defectos estructurales/semánticos del candidato y compara
DTOs/errores reales. No acredita publicación normativa, homologación, grants,
despliegue ni sustituye las E2E reales con los peers fijados.
