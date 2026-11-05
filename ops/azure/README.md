# Adaptación de Despliegue en Azure (`api-gateway`, `taxonomy-svc`, `catalog-svc`)

Este directorio contiene la adaptación hacia **Microsoft Azure (Suscripción Azure for Students)** tomando como referencia normativa la infraestructura de `ops/oracle/`.

## 1. Principios y Restricciones Respetadas

1. **Cero modificación de contratos y permisos externos**:
   - No se altera `openapi.yaml`, `asyncapi.yaml` ni esquemas/roles/grants de Supabase PostgreSQL.
   - No se modifican los archivos originales de `ops/oracle/`.
2. **Protección de presupuesto en Azure for Students**:
   - Selección prioritaria de tamaños burstable elegibles en capa gratuita estudiantil (`Standard_B1s` — 750 h/mes en Azure for Students — o `Standard_B2ats_v2` / `Standard_B2s` según disponibilidad regional).
   - Disco de sistema `StandardSSD_LRS` de 30 GiB (evitando `Premium_LRS`).
   - Configuración automática de **2 GiB de swap** en la VM para soportar compilación Docker y ejecución concurrente de Caddy + 3 contenedores Node.js sin agotar RAM.
   - Uso del DNS gratuito de Azure (`<dns-label>.<region>.cloudapp.azure.com`) en la IP pública para que **Caddy** obtenga certificados TLS válidos de Let's Encrypt sin costo de dominio.
   - Emisor OIDC/JWKS simulado de Fase 2 (`SIMULATED_AUTH`, `demo-jwt-issuer.mjs`): **nunca se publica en Internet ni en Caddy público**; se ejecuta exclusivamente en loopback (`127.0.0.1` / `::1`) para pruebas aisladas, exigiendo secreto administrativo (`adminSecret >= 16 chars`, `timingSafeEqual`) y credenciales M2M explícitas.

---

## 2. Tabla de Diferencias: Oracle Cloud vs. Azure

| Componente / Control | Oracle Cloud (`ops/oracle/`) | Azure (`ops/azure/`) |
|---|---|---|
| **VM y SO** | Ubuntu 24.04 LTS en OCI (4 vCPU, 11 GiB RAM) | Ubuntu 24.04 LTS en Azure (`Standard_B1s` / `Standard_B2s` + 2 GiB swap) |
| **Firewall de Red** | OCI Security Lists + Tailscale (`100.87.22.28`) | Azure NSG: permite entrada pública solo en `TCP 80`, `TCP 443` y `TCP 22`. Puertos `3000`, `3001`, `3006` ligados únicamente a `127.0.0.1`. |
| **Terminación HTTPS** | Caddy en `g6-edge` con DuckDNS (`g6-productos-ofertas.duckdns.org`) | Caddy en `g6-edge` con FQDN nativo de Azure (`<label>.<region>.cloudapp.azure.com`) y certificado Let's Encrypt automático. |
| **Redes Docker Internas** | `g6-edge` (Caddy + Gateway) y `g6-http` (Gateway + microservicios) | **Idénticas**: `g6-edge` y `g6-http` con los mismos aliases (`g6-api-gateway`, `api-gateway`, `catalog-svc`, `taxonomy-svc`). |
| **PostgreSQL + TLS** | Supabase con CA `/etc/g6-postgres/supabase-server-root.crt` montada en `/run/g6-certs/supabase-server-root.crt:ro` | **Idéntico**: `PGSSLMODE=verify-full`, misma ruta de CA montada `:ro` y validación `verifyIdentity()` con `catalog_dev_login` y `taxonomy_dev_login`. |
| **Ejecutor y Rollback** | `ops/oracle/deploy-g6-service.sh` (fijo a `ghcr.io/taller-sw-web/...`) | `ops/azure/deploy-g6-service.sh`: conserva registro v2, `flock`, validación `g6-http`, healthchecks y rollback a `previous-image`, permitiendo prefijo de imagen configurable (`G6_REGISTRY_PREFIX`) y soporte de imágenes ya presentes en el daemon local (`G6_SKIP_PULL_IF_LOCAL=true`). |

---

## 3. Flujo de Ejecución Paso a Paso

