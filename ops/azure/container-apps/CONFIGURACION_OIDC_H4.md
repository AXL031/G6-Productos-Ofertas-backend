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

**Límite importante del RBAC:** `Microsoft.App/containerApps/write` autoriza escrituras sobre el recurso Container App y por sí sola no restringe esas escrituras al campo de imagen. Una identidad que pueda ejecutar `az containerapp update` con ese permiso puede intentar cambiar ingress, secretos, variables de entorno, escala y otras propiedades admitidas por la API/CLI. Omitir acciones específicas de secretos o ingress no constituye una barrera fiable si el permiso genérico de escritura ya permite actualizar el recurso.

El rol personalizado reduce el alcance mediante scope al resource group y omite creación/borrado y permisos de otros proveedores, pero **no** impone una política de “solo image”. Compleméntese con: environment GitHub protegido y restringido a `master`, revisor requerido, identidad federada dedicada a ese environment, workflow revisado y validado, concurrencia, ejecutor que solo envía `--container-name/--image`, comparación before/after de la plantilla/configuración completa y parada ante diferencias. Estas son defensas de proceso y del ejecutor, no una restricción de campo aplicada por Azure RBAC. Use Azure Policy/controles de gobernanza si la organización necesita impedir cambios concretos en el plano Azure; confirme que la política cubre las operaciones de actualización de ACA antes de confiar en ella.

No otorgar create/delete ni acciones de otros proveedores; mantener el scope exacto al resource group. No usar `Owner`, `Contributor` ni `Container Apps Contributor` por defecto. Antes de activar el workflow, el owner debe revisar las operaciones exactas en Azure Activity Log y validar el rol con una prueba controlada.

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

Al configurar OIDC, ejecutar primero un `workflow_dispatch` para `api-gateway` desde `master` y un SHA idéntico a la punta con CI exitosa. Aprobar el environment; comprobar en el run el digest, revisión, imagen efectiva, salud ACA, comparación de configuración y smoke HTTPS. Para Gateway se verifica el sidecar `caddy` antes y después. La prueba local con Azure CLI simulado no sustituye esa primera integración autenticada.

Los recibos temporales del workflow contienen únicamente el nombre del servicio, los digests anterior/aplicado y un SHA-256 de la configuración normalizada. Si falla una revisión, otro servicio o el smoke Marketplace, la recuperación coordinada restaura cada servicio solo si la imagen actual sigue siendo el digest aplicado y la configuración persistente coincide con la huella previa. Si falta esa condición, no escribe en ACA: el run marca recuperación no verificada y pide revisar manualmente el digest/configuración antes de restaurar. No considerar el smoke fallido como despliegue recuperado hasta que la verificación de revisión y configuración confirme la imagen previa.

El estado activo/`Running`/`Healthy` de la revisión verifica el plano ACA y las probes del contenedor; no demuestra que el servicio esté listo para negocio ni que sus dependencias respondan. El smoke HTTPS de cinco lecturas Gateway/Catalog/Taxonomy es una comprobación funcional distinta. Los bloqueos conocidos para una futura operación manual de los nueve servicios deben seguir visibles: Pricing (owner vera: `scheduled_prices.product_id` y revisión del requisito `config.auth`), Price Audit (owner vera: `price_audit_log.target_type`) y Bulk (owner castilla: `export_jobs.claim_token` y conexión/topología/ACL AMQPS). Resolver cada bloqueo requiere cambio autorizado del owner correspondiente y verificación de readiness/operación. El workflow no los reporta como readiness de negocio.

## Fuentes oficiales

- [Configurar OpenID Connect en Azure desde GitHub Actions](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [CLI de Azure Container Apps: `az containerapp update`](https://learn.microsoft.com/en-us/cli/azure/containerapp?view=azure-cli-latest)
- [Roles integrados de Azure para contenedores](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers)
- [Asegurar despliegues de Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/secure-deployment)
