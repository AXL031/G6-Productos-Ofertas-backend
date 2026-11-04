# Promotions: estructura, configuración y persistencia — backend #70/#71

Owner: Axel Cueva. Rama: `cueva`. Alcance: `apps/promotions-svc/`.
Estado posterior a la auditoría de #123: [AUDITORIA-PR123.md](AUDITORIA-PR123.md).
Ese corte distingue implementación local, integración bloqueada, homologación
pendiente y despliegue no ejecutado; los conteos y SHAs históricos de abajo
corresponden a sus fechas, no al candidato actual. `/health=200` y probes de
PG/broker exitosos no acreditan disponibilidad comercial ni autorizan release.

Este documento describe el avance local de #70. Los avances de #33/#70/#15/#112
fueron retirados del PR #116, fusionado el 16/10/2026 mediante `c3a6b0a`, que
contiene solo el Gateway aprobado. Estos avances permanecen en `cueva`,
con el PR #123 existente en draft. Las correcciones
actuales se detallan en `CORRECCIONES-PENDIENTES.md`.
No se modifican otras aplicaciones, dependencias, contratos, migraciones
históricas, permisos ni datos compartidos. La excepción autorizada por Axel el
22/10/2026 es `.github/workflows/ci.yml`: reconciliación exclusiva de ese archivo
con master, smoke de configuración sintética y job PostgreSQL aislado de #71.

## Corte de ejecución #70/#71 — 22/10/2026

Avance posterior #72/#73: reglas internas y diez handlers de consulta, con siete
lecturas de maestros respaldadas por PostgreSQL. Las tres consultas comerciales
conservan un gate explícito hasta disponer de sus fuentes autorizadas; la
acumulación multibeneficio y D-REC-01/02 siguen pendientes específicos. Ver
[CONSULTAS-DOMINIO.md](CONSULTAS-DOMINIO.md) para matriz, fuentes, pruebas y límites.

Avance #74/#75 del 23/10/2026: las doce escrituras administrativas y el dispatcher
AMQP transaccional se documentan en [ESCRITURAS-HTTP.md](ESCRITURAS-HTTP.md) y
[EVENTOS-AMQP.md](EVENTOS-AMQP.md). Ambos conservan fronteras específicas pendientes
de adaptadores autorizados; no acreditan despliegue ni activación del consumidor.

Se reprodujo el fallo de CI 39505633881: el contenedor de Promotions recibía
solo variables de puerto y rechazaba diez variables obligatorias ausentes.
`test/container.smoke.mjs` comprueba el rechazo y un arranque positivo con
configuración sintética, `/health` 200 y el healthcheck real de la imagen.
No se cambia la validación de producción ni se confunde liveness con readiness.

#71 incorpora mapping Drizzle de las 13 tablas oficiales, repositorios de
promociones/cupones/recomendaciones y consultas de proyecciones/Inbox/Outbox/
recibos. Comparte pool y unidad transaccional con el núcleo de cupones.
No ejecuta DDL ni consultas al inicializarse. Ver [PERSISTENCE.md](PERSISTENCE.md)
para alcance, pruebas reproducibles y límites.

Normativa revisada: Docs `51a5ce6e76bb0c61d93ef47416e46797bf5b9846`,
migraciones oficiales 0001–0004 sin cambios; OpenAPI 0.6.0-rc.1 y AsyncAPI
0.6.0-rc.3. #75 adapta código, contratos generados, probe y fixtures a los nombres
físicos rc.3. La base se prueba con broker desechable; la homologación compartida
y los mappings productivos de los payloads genéricos siguen pendientes específicos.
El consumidor/pump y probes siguen deshabilitados por defecto.

Validación local del checkout con estos cambios: 71 unitarias y 6 E2E de
Promotions; 293 unitarias generales y 347 E2E generales, con 20 omitidas por
dependencias/configuración existentes; typecheck, lint, formato y builds PASS.
También PASS: arranque compilado, Docker, 7 escenarios de probes reales,
11 escenarios de cupones y 8 grupos de persistencia con PostgreSQL TLS
descartable. Las pruebas locales no acreditan CI remota, integración compartida,
homologación, aprobación DATA ni despliegue. #70/#71 permanecen abiertos hasta
la revisión y aceptación correspondientes.

## Base normativa del avance anterior de #70

Docs: commit `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`.

- `arquitectura/Arquitectura.md`: capas/ownership (§2, §4, §7), configuración
  tipada y validación al arrancar (§23), logging (§24), health/readiness (§25),
  shutdown (§45) y timeouts (§47).
