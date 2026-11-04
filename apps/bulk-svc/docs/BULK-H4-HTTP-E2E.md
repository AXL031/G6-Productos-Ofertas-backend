# Bulk H4 — cobertura y reproducción HTTP

## Contrato y alcance

Base normativa consultada: OpenAPI `0.6.0-rc.3` en Docs `master` (`f903f0bb0485bc0c6a6a7c6545446e972286daf6`), AsyncAPI `0.6.0-rc.4` y SPEC-001. Las rutas de importación son provisionales internas (`x-status: provisional-internal`) y requieren `userBearer`. La admisión responde `202`; no significa que Catalog, Pricing e Inventory hayan terminado.

La admisión usa `multipart/form-data`, campo binario obligatorio `archivo` y `template_version` opcional, cuyo único valor admitido es `2`. Incluye `x-correlation-id` como UUID conforme al parámetro común. La respuesta `ImportacionGeneralAceptada` requiere `batch_id`, `status: QUEUED`, `template_version` y `correlation_id`. Los límites H4 son 10 485 760 bytes por archivo, 5 000 filas de datos y 50 MiB XLSX descomprimido.

DEC-G6-INT-08 y 09 rigen la plantilla v2, resultados durables por fila/dominio y la exclusión de inventar éxito para dominios pendientes. DEC-G6-INT-10 rige la exportación y queda fuera de este cierre de importación. La referencia de acuerdos internos citada en el issue no está publicada en el `master` de Docs consultado; la revisión candidata disponible se conserva como referencia de trabajo, no como publicación normativa. No se cambia ningún contrato compartido.

## Matriz de operaciones — línea base antes de esta ampliación

`IMPLEMENTADO` describe código existente. `PROBADO` describe pruebas existentes efectivamente conectadas a ese nivel. `PENDIENTE` indica evidencia que aún no existe. `BLOQUEADO_ESPECÍFICO` señala una dependencia externa acotada.

| OperationId                          | Método y endpoint                                                      | Implementación | Guard/autorización                  | Unitarias                                       | HTTP aislada                                          | PostgreSQL real                                     | Gateway real                                                     | Resultado contractual                                                                              | Evidencia faltante al iniciar                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- | -------------- | ----------------------------------- | ----------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `descargarPlantillaProductos`        | `GET /api/v1/carga-masiva/productos/plantilla?formato=CSV\|XLSX`       | IMPLEMENTADO   | `BulkUserBearerGuard`; `userBearer` | PROBADO (CSV/XLSX parser y plantilla)           | PROBADO (CSV y XLSX; formato inválido)              | No aplica                                           | Ruta registrada; E2E pendiente                                | `200`, CSV/XLSX; `400 VALIDACION` para formato inválido                                            | Paso mediante Gateway                                                                           |
| `crearImportacionGeneralProductos`   | `POST /api/v1/carga-masiva/productos/importaciones`                    | IMPLEMENTADO   | Guard real; JWT RS256 local firmado para prueba | PROBADO (parser, servicio y guard) | PROBADO (dobles y PostgreSQL/Storage local) | PROBADO (HTTP→Bulk→Outbox persistida) | Ruta registrada; E2E pendiente | `202` con cuatro campos; errores conforme OpenAPI | Gateway+G7, Supabase real y respuesta Catalog por HTTP; límite 413 sí cubierto en HTTP aislada |
| `obtenerImportacionGeneralProductos` | `GET /api/v1/carga-masiva/productos/importaciones/{batchId}`           | IMPLEMENTADO   | Guard real; JWT RS256 local firmado para prueba | PROBADO (controller y servicio) | PROBADO (dobles y PostgreSQL/Storage local) | PROBADO (lote/resultados durables consultados por HTTP) | E2E pendiente | `200` estado, filas, dominios y errores; `404 LOTE_NO_ENCONTRADO` | Gateway+G7 y Supabase real |
| `descargarReporteImportacionGeneral` | `GET /api/v1/carga-masiva/productos/importaciones/{batchId}/reporte`   | IMPLEMENTADO   | Guard real; JWT RS256 local firmado para prueba | PROBADO parcialmente | PROBADO (dobles y CSV desde resultados PostgreSQL) | PROBADO (reporte HTTP desde fallo durable) | E2E pendiente | `200 text/csv`; `404 LOTE_NO_ENCONTRADO` | Gateway+G7 y Supabase real |
| `reanudarImportacionGeneral`         | `POST /api/v1/carga-masiva/productos/importaciones/{batchId}/reanudar` | IMPLEMENTADO   | Guard real; JWT RS256 local firmado para prueba | PROBADO (repositorio/servicio) | PROBADO (dobles y fallo parcial PostgreSQL) | PROBADO (requeue y rechazo de estado inválido vía HTTP) | E2E pendiente | `202` reanuda lote terminal reconciliable; transición inválida da error contractual | Gateway+G7 y Supabase real |

