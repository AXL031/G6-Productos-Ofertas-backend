# Configuración externa de CD Azure H4

Estado de esta entrega: el repositorio contiene el camino de CI → GHCR → Azure y validaciones locales simulables. El despliegue remoto queda pendiente hasta que el propietario de la suscripción prepare la identidad federada, permisos y entorno GitHub `azure-h4`; el workflow falla cerrado si esa configuración no existe.

El `README.md` y `verification-2026-11-06.json` vecinos registran una preparación/candidato anterior que decía que ACA aún no existía. No se usan como evidencia del estado actual: este alcance toma como contexto de despliegue la verificación de nueve ACA en `rg-g6-aca-chile` incluida en la solicitud de Hito 4. La primera ejecución autenticada debe comprobar el nombre de cada app/contenedor contra Azure antes de actualizar; no crear aplicaciones para compensar discrepancias.

## 1. Identidad federada Microsoft Entra

Crear o reutilizar una aplicación de Entra ID y su service principal dedicado solo a este CD. Registrar una credencial federada con:

| Propiedad | Valor |
| --- | --- |
| Issuer | `https://token.actions.githubusercontent.com` |
| Audience | `api://AzureADTokenExchange` |
| Subject | `repo:Taller-SW-Web/G6-Productos-Ofertas-backend:environment:azure-h4` |

La relación de confianza debe limitarse al repositorio oficial y al environment `azure-h4`. Configurar ese environment para permitir despliegues únicamente desde `master`, activar aprobación de un revisor del equipo de infraestructura y evitar que ramas de PR/forks accedan a él. La validación del workflow vuelve a comprobar el repositorio, el SHA, la punta de `master` y la CI exacta antes de publicar y antes de desplegar.

## 2. RBAC de Azure

Asignar a la identidad dedicada un rol personalizado en el scope exacto:

`/subscriptions/<suscripción-propietaria>/resourceGroups/rg-g6-aca-chile`

Acciones de control plane requeridas por `az containerapp show`, lectura de revisión y `az containerapp update`:

```json
{
  "Actions": [
    "Microsoft.App/containerApps/read",
    "Microsoft.App/containerApps/write",
    "Microsoft.App/containerApps/revisions/read",
    "Microsoft.App/managedEnvironments/read",
    "Microsoft.Resources/subscriptions/resourceGroups/read"
  ],
  "NotActions": [],
  "DataActions": [],
  "NotDataActions": []
}
```

No otorgar create/delete, lectura de valores de secretos, modificación de secretos, cambios de entorno, red, ingress, certificados, escalado o migraciones. La asignación se limita al grupo indicado. Si la validación real de Azure CLI detecta una acción adicional, el propietario debe comprobar la operación exacta con Azure Activity Log y ampliar el rol de forma puntual, sin usar `Owner`, `Contributor` ni `Container Apps Contributor` por defecto. Microsoft documenta que `Container Apps Contributor` incluye permisos amplios, incluso acciones de borrado; se recomienda privilegio mínimo y rol personalizado.

Las ACA deben poder descargar GHCR usando la configuración/identidad ya existente. Este CD no cambia credenciales de registry ni parámetros privados. Si Azure no puede extraer la imagen, el despliegue se detendrá y hará rollback verificado cuando Azure acepte la imagen anterior.

## 3. GitHub

Crear el environment `azure-h4`, restringirlo a `master` y definir como required reviewer al owner Azure. Añadir estas **variables** (no son secretos):

| Nombre | Valor |
| --- | --- |
| `AZURE_CLIENT_ID` | Application (client) ID de la identidad federada |
| `AZURE_TENANT_ID` | Directory (tenant) ID de Entra |
| `AZURE_SUBSCRIPTION_ID` | Subscription ID propietaria de `rg-g6-aca-chile` |

No se requieren secretos Azure, claves de service principal ni credenciales persistentes. El nombre del resource group está fijado en el ejecutor y no es un input. El subscription ID solo se configura en el environment como variable de propietario y el workflow no ofrece una entrada para cambiarlo.

Dar al `GITHUB_TOKEN` del repositorio permisos de lectura de Actions y escritura de Packages para este workflow. La etapa de preparación solo usa `actions: read`, `contents: read`; publicar solo añade `packages: write`; el job Azure recibe `id-token: write`, `actions: read` y `contents: read`.

## 4. Operación y comprobación

Al configurar OIDC, ejecutar primero un `workflow_dispatch` para `api-gateway` desde `master` y un SHA idéntico a la punta con CI exitosa. Aprobar el environment; comprobar en el run el digest, revisión, imagen efectiva, salud ACA, comparación de configuración y smoke HTTPS. Para Gateway se verifica el sidecar Caddy antes y después. La prueba local con Azure CLI simulado no sustituye esa primera integración autenticada.

El estado activo/`Running`/`Healthy` de la revisión verifica el plano ACA y las probes del contenedor; no demuestra que el servicio esté listo para negocio ni que sus dependencias respondan. El smoke HTTPS de cinco lecturas Gateway/Catalog/Taxonomy es una comprobación funcional distinta. Los bloqueos conocidos para una futura operación manual de los nueve servicios deben seguir visibles: Pricing (owner vera: `scheduled_prices.product_id` y revisión del requisito `config.auth`), Price Audit (owner vera: `price_audit_log.target_type`) y Bulk (owner castilla: `export_jobs.claim_token` y conexión/topología/ACL AMQPS). Resolver cada bloqueo requiere cambio autorizado del owner correspondiente y verificación de readiness/operación. El workflow no los reporta como readiness de negocio.

## Fuentes oficiales

- [Configurar OpenID Connect en Azure desde GitHub Actions](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [CLI de Azure Container Apps: `az containerapp update`](https://learn.microsoft.com/en-us/cli/azure/containerapp?view=azure-cli-latest)
- [Roles integrados de Azure para contenedores](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers)
- [Asegurar despliegues de Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/secure-deployment)