- `contratos/http/openapi.yaml`: candidata `0.6.0-rc.1`.
- `contratos/eventos/asyncapi.yaml`: candidata `0.6.0-rc.2`.
- Registro DEC-F, matriz de trazabilidad y matriz intermodular: DEC-F-007/008/009
  delimitan las reglas futuras de Promotions, sin implementarlas en #70;
  DEC-F-012 exige separar contrato, implementación, pruebas e integración.
- SPEC-005/006/007 y `datos/promotions/physical-model.md`: ownership propio,
  proyecciones no autoritativas y dependencias de PostgreSQL/mensajería.
- `ops/postgres-runtime/guia-desarrollo-local.md`: variables y archivo local del
  servicio, identidad propia, Session Pooler y SSL verify-full.

El issue cita también `datos/promotions-svc/physical-model.md`, que no existe en
el árbol consultado. La ruta canónica existente es `datos/promotions/physical-model.md`.

## Carga y validación

Plantilla: `.env.example` de esta aplicación. Copiarla como `.env.local` en la
misma carpeta y completar `PGPASSWORD`, `PGSSLROOTCERT` y `RABBITMQ_URL` con los
valores privados/autorizados. Host, puerto, base, login, schema y modo provienen
de la sección 2 de la guía oficial. El certificado debe ser el de tu equipo;
no copiar la ruta de otro integrante. El archivo local queda ignorado por Git.
La guía PostgreSQL no entrega la configuración RabbitMQ; ese campo es separado
y no se rellena con un broker ficticio. Con un campo obligatorio vacío el
servicio informa su nombre y rechaza el arranque.

Desde la raíz del backend, `npm run start:dev:promotions-svc` o, después del build,
`npm run start:promotions-svc`. La aplicación carga `.env` y después
`apps/promotions-svc/.env.local`; las variables de la sesión tienen precedencia
sobre ambos archivos. No modifica `process.env` ni carga `.env.local` de otros
servicios o el archivo administrativo de la raíz. Los errores de lectura no
publican rutas ni contenidos.

Guardar los valores privados en el archivo local ya ignorado por Git. Recibir
la identidad y contraseña runtime por el canal designado; no usar una cuenta
seed, owner o administrativa. La validación de configuración no demuestra los
permisos efectivos del login: eso corresponde a la prueba de persistencia #71.

| Variable            | Requisito / propósito                                                                 |
| ------------------- | ------------------------------------------------------------------------------------- |
| NODE_ENV            | development, test o production; por defecto development. No autoriza despliegue.      |
| PROMOTIONS_SVC_PORT | Puerto HTTP entero 1–65535. Tiene precedencia sobre PORT.                             |
| PORT                | Fallback HTTP; si faltan ambos puertos se conserva 3004.                              |
| PGHOST              | Host PostgreSQL sin URI, credenciales ni espacios. Obligatorio.                       |
| PGPORT              | Puerto PostgreSQL entero 1–65535. Obligatorio.                                        |
| PGDATABASE          | Nombre de la base autorizada. Obligatorio.                                            |
| PGUSER              | Login runtime propio de Promotions según la guía oficial. Obligatorio.                |
| PGPASSWORD          | Contraseña privada del login. Obligatoria, nunca se registra.                         |
| PGSSLMODE           | Obligatorio: verify-full; no hay downgrade TLS.                                       |
| PGSSLROOTCERT       | Ruta absoluta legible a un archivo X.509 válido del CA autorizado. Obligatoria.       |
| G6_DATABASE_SCHEMA  | Obligatorio: promotions.                                                              |
| G6_CONNECTION_MODE  | Obligatorio: session.                                                                 |
| RABBITMQ_URL        | URI AMQP/AMQPS del destino autorizado, sin query ni fragmento. Obligatoria y privada. |
| PROMOTIONS_DEPENDENCY_PROBES_ENABLED | `false` por defecto; `true` habilita probes reales solo bajo demanda. |
| PROMOTIONS_COUPON_RUNTIME_ENABLED | `false` por defecto; `true` requiere además adaptadores y condiciones verificables de #33. |

La ausencia o invalidez de variables obligatorias impide crear la aplicación y
abrir su puerto. El diagnóstico contiene únicamente nombres de variables.
El logger de arranque emite JSON con timestamp, nivel, servicio y código fijo;
no serializa excepciones raw, stacks, URLs, contraseñas ni tokens. Se desactiva
el logger raw de Nest durante bootstrap. Los logs operativos de negocio son
alcance posterior de #76.

Validar el archivo CA no prueba la identidad del servidor ni una sesión TLS:
la sonda real comprueba una sesión TLS, pero no todos los permisos de persistencia
de #71. Por defecto no se crean conexiones PostgreSQL ni RabbitMQ. Las dos
opciones nuevas aceptan exclusivamente `true`/`false`; un valor ambiguo rechaza
la configuración. No son autorización para operar contra servicios compartidos.

## Liveness y readiness

