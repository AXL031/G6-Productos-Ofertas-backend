# Validación local Promotions H5

Fecha: 2026-11-18. Rama: cueva. HEAD base: 8bf6b6ecf3e60730c945fe707769f95ffa450a8e. Cambios de esta tarea todavía sin commit; estos resultados corresponden al árbol de trabajo, no a un SHA desplegado. Antecedente funcional: Backend #75. Coordinación transversal: Backend #242, G5 #64 y G7 #107.

## Comandos y resultados

| Comando | Resultado ejecutado |
|---|---|
| npm test -- --maxWorkers=2 | PASS: 2659 pruebas; 73 omitidas; 224 archivos aprobados y 2 omitidos |
| npm run test:e2e -- --maxWorkers=2 | PASS: 1046 pruebas; 270 omitidas; 39 archivos aprobados y 21 omitidos |
| node apps/promotions-svc/test/run-h5-postgres.mjs | PASS: 3 pruebas reales sobre PostgreSQL 17 local descartable; limpieza del contenedor propio confirmada |
| npm run typecheck | PASS |
| npm run build:promotions-svc | PASS |
| npm run lint | PASS, con 4 advertencias preexistentes en Bulk y Promotions; ninguna advertencia nueva |
| npm run format:check | PASS |
| git diff --check -- apps/promotions-svc | PASS |

La primera ejecución general encontró OpenSSL fuera del PATH y Docker Desktop detenido. Se utilizó el OpenSSL instalado en Git y se inició Docker Desktop en segundo plano; las ejecuciones generales posteriores terminaron con código 0. No se modificó código de otros servicios para corregir esas condiciones del entorno. Los skips de las suites generales no se cuentan como pruebas ejecutadas. La suite PostgreSQL H5 requiere opt-in y por ello se ejecutó también por separado mediante su runner.

## Evidencia cubierta

- Eventos internos: selección de transporte, identidad explícita en producción, tres colas y cuatro eventos asignados, rechazo de metadatos incompatibles, commit antes del settlement, duplicados por el dispatcher existente, fallos de enlace y cierre.
- Núcleo candidato: admisión y Outbox atómicos, idempotencia y conflictos, recuperación de receipts H4 sin otra intención, consulta acotada por actor/pedido, proyección de resultado, envío ambiguo y límite del SDK, resultado persistido antes de completar.
- SQL real: rollback cuando falla la intención, reclamos concurrentes, exclusión por token, lease vencido y conservación del envío pendiente. La fixture usa una cuenta administradora local y un receipt histórico mínimo: no acredita grants mínimos, TLS, todas las migraciones ni el flujo comercial completo.
- HTTP: la aplicación Nest confirma que las tres rutas candidatas siguen respondiendo 404. No se publicaron endpoints nuevos ni se registró el worker candidato en producción.
- Preservación: se compararon hashes SHA-256 de los 72 archivos previos del checkout contra AUDITORIA_INICIAL.json; permanecen intactos. No se modificó el índice, la rama ni el HEAD.

## Estados independientes

| Estado | Resultado |
|---|---|
| Implementación interna de eventos | Implementada y validada localmente |
| Implementación candidata de cupones | Parcial: núcleo y SQL candidato probados; adaptador HTTP, fuente autoritativa y arranque productivo pendientes |
| Integración autenticada Azure/G7/G5 | NO EJECUTADA |
| Homologación externa | PENDIENTE de respuestas verificables a los issues de coordinación |
| Aplicación SQL compartida, grants y despliegue | NO EJECUTADOS |
| Publicación del cambio de código | Sin commit, push ni PR de esta entrega |

No se habilitaron campañas, productores compartidos ni el flujo candidato de cupones. No se tocó el namespace piloto, no se aplicó SQL a Supabase y no se consumieron mensajes productivos. La activación requiere cerrar las dependencias concretas de H5-SERVICE-BUS.md y asociar las evidencias operativas al SHA que finalmente se revise y despliegue.
