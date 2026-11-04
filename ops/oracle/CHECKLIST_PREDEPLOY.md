# Checklist de preparación predeploy

Un PASS requiere evidencia reproducible ligada a SHA y alcance. Si un gate aplica y su dependencia falta, marcar `BLOCKED`/`PARTIAL`, nunca PASS. Solo READY_FOR_DEPLOY con todos los gates aplicables cerrados; todavía requiere autorización individual de Marco.

| Gate | Evidencia comprobable | Resultado |
|---|---|---|
| Ownership/contrato | Rama y issue correctos; OpenAPI/AsyncAPI, DEC-F/ADR y versiones citadas; ninguna discrepancia contractual sin resolver | ☐ |
| Build/artifact | `npm ci`; build del servicio y verificación de su `main.js`. Si usa `Dockerfile.service`, ejecutar `bash ops/oracle/build-service.sh <service>` y verificar también `dist/apps/g6-service-entrypoint.mjs`, que es el CMD de esa imagen. Si usa `Dockerfile.inventory-svc`, verificar `dist/apps/inventory-svc/main.js`, que es su CMD; no exigir el wrapper genérico. En ambos casos comprobar que el artefacto verificado coincide con el entrypoint real de la imagen | ☐ |
| Calidad | `npm run typecheck`, `npm run lint`, `npm test -- <scope>` o comando exacto existente; resultados y skips explicados | ☐ |
| Puerto/config | Ficha completa; env vars respaldadas por parser; `PORT` y variable del registro coinciden; validación bootstrap; valores secretos ausentes de logs/docs | ☐ |
| Compose/imagen | `docker compose ... config --quiet` con Compose/base+overlay aplicables y runtime fixture; build `Dockerfile.service` o `Dockerfile.inventory-svc`; usuario/healthcheck/loopback correctos | ☐ |
| Health/readiness | `/health` 200 liveness; readiness honesta con dependencia disponible e inaccesible (503 en falla); no fixture productiva ni mock silencioso | ☐ |
| PostgreSQL/TLS | Base desechable real, CA y `verify-full`, schema/rol esperados, consultas mínimas y transacciones; migración separada, no ejecutada por bootstrap | ☐ |
| Rabbit/red | AsyncAPI/topología reconciliados; aliases y conectividad probados desde contenedor aislado; permisos mínimos, ACK/idempotencia; retry/DLX solo si aprobado | ☐ |
| HTTP/auth | Gateway route, origen y timeout; JWT/JWKS/scopes del contrato; pruebas 2xx, 4xx, 5xx y auth sin efectos remotos destructivos | ☐ |
| CI | CI exitosa para SHA; identificar alcance real, skips y gates faltantes; no equiparar build con smoke integral | ☐ |
| Recuperación | Si existe imagen anterior: identificarla y ensayar restauración en Compose aislado. En primer despliegue sin imagen anterior: simular en entorno aislado el fallo de arranque, detener y retirar únicamente el contenedor/proyecto de aplicación recién creado, conservar datos/redes compartidas y verificar estado previo sin servicio; documentar recuperación y evidencia. No presentar esto como rollback remoto probado en Oracle. Prohibido `down -v` o cambios globales. | ☐ |
| Red/operación | loopback, `g6-http`/`g6-edge` correctos; dependencias no alcanzables declaradas; runtime privado existe sin revelar valores; release individual autorizada | ☐ |
| Evidencia final | Informe compactado abajo ligado a SHA/CI/artefactos | ☐ |

## Plantilla de entrega a Marco

```text
Servicio / owner:
Issue / rama / SHA:
Contrato HTTP (versión/SHA) / AsyncAPI (versión/SHA) / DEC-F-ADR:
Build / typecheck / lint / tests (comandos y resultados):
Integración local real (dependencias, versiones, evidencia):
Imagen + Compose equivalentes y health/readiness:
Variables runtime requeridas (nombres, suministrador; ningún valor):
Dependencias físicas / configuradas / probadas:
Auth, red y permisos pendientes:
Despliegue remoto / smoke (si autorizado; deployment ID y SHA):
Bloqueos, owner responsable y criterio verificable para cerrar:
Estado: READY_FOR_DEPLOY | PARTIAL | BLOCKED
Marco debe hacer:
El desarrollador ya dejó resuelto:
```

