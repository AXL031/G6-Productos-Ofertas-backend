# Bloque 01 — Configuración, persistencia y disponibilidad comercial

Fecha: 17 de octubre de 2026. Rama: `taco`.

Issues: [#97](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/97), [#98](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/98) y [#25](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/25).

## Referencia y alcance

Base local de Backend: `20ee578` (tres commits por delante de `origin/taco@b80632f`). Este informe describe cambios posteriores a esa base. Taco autorizó registrar los bloques validados mediante commits locales; el commit que incorpora este informe identifica la entrega del bloque 01. No se hizo push ni se modificó el PR #10. Los issues permanecen abiertos.

Docs local y `master` remoto contrastados en `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`. Fuentes de solo lectura:

- `AGENTS.md` de Backend y contenido vigente de los tres issues en GitHub.
- Docs: `arquitectura/Arquitectura.md`, `arquitectura/decisiones/REGISTRO_DEC_F.md` y `ADR-DEC-F-BLOQUEANTES.md`; DEC-F-002/005 y D-INV-01.
- Docs: `requisitos/specs/SPEC-015-control-stock-disponibilidad.md`, `requisitos/hu/HU-015-control-stock-disponibilidad.md` (en particular CA-43–48) y `requisitos/flujos/FLOW-015-control-stock-disponibilidad.md`.
- Docs: `contratos/http/openapi.yaml` (candidato `0.6.0-rc.1`), operaciones `consultarDisponibilidadComercial` y `verificarCantidadComercial` y sus schemas.
- Docs: `datos/inventory-svc/physical-model.md`, `BASELINE_0001.md`, `migration.sql` y `migrations/0002_order_id_operaciones_disponibilidad.sql`.

No se escribieron migraciones ni se ejecutó SQL contra bases compartidas. Los cambios están limitados a `apps/inventory-svc`.

## #97 — Correcciones verificadas

- Una variable numérica vacía o con espacios podía convertirse silenciosamente a cero; `PGPORT` vacío recuperaba el valor predeterminado. Ahora los valores explícitos se validan como enteros decimales seguros y los predeterminados solo se aplican a variables ausentes.
- Se rechaza un intervalo de worker superior a 2147483647 ms, que desborda el temporizador de Node.
- Los errores de configuración ya no imprimen valores inválidos recibidos.
- La conexión por parámetros `PG*` exige los cuatro campos documentados; no completa silenciosamente una base/contraseña ausente.
- Se conservan health/readiness, logger sanitizado y guards de autenticación. Las pruebas HTTP verifican que readiness sea público, responda 503 si la base no está saludable y no filtre secretos.

## #98 — Persistencia revisada

- El modelo Drizzle conservaba tablas y columnas pero omitía restricciones CHECK e índices del DDL oficial. Se incorporaron los existentes: invariantes de saldo, cantidades, identidad/fingerprint/payload, ámbito de umbrales, rutas comerciales e índices operativos/FK.
- Se contrastó por introspección el modelo de 15 tablas con los nombres declarados en `migration.sql` + `0002`: los **32 índices explícitos y 15 CHECK con nombre explícito** están representados; no se encontraron nombres ausentes. Esta comprobación de metadatos no verifica por sí sola equivalencia completa del DDL ni su aplicación en una instancia real.
- Nuevas pruebas de `DatabaseService` verifican COMMIT, ROLLBACK, uso de un mismo cliente y liberación del cliente incluso si falla el rollback, con un cliente PG de prueba.
- Los triggers de transiciones y timestamps siguen perteneciendo a las migraciones oficiales. No se generan ni aplican migraciones desde el schema Drizzle.
- La implementación de Inbox que ya estaba sin commit se conserva y no se conecta aquí; su consumo/deduplicación funcional se revisará en #102.

## #25 — Consultas comerciales

- El POST sin `fulfillment_ref` ignoraba `fulfillment.mode`. Ahora resuelve siempre canal + modalidad, y referencia cuando se aporta. Una referencia desconocida no cae a otra ruta del canal.
- Solo se consideran rutas activas hacia ubicaciones activas. Un mapeo ausente/ambiguo devuelve `INDETERMINADO`; no se suman ubicaciones.
- La ausencia de saldo registrado no demuestra que un SKU existente esté agotado: GET y POST responden `INDETERMINADO`. Un saldo registrado con cero disponible continúa dando `AGOTADO`/`INSUFICIENTE` según la operación.
- La verificación consulta los SKU en una sola lectura y evalúa la demanda completa de un SKU repetido. Dos líneas de 10 unidades sobre un saldo de 18 no reciben ambas `SUFICIENTE`.
- Las peticiones malformadas (incluidas líneas nulas, cantidades inválidas y propiedades extra) se rechazan con `400 VALIDACION`; los contextos semánticamente inválidos conservan `422 CONTEXTO_ABASTECIMIENTO_INVALIDO`. Se mantiene la relación canal/client_id, scopes y allowlists.
- Se corrigió la validación de canales para que nombres heredados de Object (`__proto__`, `constructor`) reciban `400 VALIDACION`.
- Las respuestas conservan minimización y `binding=false`; las pruebas comprueban que no se alteran saldos, reservas, operaciones, Kardex ni Outbox.
- El doble SQL en memoria ignoraba modalidad/referencia. Se corrigió y se añadieron comprobaciones del SQL generado por Drizzle con un cliente de prueba sin red.

## Archivos del bloque

Rutas relativas a `apps/inventory-svc/`:

- `src/config/inventory.config.ts` y `.spec.ts`: validación y regresiones.
- `src/database/database.service.ts` y nueva `database.service.spec.ts`: configuración de conexión y pruebas de transacciones.
- `src/drizzle/schema.ts`: representación de índices/restricciones oficiales.
- `src/disponibilidad/disponibilidad.service.ts` y `.spec.ts`: reglas comerciales y regresiones.
- `src/inventory.controller.ts`: validación estricta del enum de canales.
- `src/repositories/interfaces/commercial-routes.repository.interface.ts`: referencia opcional representada como `null` dentro del puerto.
- `src/repositories/drizzle/drizzle-commercial-routes.repository.ts` y nueva `.spec.ts`: resolución segura y SQL generado.
- `test/in-memory-database.mock.ts` y `test/app.e2e-spec.ts`: doble y regresiones HTTP.
- `CONFIGURACION.md` y este informe: operación y evidencia local.

## Validación ejecutada

Comandos desde la raíz de Backend:

| Comprobación | Resultado |
| --- | --- |
| `npm.cmd test` | PASS: 170 pruebas, 18 omitidas; 27 archivos aprobados y uno omitido |
| `npm.cmd run test:e2e` | PASS: 43 pruebas en 9 archivos; HTTP con dependencias de prueba |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS |
| `npm.cmd run format:check` | PASS |
| `npm.cmd run build:inventory-svc` | PASS |
| Introspección Drizzle contra nombres de índices/CHECK del DDL oficial | PASS: 15 tablas; 32 índices y 15 CHECK explícitamente nombrados presentes |
| `git diff --check` | PASS al cierre |
| PostgreSQL + RabbitMQ reales | NO EJECUTADO: las 18 pruebas reales no se habilitaron; acceso a Docker no autorizado |

Entorno de ejecución: Node `22.16.0`. Es inferior al rango declarado por Backend (`^22.22.3 || >=24.15.0`); los checks anteriores pasaron en este entorno. La validación con una versión admitida y con dependencias reales sigue pendiente. No se modificaron versiones ni dependencias.

Los errores impresos durante las pruebas de Outbox/rollback corresponden a fallos simulados intencionales y las aserciones pasaron. Durante el desarrollo se corrigió un error de tipos y la parametrización de dos casos nuevos; la tabla recoge los resultados finales.

## Cambios previos preservados

Estos tres archivos ya tenían cambios antes del bloque y no se editaron. Sus hashes SHA-256 de contenido permanecen como al inicio:

| Archivo | SHA-256 |
| --- | --- |
| `test/inventory.real.integration.spec.ts` | `07C4C9A86E66895349C259B3295EDFD62DE1A6E6790E48A1D960B39BF8E763AA` |
| `src/repositories/drizzle/drizzle-inbox.repository.ts` | `14D0AA7408B1B7D231FEC248E16090A58F061A726723BD93B67BD2FEDA9E23D0` |
| `src/repositories/interfaces/inbox.repository.interface.ts` | `91900718A83E88646EDAD65945496B8113B3A5008702F432918FE9B110EAEE55` |

## Estado y desbloqueos

Estado del bloque: **PARTIAL**. Las correcciones locales descritas pasan las validaciones; no se acredita cierre integral, integración autenticada externa, homologación ni despliegue.

- Entorno local / owner: ejecutar la suite aislada real cuando Docker esté disponible y autorizado, con Node dentro del rango admitido; verificar persistencia, constraints y rollback en PostgreSQL real.
- G7 / Seguridad: los grants y credenciales efectivos bloquean las llamadas externas autenticadas; se desbloquean con provisión y verificación de issuer/clave/audience/scopes y cliente autorizado.
- Gateway / owners de #107/#109: integración mediante el BFF requiere rutas, cliente común y autenticación verificadas. Oracle (#110) solo condiciona el E2E en ese entorno.
- Marco / datos compartidos (#14): el dataset y su eventual carga requieren el alcance y autorización ya definidos en ese issue. Este bloque no carga datos.
- Taco: revisar/publicar mediante el flujo acordado. Los commits locales están autorizados; cada push requiere permiso previo. No se cierran issues ni se modifica el PR #10 automáticamente.
