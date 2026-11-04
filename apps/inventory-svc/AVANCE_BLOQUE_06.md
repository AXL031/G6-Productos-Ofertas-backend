# Bloque 06 — Provider G5 y pendientes de la demo

Fecha: 17 de octubre de 2026. Rama: `taco`. Base verificada local y remota: `5e1a5b4d143eb81e653c7f731d37b8a383efb37d`. Estado global: **PARTIAL**.

## Estado contrastado

Se comprobaron `AGENTS.md`, rama, ownership, diff y los trece issues actuales de Taco en GitHub: **13 abiertos, 0 cerrados**. Once tienen implementación o preparación local parcial; las dos entregas de integración #104/#105 conservan bloqueos específicos. Estas cifras no representan trece funcionalidades ausentes ni once issues terminados.

Los once commits desde `b80632f` ya están en `origin/taco`; esta auditoría no los duplica. Los tres últimos son:

| Commit    | Entrega de Inventario                                                        |
| --------- | ---------------------------------------------------------------------------- |
| `4fa208f` | Validación del resultado durable y de los límites integer de reintegros      |
| `2a76c92` | Error RESERVA_EXPIRADA cuando la expiración ocurre entre lectura y bloqueo   |
| `5e1a5b4` | Pruebas HTTP del provider para Ventas y Postventa, con tipado de las pruebas |

Las fuentes normativas se conservan en Docs `master` `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`: OpenAPI 0.6.0-rc.1, AsyncAPI 0.6.0-rc.2, SPEC-015/016, registro/trazabilidad DEC-F, modelo físico y alineación con Ventas. No se cambian esos documentos ni sus contratos.

Backend `master` remoto observado en esta auditoría: `2970df90babf2c8caa1849b179b02918fc74a005`. No se sincronizó ni fusionó con `taco`.

## #30/#31 — Alcance implementado y comprobado

En la confirmación de reservas se distingue EXPIRADA también después del bloqueo. La regresión simula una lectura inicial obsoleta y una expiración ya persistida: responde `409 RESERVA_EXPIRADA`, sin consumo ni nuevos efectos. Es una prueba aislada del caso entre lecturas, no evidencia de concurrencia PostgreSQL real.

El replay de reintegro valida identidad, fecha de finalización, correspondencia completa de líneas agrupadas, cantidades, saldos coherentes y versión segura. Rechaza resultados incompletos o inconsistentes con `409 IDEMPOTENCY_CONFLICT`, sin volver a aplicar stock. Un resultado válido se reproduce desde su snapshot original aunque haya reintegros posteriores. Se comprueban los límites de las columnas integer del modelo, tanto por línea como en suma agrupada y saldo final; el desbordamiento devuelve `422 CANTIDAD_INVALIDA` y revierte la operación completa. No se crean códigos, DTO, índices ni migraciones nuevos.

`test/inventory-g5-provider.e2e-spec.ts` contiene 17 pruebas HTTP con Nest, JWT sintéticos firmados RSA y base en memoria. Cubren:

- M1: reserva, consulta durable, consumo, liberación, expiración, correlación y reintentos sin doble efecto.
- Un `202 ACCEPTED` con stock insuficiente cuya consulta durable informa REJECTED; nunca se interpreta la admisión como stock reservado.
- M2: consulta informativa detallada, sin canal comercial ni reserva implícita. M2 sigue sin permiso para reservar, consumir, liberar o consultar operaciones técnicas de M1, incluso si el JWT de prueba declara esos scopes.
- F3: saldo y Kardex/Outbox coherentes, preservación de reserved/blocked, replay tras pérdida de respuesta y nueva recepción parcial con nueva identidad de operación y la misma referencia de devolución.
- Rechazo de ubicación desconocida/inactiva/sin saldo y de product_id usado en lugar de sku; no se supone almacén receptor.
- Fallo al guardar Outbox con rollback de saldo, operación y Kardex, error técnico sanitizado y reintento exitoso.
- Desbordamiento en la segunda ubicación con rollback completo; JWT obligatorio en operaciones G5 aunque esté habilitada la demo comercial anónima.

La suite no ejecuta el cliente G5, no usa credenciales G7 ni confirma físicamente una recepción. Inventario valida la ubicación activa y el saldo existentes; la evidencia de recepción e inspección sigue siendo responsabilidad del flujo M2 pendiente de validación externa.