**READY_FOR_DEPLOY** exige todos los gates aplicables con PASS, CI sobre el SHA y plan de recuperación que cubra primer despliegue y actualización. La autorización de release sigue aparte. No uses “probado” para lint, tests unitarios o documentación solamente.

## Gates CI de mayor impacto propuestos (sin implementación en esta tarea)

Prioridad para Issue transversal: bloquear el merge/entrega si (1) variables obligatorias/condicionales del parser no corresponden a `runtime.env`/Compose; (2) puertos, entrypoint, health/readiness o redes difieren entre registry, Dockerfile, Compose y código; (3) rutas, operación, auth o esquema HTTP no corresponden al OpenAPI; (4) nombres de mensajería del candidato no son compatibles con AsyncAPI oficial y topología física. Añadir pruebas de imagen y readiness con dependencias desechables, manteniendo skips explícitos. Para Rabbit, el gate de compatibilidad debe ser bloqueante y señalar el conflicto, no “arreglarlo” automáticamente ni declarar un candidato homologado. Propuesta documental; no se modificó workflow ni CI en esta tarea.

## Auditoría de cobertura CI observada

Fuente: `.github/workflows/ci.yml` en `f418cf335007bed9397d5d5d30c36183fe47517c`. Evaluación estática contrastada con CI del SHA exacto: GitHub Actions run `39347193787` finalizó `success`. Esa ejecución valida el workflow vigente de backend, no readiness remota.

| Control solicitado | ¿CI lo detecta hoy? | Evidencia y límite |
|---|---|---|
| Puerto vs manifiesto | Parcial / sí para Compose | workflow valida puerto, env específica, loopback, CA y alias contra `services.psv`; `grep` chequea precedencia en Inventory. No extrae automáticamente el puerto efectivo de los nueve `main.ts`. |
| Build sin entrypoint | Parcial | comprueba `dist/apps/<service>/main.js`, construye Dockerfile genérico y verifica Gateway readiness bundle. No hay aserción por servicio del `dist/apps/g6-service-entrypoint.mjs` exacto que genera el script. |
| Healthcheck incorrecto | Parcial | Compose estático exige `/health` genérico y comando readiness del Gateway; Docker smoke a `/health` para servicios dependency-free e Inventory. Catalog/Taxonomy runtime smoke se omite; no verifica que `/health` implique únicamente liveness/readiness correcta. |
| Variables obligatorias omitidas | Parcial | `invalid-startup.mjs` y tests cubren arranques inválidos seleccionados; no prueba exhaustivamente cada env obligatoria de los nueve desde su parser con tabla fuente. |
| Dependencias Docker mal declaradas | Parcial | `docker compose config`, alias, redes, ports y CA se validan; no prueba el alcance completo de dependencias de aplicación o su conectividad permitida. |
| Incompatibilidad AMQP | No | no hay integración común RabbitMQ/AsyncAPI/nombres/permisos para los productores/consumidores; CI no detecta drift físico-contractual. |
| Mocks productivos | No exhaustivo | no se ve gate estático completo que prohíba fallback/mock de producción; tests unitarios sí usan dobles legítimos. |
| Regresión de contrato de integración | No exhaustivo | hay tests de app, no gate global de diff/compatibilidad OpenAPI/AsyncAPI y rutas/scopes por consumidor. |

La CI actual también ejecuta una simulación aislada de deploy/rollback (`ops/oracle/tests/deploy-g6-service.test.sh`) y verifica selección/recuperación del CD con mocks. Esto no demuestra que la recuperación remota se haya ejecutado en Oracle. Para un primer despliegue sin imagen previa se conserva el gate de simular fallo y retirar únicamente el contenedor/proyecto recién creado en Compose aislado; los datos y redes compartidas deben quedar intactos y adjuntarse evidencias.

Esta matriz distingue validación declarativa de conectividad funcional y no implica que se ejecutó CI durante la tarea.