`GET /health` conserva su payload y confirma solamente que el proceso vive.
No indica conexión DB/broker, disponibilidad funcional ni integración externa.

`PromotionsReadinessService.check()` comprueba únicamente PostgreSQL y broker
propios, con timeout de 1 segundo y señal de cancelación por probe. Por defecto
devuelve `disabled` y resultado global `not_ready`; habilitar probes no inicia
consumidores ni Outbox. Sin un adaptador registrado devuelve `not_implemented`.
Un error/timeout devuelve `down` sin el diagnóstico raw; solo ambas comprobaciones
exitosas en esa invocación permiten `ready`. No hay fan-out a otros servicios.

Los probes reales de #70 abren clientes propios bajo demanda y los cierran al
terminar, también ante error/cancelación. PostgreSQL ejecuta `SELECT 1` con el CA
configurado y `rejectUnauthorized=true`. RabbitMQ autentica y hace una consulta
pasiva de `po.promociones.q` (adaptada en #75); una cola ausente no se crea. No consumen, publican,
declaran topología ni escriben filas. Los timeouts del driver son de 750 ms.
Un `ready` acredita esas dependencias en esa comprobación; no elegibilidad,
consumidor funcional, permisos completos de #71 ni homologación G5.

## Exposición HTTP fuera del alcance de #70

Arquitectura §25 pide `/health/live` y `/health/ready`, pero los criterios de #70
dicen **«No se agregan rutas o reglas de negocio»**. OpenAPI no declara rutas de
health. Por esa contradicción se conserva únicamente `/health` y se prueba la
readiness internamente, sin ampliar el contrato HTTP.

Se sigue el criterio explícito de #70: no agregar rutas. La tarea de #76 ya
incluye exponer health/readiness seguro, por lo que esa exposición se mantiene
en el bloque posterior y debe aplicar las rutas técnicas de arquitectura una
vez satisfechos sus prerrequisitos. Esta separación de fases permite terminar
la configuración y evaluación interna de #70 sin inventar endpoints ahora.

Estado de #70: configuración, logging, evaluación interna y adaptadores reales
bajo demanda implementados localmente. La exposición HTTP de readiness pertenece
al bloque posterior; homologación y despliegue no se acreditan. El cierre formal
requiere revisión y PR fusionado. La configuración privada ya pasó validación
y arranque real de liveness usando un broker local de desarrollo; no acredita
readiness funcional. La prueba separada de PostgreSQL autenticado también pasó
con TLS autorizado y solo consultas de lectura sobre el schema propio.

## Broker local de desarrollo

Con Docker activo, ejecutar `node apps/promotions-svc/dev/start-local-broker.mjs`.
Si ya existe RABBITMQ_URL, la conserva. Si está vacío, inicia RabbitMQ real
con puerto aleatorio ligado a 127.0.0.1 y credenciales generadas, comprueba la
conexión y completa únicamente esa variable en el .env.local ignorado. No
imprime credenciales ni cambia topologías compartidas. El contenedor queda
activo para desarrollo; el comando informa su nombre y cómo detenerlo.
Al detenerlo se elimina el contenedor descartable. Para crear otro, vaciar
únicamente RABBITMQ_URL y volver a ejecutar el helper; este no reemplaza una
configuración existente automáticamente.

Después del build, `node apps/promotions-svc/dev/check-local-startup.mjs`
valida la configuración y comprueba /health en un puerto temporal. Detiene
el proceso al terminar, no inicia consumidores compartidos ni prueba integración
de base de datos. Verificación real del 2026-10-16: PASS. El servicio puede
iniciarse después con el comando start:dev indicado arriba.

`node apps/promotions-svc/dev/check-local-database.mjs` comprueba TLS, login/base
esperados, atributos no administrativos y SELECT sobre las seis tablas maestras
propias dentro de BEGIN READ ONLY/ROLLBACK. Resultado real: PASS, seis conteos
cero; evidencia en `test/evidence/local-postgres-2026-10-16.json`. No verifica
todos los grants/membresías, reglas de negocio, integración ni homologación.

## Verificación

Pruebas enfocadas antes de generales:

```powershell
npm test -- apps/promotions-svc --maxWorkers=1
npm run test:e2e -- apps/promotions-svc --maxWorkers=1
```

Cubren configuración incompleta/malformada, precedencia de archivos/sesión,
certificado inválido, bootstrap por el provider real, errores sin secretos,
liveness independiente, readiness sin adaptadores, caída/recuperación y timeout.
No acreditan integración autenticada ni E2E de negocio.

Resultado histórico del bloque inicial, 2026-10-16 (America/Lima), Node v24.21.0 / npm 11.19.0:

| Comando                                                  | Resultado                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm test -- apps/promotions-svc --maxWorkers=1`         | PASS: 4 archivos, 43 tests.                                                                |
| `npm run test:e2e -- apps/promotions-svc --maxWorkers=1` | PASS: 1 archivo, 4 tests.                                                                  |
| `npm test -- --maxWorkers=1`                             | PASS: 12 archivos, 51 tests.                                                               |
| `npm run test:e2e -- --maxWorkers=1`                     | PASS: 9 archivos, 12 tests.                                                                |
| `npm run typecheck`                                      | PASS.                                                                                      |
| `npm run lint`                                           | PASS.                                                                                      |
| `npm run format:check`                                   | PASS.                                                                                      |
| `npm run build:promotions-svc`                           | PASS.                                                                                      |
| `node apps/promotions-svc/test/startup.smoke.mjs`        | PASS: arranque compilado inválido rechazado, liveness HTTP y logs sin secretos sintéticos. |
| `node --test scripts/seed/run.test.mjs`                  | PASS: 14 tests, revisión independiente de #1.                                              |

El primer intento de Vitest en sandbox falló con EPERM al renombrar temporales;
las ejecuciones fuera de esa restricción pasaron. El smoke compilado tampoco
alcanzó su puerto loopback dentro del sandbox; fuera de esa restricción pasó.
No se modificaron tests/configuración global para evitar esas restricciones.
Vitest informa un aviso de deprecación del plugin existente vite-tsconfig-paths;
no se cambian dependencias o configuración compartida por este issue.

Estos resultados históricos son del bloque #70, anteriores a los nuevos tests
de #33. Ver `COUPON_COMMANDS.md` y `test/evidence/` para las pruebas posteriores
de cupones y `CORRECCIONES-PENDIENTES.md` para la revisión actual. Estos avances
no forman parte del diff vigente de #116. No acreditan revisión, merge ni cierre.

## Integración Marketplace H4 — estado por frontera

**Corte:** rama `cueva`, HEAD auditado `3f42e0e474071a13eb1b3120819d142cfeda4a95`; PR #123 abierto en draft. CI de Actions del SHA exacto consultada el 2026-10-20: PASS (dos ejecuciones de lint/typecheck/test/build/smoke; PR describe 20 pruebas E2E omitidas por configuración privada). No se infiere despliegue ni grant G7.

### Operaciones HTTP G1 del contrato G6

El OpenAPI G6 enumera `listarPromociones`, `evaluarPromociones`, `validarCupon` y `obtenerRecomendaciones`. En este HEAD el controller HTTP del servicio Promotions solo expone health; no se localizaron handlers HTTP de evaluación de promociones ni validación de cupones. Por ello, para Marketplace se registran como **CONTRATO_DEFINIDO / NO IMPLEMENTADO HTTP en este SHA**, pendientes de implementación y Provider según SPEC/OpenAPI. Los adaptadores/consumidores AMQP no satisfacen esos operationIds.

| Capacidad | Semántica de integración |
|---|---|
| `POST /api/v1/promociones/evaluar` — `evaluarPromociones` | Evaluación no consume ni reserva beneficio. El consumidor solicita un resultado conforme al DTO OpenAPI. |
| `POST /api/v1/cupones/validar` — `validarCupon` | Validación sin consumo. `customer_ref`, cuando lo exija la regla, identifica al comprador y nunca al BFF técnico. |
| `GET /api/v1/promociones` — `listarPromociones` | Lectura de canal solo en la forma publicada en OpenAPI; handler/provider por verificar. |
| `GET /api/v1/recomendaciones` — `obtenerRecomendaciones` | Aplicar audience/scope/allowlist de OpenAPI; mantener D-REC-01/02 para productos con varios SKU, sin inventar precio/stock global del padre. |

El avance actual de Cueva incluye consumidores AMQP/Outbox y reglas internas; el runtime productivo de consumidores permanece deshabilitado por configuración (`PROMOTIONS_COUPON_RUNTIME_ENABLED=false` conforme al PR #123) y requiere gates propios antes de activarse. No declarar endpoint HTTP funcional por ese avance. G5 conserva la orquestación de consumo/restauración; G6 conserva autoridad de reglas y uso. No consumir durante evaluar/validar.

### Evidencia mínima siguiente

Implementar cada handler contractual con autorización real según OpenAPI, probar resultado aplicable/no aplicable y válido/inválido, ausencia/error, idempotencia donde contrato lo declare y ausencia de mutación de cupo/uso. Ligar Provider/CI al nuevo SHA. Luego verificar grant/token G7, deploy por digest y BFF/E2E G1 separadamente. Consultar la [matriz H4](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/castilla/integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md) y el [acuerdo normativo](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/docs/g1-marketplace-homologacion-lote03/integraciones/ACUERDO_G1_G6_H4_2026-10-20.md).
