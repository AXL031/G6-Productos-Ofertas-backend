# Auditoría y correcciones — Issues #43 y #44

Refs #43. Refs #44. Fecha: 2026-10-21. Owner: Gabriel Poma; rama `poma`.
Alcance operativo: `IMPLEMENTAR_AHORA` para configuración y persistencia internas.
No se implementan otros issues ni se autoriza despliegue.

## A. Git y fuentes

- HEAD inicial local: `a81f2d5fa735d7353b5df0ec0f095abac489e5d3`.
- Se incorporó `origin/poma` por fast-forward hasta `c595d5de4db899a23a332ee2d264d43733a387c0`.
- Master revisado: `47e219e376fff1004ec10e9803c16119c811a699`.
- Merge normal: `44de54ef6c6ce30a433233c4a0cef0e5d2f12c7e`, sin conflictos.
  Master es ancestro; divergencia inmediatamente posterior: 0 detrás / 34 delante.
- Los siete commits entrantes solo aportan `AGENTS.md` y documentación Oracle.
  No se crearon ramas ni se reescribió historial.
- PR #119: fusionado, merge `83d75a5095ccdd9a9c06f53d9edaca4120197e37`.
  PR #125: abierto, `poma` → `master`; se conserva su alcance histórico.
- Se preservan los cambios locales previos en `scripts/seed/mcp/catalog/` y
  `prod-ca-2021.crt`, sin incluirlos en los commits de esta auditoría.

Fuente normativa: [Docs master c36bd9a](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/tree/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b).
Se consultaron Arquitectura, Modelo Conceptual, registro y matriz DEC-F,
matriz intermodular, SPEC/HU/FLOW-003 y 004, modelos lógico/físico de Catálogo,
convenciones BD, migración y validation.sql, catálogos de errores/eventos,
OpenAPI `0.6.0-rc.1` y AsyncAPI `0.6.0-rc.2`.
Se leyeron también las guías Oracle exigidas por el AGENTS integrado, el README
y las auditorías previas del servicio. Las versiones candidatas no acreditan
homologación externa.

DEC-F aplicables: 001 (identidad vendible), 002 (autoridad Inventory),
006 (autoridad Pricing), 009 (identidad/intención/idempotencia),
011 (perfil físico) y 012 (fuentes, compatibilidad y evidencia).
No se amplían esas decisiones ni se modifican contratos.

## B. Issue #43

| Criterio | Implementación y evidencia revisadas | Resultado |
| --- | --- | --- |
| Config válida / inválida | CatalogConfig antes de NestFactory; PG requerido, puertos, flags, TLS, roles y configuraciones condicionales; config.spec y bootstrap.spec | Cumplido en pruebas locales |
| Config inyectada coherente | AppModule.forRoot fija PG, Taxonomy, seguridad, mensajería y modos desde una instantánea; bootstrap.spec verifica los providers | Cumplido |
| PostgreSQL y TLS | Un pool max=4; session/direct; CA, rejectUnauthorized y hostname; verifyIdentity rechaza otro rol/BD, owner y privilegios elevados | Unitarias locales; TLS real en CI por SHA |
| Liveness separada | AppController sirve /health y /health/live sin consultar dependencias | Cumplido en HTTP local |
| Readiness real | readiness.ts es el controlador HTTP; readiness.controller.ts se registra como provider de comprobación comercial, no como segundo controlador HTTP | Cableado comprobado; no eliminar ninguno |
| Plazo y concurrencia | Un sondeo compartido, respuesta acotada a 2 s; tras timeout retiene el fallo hasta drenar; no cachea éxito tardío | readiness.spec prueba 100 solicitudes concurrentes y 100 tras timeout |
| Modos readiness | Identidad PG y consultas reales; preview comprueba lectura y Pricing; modo ordinario exige elegibilidad; read-only demo conserva su frontera específica | readiness.controller.spec y pruebas de configuración |
| Logging / HTTP | Redacción de secretos, Bearer/JWT, driver, JSON serializado y paths; Problem Details y UUID de correlación consistentes | sanitized-logger.spec, problem.filter.spec y bootstrap.spec |
| Cierre | enableShutdownHooks, cierre del pool y runtime AMQP existente; fallo de arranque cierra la app | Unitarias y suites existentes |