Se leyeron los cinco comentarios actuales de [G5 #51](https://github.com/Taller-SW-Web/G5-Ventas-Postventas/issues/51). La [ratificación P-04/P-05/P-06](https://github.com/Taller-SW-Web/G5-Ventas-Postventas/issues/51#issuecomment-6157525243) confirma el contrato base, la identidad separada de cada recepción parcial y el GET detallado informativo para M2; no concede reservas/consumos de reemplazo. La [respuesta posterior de G5](https://github.com/Taller-SW-Web/G5-Ventas-Postventas/issues/51#issuecomment-6220442428) solicita HTTPS pública protegida por JWT, informa despliegue propio incompleto y propone broker → eventos → cupones desde entornos locales. Son declaraciones de coordinación, no pruebas de conectividad ni aceptación de una topología productiva. No se enviaron comentarios ni mensajes a terceros.

## Matriz de pendientes

Los estados siguientes describen el alcance completo de cada issue. Las implementaciones locales enumeradas en los informes anteriores se preservan.

| Issue                                                                            | Estado               | Evidencia local                                                                                | Pendiente y condición verificable                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#14](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/14)   | PARTIAL              | Preparador offline, validación/diff y dataset sintético; bloque 05                             | Poma/#12 confirma SKU y condición comercial actuales; Marco/Infra entregan baseline autorizada, revisan destino/registry y proceso de release. No conectar ni escribir en Supabase en esta fase.                                                                                                           |
| [#25](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/25)   | PARTIAL              | Dos consultas comerciales sin JWT, limitadas al peer Gateway configurado; bloque 04            | Marco/#106/#107 corrige y prueba la propagación de errores del POST; Infra/#110 acredita aislamiento real. No ampliar operaciones anónimas por inferencia.                                                                                                                                                 |
| [#30](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/30)   | PARTIAL              | Ciclo M1, errores, estados y replay del provider local                                         | G5/M1 y Marco acuerdan/verifican secuencia por canal, tratamiento del 202 y resultados definitivos; G7 concede los accesos efectivos; ejecutar flujo bilateral con entorno identificado.                                                                                                                   |
| [#31](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/31)   | PARTIAL              | Consulta informativa y reintegro F3 local                                                      | G5/M2 define y demuestra recepción/aptitud; G6/G5 resuelven destino real y representación de location_id; G7 concede los scopes acordados. Ejecutar prueba bilateral, sin activar reserva/consumo M2.                                                                                                      |
| [#97](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/97)   | PARTIAL              | Configuración fail-closed, health/readiness y logs; bloque 01                                  | Taco/entorno e Infra acreditan arranque y readiness con dependencias reales aisladas y Node admitido.                                                                                                                                                                                                      |
| [#98](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/98)   | PARTIAL              | Mapping Drizzle, repositorios y transacciones; bloque 01                                       | Ejecutar el test pendiente en PostgreSQL aislado, incluidas restricciones y permisos positivos/negativos. No usar Supabase compartido como sustituto.                                                                                                                                                      |
| [#99](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/99)   | PARTIAL              | Invariantes de stock/reserva/incidencias/reintegros/traslados y política offline pura          | Marco y owners G4/G5/G7 resuelven identidad estable, deduplicación entre operaciones, actor y ubicación de la venta offline; ejecutar persistencia/concurrencia real.                                                                                                                                      |
| [#100](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/100) | PARTIAL              | Lecturas, umbrales, dashboard, traslados y consultas comerciales; bloques 02/04                | Catálogo/Poma aporta mapping contractual de producto/categoría/marca a SKU; Marco resuelve métricas SPEC-016 no definidas por el schema HTTP y los errores de Gateway. No ignorar filtros ni inventar campos.                                                                                              |
| [#101](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/101) | PARTIAL              | Escrituras contractuales implementadas salvo frontera offline; bloques 02/06 y avances previos | Marco/G4/G5/G7 homologan identidad, actor/ubicación y autorización offline antes de conectar la política pura a una mutación persistente. Las demás escrituras requieren validar el stack real.                                                                                                            |
| [#102](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/102) | PARTIAL              | Inbox, inicialización SKU, Outbox, workers y manejo de fallos aislados; bloque 03              | Marco y owners Bulk/Catálogo definen payload y semántica de bulk adjust/deactivated, hoy GenericData. Infra y G5/#29 homologan y prueban broker/topología/retry/DLX; no crear handlers por suposición.                                                                                                     |
| [#103](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/103) | PARTIAL              | Límites, timeouts, errores sanitizados y contadores internos; bloque 03                        | Validar fallos y recuperación con DB/broker reales y CI. No inventar exporter ni endpoint de métricas sin contrato/alcance.                                                                                                                                                                                |
| [#104](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/104) | BLOQUEADO_ESPECÍFICO | Provider HTTP y pruebas Gateway disponibles                                                    | La integración React está fuera del alcance actual por instrucción del usuario. Requiere cliente común Marco/#109, rutas #106/#107 y validación UI autorizada. No se inspeccionó ni se afirma ausente el cliente Frontend actual; los issues Frontend considerados terminados no prueban esta integración. |
| [#105](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/105) | BLOQUEADO_ESPECÍFICO | Suites locales/provider, nunca presentadas como E2E real                                       | Taco y Marco/Infra necesitan #104, stack aislado PostgreSQL/RabbitMQ, datos autorizados, seguridad y #110 para despliegue. Solo un recorrido real React→Gateway→Inventory→persistencia con evidencia por operación satisface el E2E solicitado.                                                            |

### Brecha Gateway confirmada en el master consultado

El registro `apps/api-gateway/src/routing/contract-routes.ts` sigue teniendo blob `5c998c93bb5485d8f00946687e9f2b7b3d8b6a78`: el POST `verificarCantidadComercial` conserva listas `codes: []` para 400/401/403/422/500/503. `gateway-proxy.ts` y `gateway-problem.ts` tienen los mismos blobs que el artefacto fijado del bloque 04 (`f200b5273645c6ad0601e665c8a6185ecb187098` y `175423910d3371aacf2ef6d5033201a9c259542b`). La propagación sigue admitiendo solo códigos registrados; los errores upstream caracterizados como 400/401/422/503 se convierten en 500.

Owner: Marco, routing #106 y coordinación demo #107. Desbloqueo: corregir el registro a partir del contrato y ejecutar regresiones que conserven los códigos originales. Las pruebas locales que caracterizan el defecto no significan que haya quedado corregido. No se editó Gateway ni se fusionó master para incorporar trabajo ajeno.

## Validación disponible

Resultados de las comprobaciones ejecutadas sobre el código ahora contenido en `5e1a5b4`; el archivo nuevo de este cierre es únicamente este informe:

| Comando/consulta                                                                                         | Resultado                                                                           |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Vitest focalizado: `reintegros.spec.ts` y `reservations.cycle.spec.ts`                                   | PASS: 40 pruebas                                                                    |
| Vitest E2E focalizado: `inventory-g5-provider.e2e-spec.ts`                                               | PASS: 17 pruebas HTTP del provider                                                  |
| `npm.cmd test`                                                                                           | PASS: 261 pruebas; 18 omitidas; 32 archivos aprobados y uno omitido                 |
| `npm.cmd run test:e2e`, con artefacto Gateway del bloque 04                                              | PASS: 108 pruebas en 12 archivos                                                    |
| `npm.cmd run typecheck`                                                                                  | PASS                                                                                |
| `npx.cmd tsc -p apps/inventory-svc/test/tsconfig.g5.json`                                                | PASS                                                                                |
| `npx.cmd tsc -p apps/inventory-svc/test/tsconfig.demo.json`                                              | PASS                                                                                |
| `npm.cmd run lint`                                                                                       | PASS                                                                                |
| `npm.cmd run format:check`                                                                               | PASS                                                                                |
| `npm.cmd run build:inventory-svc`                                                                        | PASS                                                                                |
| `node --test apps/inventory-svc/data/data-f1/dry-run.test.mjs`                                           | PASS: 27 pruebas                                                                    |
| Dry-run #14 contra `baseline-empty.json` sintético                                                       | Preparación PASS: PARTIAL, 38 INSERT candidatos, 0 conflictos, ready_for_load=false |
| API `check-runs` de `5e1a5b4`                                                                            | 0 check-runs reportados; no acredita CI remoto aprobado                             |
| `git diff --check` y `git diff --cached --check`                                                         | PASS al cierre                                                                      |
| PostgreSQL/RabbitMQ reales, cliente G5 real, grants G7, browser E2E, homologación operativa y despliegue | NO EJECUTADO / no acreditado                                                        |

El artefacto Gateway usa `32153bffb35daa8761272c7b55fe23dc1df70007`, procesos loopback y persistencia en memoria de prueba. La presencia de código real del proxy no convierte esa suite en integración con DB/broker reales.

El dry-run conserva hash semántico del candidato `6463cda113854e9a7af0813b42927851c76c0073f4248a3c4f7b21c8105e80d9`. No ejecuta SQL, no conecta a Supabase y no demuestra carga real ni publicación actual de Catálogo.

Node local `22.16.0`, fuera de `^22.22.3 || >=24.15.0`. La validación con runtime admitido continúa pendiente. No se volvió a solicitar Docker ni se intentó sustituirlo por una conexión a Supabase.

## Entrega de esta continuación

No se identificó otra implementación autónoma respaldada por los contratos actuales que pueda completar los bloqueos anteriores sin cruzar los límites indicados. Esto no certifica ausencia de defectos futuros: delimita el trabajo revisado y la evidencia disponible.

Único archivo nuevo: `apps/inventory-svc/AVANCE_BLOQUE_06.md`. El test real preexistente se inspeccionó sin editar y queda fuera del commit: `test/inventory.real.integration.spec.ts`, SHA-256 `07C4C9A86E66895349C259B3295EDFD62DE1A6E6790E48A1D960B39BF8E763AA`.

El usuario autorizó en esta continuación commits en español y push normal a `origin/taco`. Esa autorización no incluye PR, merge, cierre de issues, cambios de Frontend/Gateway/Docs ni escrituras en infraestructura. La creación del informe no acredita publicación: el resultado concreto del commit/push se informa al finalizar.

Errores obligatorios locales pendientes: ninguno entre los checks ejecutados; quedan las omisiones y dependencias reales descritas. Cambios fuera del alcance: ninguno. Estado final: **PARTIAL**.