### Hallazgos transversales

- `apps/bulk-svc/src/bulk-svc.http.spec.ts` cubre multipart CSV, `202`, consulta/reporte/reanudación con dobles, error de formato, archivo no admitido y 10 485 761 bytes (`413`). La ampliación añade HTTP XLSX y rutas conectadas a PostgreSQL local descartable.
- `bulk.repository.integration.spec.ts` ya cubre PostgreSQL 17, integridad de lote, Outbox/Inbox, resultados idempotentes, resultados parciales, reconciliación, requeue e invariantes; las pruebas no atraviesan el controlador HTTP.
- `BulkStorageService` ya verifica bucket privado, carga/lectura/reintento y colisión mediante `fetch` simulado. No hay integración contra Supabase real ni bucket de pruebas autorizado.
- `run-bulk-joint-v2-local.mjs` conserva los casos v1/v2 y ahora añade una admisión CSV v2 por HTTP real de Bulk, con PostgreSQL 17/TLS, RabbitMQ 4.2.9 y consumidor Catalog. Verifica Outbox/Inbox, replay idempotente, resultado por fila y mutación persistida de Catalog. Es una ejecución local descartable, no una prueba Gateway/G7/Supabase.
- Las pruebas unitarias cubren 5 000/5 001 filas y XLSX con expansión superior a 50 MiB. La prueba HTTP aislada cubre 10 485 761 bytes (`413`).
- Gateway tiene cinco rutas Bulk y soporte de multipart en el proxy. No se encontró una configuración de E2E local que pueda probar escrituras con identidad G7 real o con perímetro demo verificado; no se habilitará una escritura anónima con listener accesible externamente.

## Reproducción

La prueba HTTP/PostgreSQL usa NestJS `BulkSvcModule`, repositorios Drizzle y PostgreSQL 17 descartable. El `BulkUserBearerGuard` real valida un JWT RS256 firmado con una clave generada para esa prueba, audiencia `api-productos` y rol `GESTOR_COMERCIAL`; esto valida el guard y la ruta autenticada, pero no acredita una identidad ni configuración G7 real. El servicio de almacenamiento usa `BulkStorageService` real contra un servidor HTTP local que emula las respuestas mínimas de Supabase Storage; esto **no** es una integración con Supabase.

Comandos reproducibles desde la raíz del backend:

```powershell
npm test -- apps/bulk-svc/src/domain/bulk-template-v2.spec.ts
npm run test:e2e -- apps/bulk-svc/test/bulk-postgres-outage.e2e-spec.ts
$env:PATH = 'C:\Program Files\Git\usr\bin;' + $env:PATH
node apps/bulk-svc/test/support/run-bulk-joint-v2-local.mjs
```

La prueba PostgreSQL inicia una instancia desechable, carga la copia del fixture `test/fixtures/0001_create_bulk_persistence.sql` desde la migración oficial inmutable y elimina contenedores/archivos temporales al salir. Usa el módulo Nest real, repositorios Drizzle reales y `BulkUserBearerGuard` con JWT RS256 generado localmente para la prueba. Storage usa un servidor local compatible con las respuestas necesarias; no es Supabase. La prueba conjunta crea un peer temporal solo en `127.0.0.1`, activa flags de demo restringidos únicamente dentro de ese proceso efímero, y conecta Bulk real con PostgreSQL TLS, RabbitMQ y Catalog. No abre listener externo ni valida identidad G7. Evidencia ejecutada sobre la base `51f54ea` más el diff local sin commit:

