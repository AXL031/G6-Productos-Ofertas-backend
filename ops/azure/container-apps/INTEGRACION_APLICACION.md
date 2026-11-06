# Candidato de aplicación sobre master — 2026-11-06

Base: `387b949e338bf0d19833734e5b22a60f4f7ab60e`, posterior al merge del
publicador oficial #210. La autorización del publicador es independiente de la
aprobación e integración de este candidato de aplicación.

## Procedencia verificable

- Fuente oficial de aplicación: `integracion/h4-fase1-completa@bff05f8f856031807786cf10a501c5a45af07928`.
- Árbol de apps de esa fuente: `76180ce75197c29bf8a534f381180aa1b7f9f6e1`.
- Ampliación académica ya probada en el fork: commit `27b029e5feff77eefc344e12ad40804af1e360b8`.
- Árbol de apps de este candidato, idéntico al de 27b029e: `d7dc2b1a053d963cc340d8be6d79d71868a85dd8`.

La incorporación es selectiva por ámbito de aplicación, no un merge completo
de la rama de integración. No afirma que todos los commits de esa rama hayan
quedado integrados. Los cinco conflictos detectados en infraestructura Oracle
se evitan manteniendo las versiones de master de sus archivos existentes.
No se sobrescriben esos archivos ni se presentan como conflictos resueltos.

Los paquetes, lockfile, publicador y controles de release de master permanecen
sin cambios. Se mantienen también los checks reales de Caddy y topología Oracle
que estaban en master; la CI añade el E2E aislado Gateway→Inventory→PostgreSQL
de la fuente oficial y lo hace obligatorio en ambos agregadores.

Solo se añade `ops/oracle/H4-MATRIZ-OPERACIONES-FASE1.csv` desde la fuente
oficial como fixture documental inmutable para las pruebas de cobertura. No
se modifica infraestructura Oracle existente ni se aplican migraciones/seeds.
Los informes históricos de `ops/azure/review/` del fork no se incluyen.

## Validaciones del candidato

- `npm ci`: ejecutado con el lockfile existente de master.
- `npm run typecheck`: PASS.
- `npm run lint`: PASS.
- `npm run format:check`: PASS.
- `npm test -- --reporter=dot --maxWorkers=2`: 2457 aprobadas, 72 omitidas.
- `npm run test:e2e -- --reporter=dot --maxWorkers=2`: 993 aprobadas, 207 omitidas.
- `npm run build:all`: PASS.
- actionlint 1.7.12: PASS en CI y publicador.
- `git diff --check`: PASS.

Las pruebas condicionales omitidas en la suite general no se cuentan como
aprobadas; la CI oficial ejecutará sus jobs aislados obligatorios sobre el
HEAD de revisión. Aún no acredita despliegue, 65 positivos por HTTPS real,
publicación de nueve digests oficiales ni homologación G7 real.

Fase 1 selecciona 59 GET y seis POST. `prevalidarImportacionPrecios` sigue
excluida porque no tiene handler productivo. Los filtros de visibilidad
comercial y las escrituras autenticadas se conservan. El emisor simulado es
exclusivamente local. RabbitMQ y Storage de Bulk permanecen diferidos.
