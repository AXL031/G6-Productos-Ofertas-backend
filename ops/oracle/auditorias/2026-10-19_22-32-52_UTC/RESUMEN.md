# Auditoría Oracle — resumen ejecutivo

## Trazabilidad

- ID: `G6-ORACLE-20261019T223252Z`.
- Observación: 2026-10-19 22:32:52–22:36:19 UTC / 17:32:52–17:36:19 Lima.
- Host: `g6-po-vcn`, destino SSH `157.137.205.218`; OS Ubuntu 24.04.5 LTS.
- Identidad host: `StrictHostKeyChecking=yes`; fingerprint ED25519 coincide con el conocido: `SHA256:dVru76PK60yqZRYHUVtNNPUSYLtbS6ZE24mF0S/BhGY`.
- Rama backend: `castilla`, SHA `9fb59128da489f4173e97739c3d27e459087ead2`.
- `origin/master` local y GitHub al consultar: `9205eb455c4965a82ccb9fc4714cf976e4c059b0`.
- Dictamen: **PARCIAL**. Taxonomy sirve una lectura comercial y supera readiness comprobable; Gateway no está listo, cinco servicios están ausentes y Catalog readiness falla.

## Hallazgo central

La VM cambió desde el corte del 17 de octubre: hay cuatro servicios HTTP G6 desplegados además de Caddy y RabbitMQ. No está todo operativo. Gateway aparece `unhealthy` porque Catalog devuelve `503` en readiness; Pricing es parcial; Taxonomy permite `GET /api/v1/categorias` y su readiness responde 200. Caddy expone HTTPS válido y dirige rutas configuradas a Gateway, pero el handler de respaldo devuelve 503 estático.

## Matriz rápida

| Área | Resultado observado | Fuente | Estado |
|---|---|---|---|
| VM / Docker | 4 vCPU, 11 GiB RAM, 40 GiB libres, Docker 29.9.0 / Compose 5.6.0 | SSH, `free`, `df`, Docker | CONFIRMADO |
| Servicios HTTP | Gateway/Catalog/Pricing/Taxonomy presentes; cinco ausentes | `docker ps -a`, listeners y probes | CONFIRMADO |
| API | Categorías 200 por HTTPS/Gateway; otras rutas auth 401 o catch-all 503 | GET local y público | CONFIRMADO en paths probados |
| Caddy/TLS | DNS a VM; HTTP 308, HTTPS TLS válido y 503 en raíz | DNS, `curl`, OpenSSL | CONFIRMADO |
| RabbitMQ | 4 exchanges aplicación, 11 colas quorum, 57 bindings, 0 mensajes/consumidores/conexiones | `rabbitmqctl` | CONFIRMADO |
| Retry/DLX | exchanges/colas/policies no presentes | `rabbitmqctl list_*` | BLOQUEADO |
| CI/CD | manual nueve registrados; automático nueve `false`; cuatro Deployments success | checkout y GitHub API | CONFIRMADO |
| Supabase | CA presente; Taxonomy readiness 200; Catalog readiness 503 | metadata y probes | Parcial / NO_VERIFICADO por servicio |
| OCI perimeter | NSG/Security Lists no consultadas | sin acceso OCI en esta sesión | NO_VERIFICADO |

## Diferencias respecto al 17 de octubre

El reporte histórico registró solo Caddy/RabbitMQ, ausencia de Gateway/Catalog/Taxonomy, `g6-http` ausente y Caddy sin upstream. Esos hechos siguen siendo históricos válidos. El corte actual observa cuatro aplicaciones, `g6-http` con cuatro miembros y Caddy con `reverse_proxy` selectivo; su catch-all sigue siendo estático. La topología Rabbit base sigue en nombres españoles. Los diez documentos históricos no fueron modificados.

## Hallazgos priorizados

- **P1:** Catalog readiness `503` vuelve al Gateway unhealthy.
- **P1:** retry/DLX sigue ausente y hay nombres incompatibles en la descripción candidata; no se aprovisionó.
- **P1:** cinco servicios están ausentes; no hay evidencia de stack completo.
- **P2:** Pricing readiness 200 sin GET funcional ni ruta Gateway demostrada; readiness Gateway lo marca `not_configured`.
- **P2:** NSG/Security Lists y rollback ensayado no verificados.
- **P3:** no hay swap; no se observó presión y no se midió carga representativa de nueve servicios.

Ver [hallazgos](HALLAZGOS.md), [RabbitMQ](RABBITMQ.md), [CI/CD](CICD.md) y [evidencias/limitaciones](EVIDENCIAS.md).