No se reprodujo un defecto nuevo de runtime del #43 que justificara reescribir
configuración, providers o sondas. Seguridad y AMQP mantienen su configuración
condicional existente; su ausencia no fabrica autenticación ni entrega de mensajes.
La disponibilidad de PostgreSQL no garantiza disponibilidad comercial.
Se recomienda revisión de aceptación del alcance interno, manteniendo el issue abierto.

## C. Issue #44

| Tabla oficial | Mapeo revisado |
| --- | --- |
| products | UUID, SKU/slug UNIQUE, enum, bigint, mínimos y versión |
| variants | FK padre, SKU/combinación UNIQUE, JSONB, enum y versión |
| sku_identity | Unicidad global, propietario exclusivo, FK RESTRICT; identidad por triggers |
| product_images | FK CASCADE, principal/posición, URL y timestamps |
| variant_images | FK CASCADE, posición, URL y timestamps |
| product_attribute_values | Referencias opacas text; JSONB NOT NULL; unicidad por característica |
| variant_attribute_values | Identificador boolean, JSONB y unicidad por característica |
| product_identifying_characteristics | FK propia y referencia característica única por producto |
| sku_physical_profiles | numeric sin pérdida de precisión; nullable en borrador; positivos finitos |
| activation_checks | FK compuesta variante/producto, SKU, UUID operación, estados, JSONB y constraints |
| master_barriers | Identidad operación, versión bigint opcional e índice parcial |
| outbox | Envelope/JSONB, message_id UNIQUE, índice pendiente y contadores |
| inbox | UNIQUE(message_id, handler), JSONB y timestamps |

La fixture inmutable y la migración oficial tienen el mismo blob Git:
`5861536e31b2eb0ccb94d8ad2a4e10f4e792d6d2`.
No se editó ninguna de ellas. Los triggers de identidad, versión, locking y
validación diferida al commit permanecen en PostgreSQL; no se simulan con
metadatos de Drizzle ni se ejecutan migraciones al arrancar.

Database, CatalogTransactionManager y repositorios reutilizan el pool validado.
Las escrituras reciben la transacción del agregado; valores y filtros se
parametrizan. Los sql.raw observados para probes son literales fijos.
El repositorio no abre pools independientes ni accede a entidades de otros BC.
Se preservan agregado/preparación/Outbox atómicos, locking padre/hijos ordenado,
deduplicación Inbox y separación producto/variante/SKU.

Las objeciones históricas del comentario del #44 ya están corregidas:

- Directorio de certificados accesible y clave copiada con permisos 600 en el contenedor.
- SQLSTATE obtenido recorriendo `cause`, con protección contra ciclos.
- 23505/23503/23502/23514, serialización, deadlock, timeout y conexión clasificados.
- Error diferido distinguido después de completar el callback; dominio/validación conservados.
- Mensajes seguros sin SQL, parámetros ni texto privado del driver.
- Suite PostgreSQL comprueba constraints, rollback, concurrencia, grants positivos
  y negativos, acceso a schema ajeno denegado y cierre del pool.

Brecha corregida en este bloque: las pruebas de mapping anteriores comprobaban
la lista de columnas y solo algunos tipos/restricciones. Se añaden 13 casos,
uno por tabla, contra la fixture oficial independiente: nombres/tipos de todas
las columnas, nulabilidad, presencia de defaults y nombres de todas las PK,
FK, UNIQUE y CHECK. Las expresiones de restricciones y triggers requieren las
pruebas PostgreSQL existentes; la nueva prueba no sustituye su ejecución.
También se corrige el README que todavía describía seis casos PostgreSQL cuando
la suite actual contiene 16. No se cambió código productivo sin un defecto reproducido.

## D. Validación e integridad