### Paso 1: Aprovisionar la VM en Azure (desde Windows PowerShell)
```powershell
pwsh ./ops/azure/provision-azure-vm.ps1 `
  -ResourceGroupName "rg-g6-productos-azure" `
  -VmName "vm-g6-backend" `
  -DnsLabel "g6-productos-cueva"
```
> Si prefieres validar primero sin crear recursos en Azure, añade `-DryRun`.

### Paso 2: Inicializar el Host en la VM de Azure
Copia el repositorio (o carpeta `ops/`), tu certificado CA de Supabase (`prod-ca-2021.crt`) y ejecuta en la VM:
```bash
sudo bash ops/azure/bootstrap-vm.sh \
  --domain "<dns-label>.<region>.cloudapp.azure.com" \
  --ca-file /tmp/prod-ca-2021.crt
```

### Paso 3: Configurar `/etc/g6-<servicio>/runtime.env`
Completa las credenciales de `taxonomy_dev_login` y `catalog_dev_login` en:
- `/etc/g6-taxonomy-svc/runtime.env`
- `/etc/g6-catalog-svc/runtime.env`
- `/etc/g6-api-gateway/runtime.env`

### Paso 4: Construir Imágenes por SHA y Desplegar con Rollback Habilitado
En la VM (o publicando desde GHCR):
```bash
sudo bash ops/azure/build-and-deploy-three.sh
```

### Paso 5: Verificar Salud, Readiness, HTTPS y Rollback
```bash
sudo bash ops/azure/test-rollback-and-phases.sh
```

---

## 4. Controles de Seguridad Progresiva (`G6_SECURITY_MODE`) y Comunicación `Catalog -> Taxonomy`

1. **Fase 1 (`PUBLIC_READ_ONLY`) sin operaciones públicas automáticas**:
   - Dado que `MATRIZ-OPERACIONES-SEGURIDAD-G6.md` registra actualmente `0 PUBLICA_APROBADA`, activar `G6_SECURITY_MODE=PUBLIC_READ_ONLY` sin configurar explícitamente `GATEWAY_PUBLIC_OPERATION_IDS`, `CATALOG_PUBLIC_OPERATION_IDS` y `TAXONOMY_PUBLIC_OPERATION_IDS` mantiene **0 operaciones públicas habilitadas** (fail-closed).
   - Solo las operaciones `GET` cuyos `operationId` se declaren explícitamente en cada servicio se habilitan; toda escritura (`POST`, `PATCH`, `PUT`, `DELETE`) es rechazada con `403 SCOPE_INSUFICIENTE`.
2. **`taxonomy-svc` nunca concede acceso por IP privada**:
   - Provenir de una IP privada RFC1918 (`10.x`, `172.16-31.x`, `192.168.x`) no otorga acceso en ninguna fase.
   - `ALLOW_DEMO_UNAUTHENTICATED=true` continúa restringido a `NODE_ENV=test|development` y loopback (`127.0.0.1` / `::1`).
3. **Comunicación `Catalog -> Taxonomy` por fase**:
   - **Fase 1 (`PUBLIC_READ_ONLY`)**: en lecturas públicas explícitamente aprobadas (`obtenerProductoPorSlug`, `listarProductos`), `TaxonomyClient` invoca `GET http://taxonomy-svc:3006/api/v1/marcas` (`listarMarcas`) o `/api/v1/categorias` (`listarCategorias`) sin JWT; `taxonomy-svc` solo responde `200` si dichos `operationId` están explícitamente en `TAXONOMY_PUBLIC_OPERATION_IDS` (de lo contrario responde `401` y `catalog-svc` falla cerrado con `503`).
   - **Fase 2 (`SIMULATED_AUTH`)**: con token M2M (`modulo-marketplace`), `TaxonomyClient` propaga `Authorization: Bearer <service-jwt>` hacia `GET /api/v1/marcas` (`TaxonomyAuthGuard`); con token humano (`GESTOR_COMERCIAL`), `TaxonomyClient` propaga `Authorization: Bearer <user-jwt>` hacia `GET /api/v1/marcas/{id}` (`TaxonomyUserGuard`); en mutaciones, `CatalogMasterClient` + `CatalogBulkIdentity` obtienen un token M2M propio (`modulo-productos`) vía `POST /api/v1/auth/token`.
   - **Fase 3 (`G7_AUTHENTICATED`, por defecto)**: idéntico a Fase 2 pero verificando emisores y JWKS reales de G7 (`Auth/Users`).
