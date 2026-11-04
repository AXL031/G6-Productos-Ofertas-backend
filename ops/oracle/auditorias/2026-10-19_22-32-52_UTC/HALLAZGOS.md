# Hallazgos priorizados

Las acciones son propuestas para una ventana posterior autorizada; no se ejecutaron.

## P1

### H-01 — Catalog readiness falla y Gateway queda unhealthy

- **Evidencia:** Gateway readiness indica Catalog `not_ready`, Taxonomy `ready`, otros upstreams `not_configured`; Catalog `/health/ready` devuelve 503 aunque el healthcheck Docker de Catalog solo prueba `/health` y sale healthy.
- **Impacto:** no se demuestra readiness del Gateway ni funcionalidad completa; liveness 200 no basta.
- **Acción/owner:** owners de Catalog/Gateway e infraestructura deben diagnosticar la readiness sin exponer secretos y aportar lectura válida.
- **Cierre:** readiness de Catalog y Gateway 200/healthy, más smoke GET autenticado permitido por contrato.

### H-02 — Retry/DLX no aprovisionado y referencias no coherentes

- **Evidencia:** no hay exchanges/colas/policies/parameters retry-DLX; AsyncAPI mezcla referencias `po.catalog.q` con cola principal `po.catalogo.q`; no se encontraron nombres ingleses citados en `backend/apps`/`ops`.
- **Impacto:** no está disponible el patrón técnico de retry/DLX descrito en la documentación candidata.
- **Acción/desbloqueo:** owners del contrato/topología resuelven nombres y gate; aprobación aplicable y prueba segura antes de aprovisionar. No cambiar broker unilateralmente.

### H-03 — Cinco servicios registrados están ausentes

- **Evidencia:** sin contenedores/listeners para Price Audit, Promotions, Inventory, Combos y Bulk; CD automático continúa deshabilitado.
- **Impacto:** no se demuestra backend de nueve componentes para Hito 4.
- **Acción:** desplegar cada servicio tras autorización con CI por SHA, runtime, readiness y smoke GET verificados.

## P2

### H-04 — Pricing readiness no acredita función integrada

- **Evidencia:** `/health/ready` devuelve 200, pero no se confirmó GET comercial ni ruta Gateway; readiness de Gateway lo marca `not_configured`.
- **Acción:** owners Gateway/Pricing acuerdan y verifican upstream, dependencias y smoke.

### H-05 — NSG/Security Lists OCI no observadas

- **Evidencia:** host/firewall local consultados; desde equipo externo TCP 22/80/443 alcanzables, 3000/5672 expirados; no se usó acceso OCI.
- **Acción:** owner OCI revisa reglas. No extrapolar reglas del host a OCI.

### H-06 — Rollback configurado, no ensayado

- **Evidencia:** ejecutor v4 y marcadores presentes; previous coincidía con active en Gateway/Pricing. No hubo ejecución de rollback.
- **Acción:** validar mediante procedimiento en ventana aprobada y registrar SHA/resultado.

## P3

### H-07 — Sin swap y capacidad de nueve servicios no medida

- **Evidencia:** 4 vCPU, 11 GiB RAM, 10 GiB disponibles, 40 GiB libres, carga baja, swap 0.
- **Impacto:** no hay presión actual; no se midió carga completa.
- **Acción:** owner define límites/capacidad y evalúa bajo carga autorizada.