| Comando | Resultado | Evidencia |
| --- | --- | --- |
| `npm test` | PASS | 171 archivos pasan, 2 saltados; 2 045 pasan, 56 saltados. |
| `npm run test:e2e -- apps/bulk-svc/test/bulk-postgres-outage.e2e-spec.ts` | PASS | 1 archivo, 2 pruebas; HTTP real de Bulk con PostgreSQL descartable, guard activo con JWT RS256 local y Storage compatible local. |
| `node apps/bulk-svc/test/support/run-bulk-joint-v2-local.mjs` (OpenSSL de Git en PATH) | PASS | Casos v1 y v2 existentes y caso nuevo de admisión HTTP v2; 2 pruebas pasan, 90 se saltan en el peer temporal; el caso nuevo registra Inbox, replay y Catalog actualizado. |
| `npm run test:e2e` | FAIL, dos ejecuciones | En una ejecución, el arranque Docker de la suite de Bulk terminó `ETIMEDOUT`; en otra, Catalog `validates the DATA-002 batch in disposable PostgreSQL` excedió el timeout de 5 s. |
| `npm run test:e2e -- --no-file-parallelism` | FAIL | Reproduce el timeout de 5 s de Catalog en `validates the DATA-002 batch in disposable PostgreSQL`; suite completa finalizó, 1 010 pasan y 183 se saltan. |
| `npm run test:e2e -- apps/catalog-svc/test/postgres.persistence.e2e-spec.ts -t "validates the DATA-002 batch in disposable PostgreSQL"` | FAIL | La misma prueba falla aislada en 6 419 ms contra el límite de 5 000 ms; no depende de concurrencia entre archivos. |
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build:bulk-svc`, `git diff --check` | PASS | Ejecutados en este checkout después de los cambios. |

No se modificó Catalog para ajustar su prueba DATA-002. En el run de CI [41741755610](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/41741755610), la prueba `validates the DATA-002 batch in disposable PostgreSQL` pasó en 1 867 ms; falló otra prueba `apps/catalog-svc/test/data002.e2e-spec.ts`. Los logs examinados de CI histórico de Pricing/Price Audit no muestran ese mismo timeout; no se atribuye ni se afirma ese antecedente sin evidencia. La prueba integral Gateway, JWT G7 y Supabase real permanecen pendientes. El estado E2E general local no es PASS y debe validarse en CI sobre el SHA publicado antes del cierre de #96.

## Estados externos y fuera de alcance

- Inventory `inventory.bulk.stock.adjust.requested`: owner Inventory/Taco; afecta solo el ajuste de stock inicial; se desbloquea con contrato AsyncAPI aprobado y prueba bilateral provider/consumer. La importación y resultados CATALOGO continúan de forma independiente.
- Exportación: owner Bulk/Castilla; afecta lecturas consolidadas; se desbloquea con proveedores autorizados de Catalog/Pricing/Inventory y evidencia de snapshot conforme DEC-G6-INT-10. No se presenta como funcional aquí.
- JWT G7: owner G7/Seguridad; afecta la autorización autenticada real; se desbloquea con issuer/JWKS, audiencia, rol/scope y grant efectivos más pruebas positivas y negativas. Los tests locales no sustituyen esos datos.
- Supabase de prueba: owner Marco/infraestructura; afecta validación contra el servicio real; se desbloquea al autorizar un proyecto/bucket privado descartable y sus credenciales restringidas. La API-compatible local solo acredita el adaptador.
- Gateway E2E: owner Gateway/Marco (#21); afecta solo la ruta integral cliente→Gateway→Bulk; se desbloquea con un proceso Gateway y Bulk en perímetro de prueba aislado o credenciales G7 auténticas con configuración autorizada. No requiere cambios Gateway para completar la suite HTTP propia de Bulk.

La cobertura restante de #90 (reglas), #91 (consultas), #92 (escrituras) y #93 (AMQP) se limita a criterios no acreditados por las pruebas enumeradas aquí. #95 requiere la integración real frontend→Gateway; no está en ownership de esta entrega.