Entorno: Windows, Node 24.16.0, npm 11.13.0. Pruebas de sockets ejecutadas
fuera del sandbox con autorización de la herramienta. Los primeros intentos
restringidos fallaron por EPERM en temporales y EACCES en loopback; no son
fallos funcionales ni resultados aprobados. No se debilitaron aserciones/TLS.

| Comando | Resultado de esta ejecución |
| --- | --- |
| npm test -- --no-file-parallelism apps/catalog-svc/src/catalog.schema.spec.ts | PASS: 16 |
| npm test -- --no-file-parallelism apps/catalog-svc | PASS: 314, 33 archivos |
| npm run test:e2e -- --no-file-parallelism apps/catalog-svc | 53 PASS / 32 SKIP, 6 archivos PASS / 5 SKIP |
| npm run build:catalog-svc | PASS |
| npm run typecheck | PASS |
| npm run lint | PASS |
| npm run format:check | PASS |
| npm run build:all | PASS |
| npm test -- --no-file-parallelism | PASS: 704, 69 archivos |
| npm run test:e2e -- --no-file-parallelism | 406 PASS / 85 SKIP, 19 archivos PASS / 9 SKIP |
| git diff --check | PASS |

Docker no está instalado localmente: PostgreSQL desechable, runtime TLS y
RabbitMQ quedan SKIP, al igual que las integraciones opt-in no activadas.
No se cargaron credenciales ni se escribió en Supabase/Oracle.

Evidencia histórica verificada mediante jobs y logs: [CI 39505517354](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39505517354),
SHA `c595d5de4db899a23a332ee2d264d43733a387c0`, ambos jobs success;
16 pruebas PostgreSQL, 4 runtime PostgreSQL/TLS y 5 RabbitMQ ejecutadas.
Ese resultado no valida el nuevo SHA. La CI y los resultados generales del
SHA publicado se registran en la sección identificable del PR #125.

Cambios propios: este informe, README y catalog.schema.spec.ts, todos dentro
del ownership. Se conserva el trabajo previo de #45–#51 y DATA-002.
El diff histórico del PR incluye Gateway, dependencia AMQP y scripts CI/seed;
no se atribuyen a este bloque ni se amplía su alcance. El merge solo incorpora
documentación existente de master. Contratos y migraciones permanecen intactos.

## E. Dependencias, publicación y siguiente bloque

| Owner | Operación afectada | Condición verificable |
| --- | --- | --- |
| Infra local/CI + poma | Evidencia PG/RabbitMQ del nuevo SHA | Ejecutar las suites desechables en CI; comprobar logs, no inferir PASS de los SKIP locales |
| Arquitectura/Marco + poma, issue #46 | Readiness comercial ordinaria / elegibilidad por canal | Contrato y persistencia de elegibilidad versionados y disponibles; la tabla consultada sku_channel_eligibility no pertenece a la migración de 13 tablas auditada |
| Infra G6 + G5 + Seguridad | Integración AMQP/autenticación externa y Oracle | Permisos, red, topología y homologación verificables por operación y SHA; no condiciona desarrollo interno #43/#44 |

La dependencia comercial no se resuelve inventando filas, migraciones o un 200
de readiness. Los flags demo no equivalen a homologación comercial.
No se comunica aceptación de otro módulo ni se afirma despliegue.

Publicación autorizada: commits propios en poma, push normal y actualización
exclusiva de la descripción del PR #125 conservando los otros issues.
El SHA final es el commit que contiene este informe; ver git log y sección
«Auditoría y correcciones — Issues #43 y #44» del PR para CI y divergencia final.
PR e issues deben permanecer abiertos, sin merge ni cierre automático.

Siguiente bloque: revisar #45–#48 y avances posteriores respetando SKU vendible,
preparación terminal, retry/causation, autorización y la frontera de elegibilidad.
Revalidar fuentes actuales antes de resolver barcode, Q-06 o contratos GenericData.
No se implementa ninguno de esos pendientes en esta auditoría.
