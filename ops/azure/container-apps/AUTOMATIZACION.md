# Despliegue manual de Azure Container Apps desde el fork

Esta automatización opera los nueve recursos existentes de `rg-g6-aca-chile`.
No aprovisiona recursos, no construye imágenes y no cambia la fase de seguridad.
La publicación se conserva en `publish-only-images.yml` del Backend oficial.
No ejecuta Oracle, migraciones, seeds ni activaciones públicas.

## Archivos y registro en GitHub

- `.github/workflows/deploy-azure-container-apps.yml`: pruebas en cada cambio del
  workflow/ejecutor en `cueva`; ejecución manual con SHA, servicio y modo.
- `deploy-release.mjs`: validación, plan y actualización de imágenes existentes.
- `deploy-release.test.mjs`: pruebas aisladas, sin comandos Azure/Docker reales.

El job de Azure solo acepta `workflow_dispatch` desde `master` del fork
`AXL031/G6-Productos-Ofertas-backend`. El archivo debe integrarse en esa rama
predeterminada para registrar su ejecución manual. No se cambia el default branch.
La preparación en `cueva` no acredita ese registro ni un despliegue exitoso.

## Configuración necesaria

Crear el environment GitHub `azure-qa`, restringirlo a `master` y configurar su
aprobación de ejecución. No habilitar el job con una credencial general de Azure.
Usar una identidad federada OIDC con subject exacto:

```text
repo:AXL031/G6-Productos-Ofertas-backend:environment:azure-qa
```

Issuer: `https://token.actions.githubusercontent.com`.
Audience: `api://AzureADTokenExchange`.
Asignar permisos sobre los nueve recursos Container Apps existentes: lectura,
lectura de revisiones y escritura de Container Apps. No necesita crear entornos,
listar valores secretos, administrar red/RBAC ni operar PostgreSQL u Oracle.
La escritura ARM no ofrece restricción por propiedad: el ejecutor solo envía la
plantilla existente con la nueva imagen/sufijo y verifica los invariantes.

Environment secrets:

| Nombre | Contenido |
|---|---|
| `AZURE_CLIENT_ID` | ID de la identidad federada específica de este workflow |
| `AZURE_TENANT_ID` | Tenant de la suscripción |
| `AZURE_SUBSCRIPTION_ID` | Suscripción del entorno aprobado |
| `GHCR_READ_TOKEN` | Token dedicado con lectura de los paquetes oficiales; no token personal de administración general |

Environment variables:

| Nombre | Valor del entorno actual |
|---|---|
| `AZURE_RESOURCE_GROUP` | `rg-g6-aca-chile` |
| `GHCR_READ_USER` | Cuenta a la que pertenece el token dedicado de lectura |

Los secretos runtime de las aplicaciones permanecen en Azure. No se copian a
GitHub ni a artefactos. No almacenar JWT humanos ni credenciales de Supabase/AMQP
en este workflow. OIDC no necesita un client_secret de Azure.

## Ejecución

1. Obtener autorización del SHA y de los servicios que se actualizarán. Comprobar
   requisitos de esquema y compatibilidad. Para #222, la migración de recibos de
   Combos y el almacenamiento persistente de logos/archivos se resuelven aparte.
2. Esperar CI posterior al merge del SHA oficial y publicar las imágenes con el
   publicador oficial. No se sustituye una imagen ausente con un build del fork.
3. Ejecutar el workflow en `master`, primero con `mode=plan` y un servicio o `all`.
4. Revisar `release.psv`, `plan.json` y `rollback-images.psv`: digests, revisiones
   anteriores, servicios y SHA. Si faltan credenciales, imagen o CI, se detiene.
5. Con autorización operativa, ejecutar `mode=deploy` para el mismo SHA/servicios.
   Esa ejecución vuelve a resolver imágenes, validar CI y leer todas las bases
   antes de escribir. Los proveedores se actualizan antes que el Gateway.
6. Revisar `result.json` y realizar los E2E de negocio por operación con G7 real.

El script comprueba origen/revisión/título OCI y plataforma linux/amd64 del digest
descargado, además de CI oficial push/master del SHA exacto. Reutiliza el helper
de lectura GHCR de `ops/oracle/ensure-ghcr-sha-image.sh`; no invoca su despliegue.

## Preservación, rollback y límites

El plan guarda hashes y referencias de imágenes, no plantillas ni variables.
Se conservan Caddy/sidecars, env y secretRef, probes, recursos, escalado, ingress,
identidad y listas públicas. Rechaza baselines sin revisión lista o en modo
Multiple, que requieren otra estrategia de rollout. No modifica el modo de revisión.
No ejecutar cambios manuales concurrentes: se comparan baselines y configuración
antes de cada actualización, pero no es una transacción distribuida entre apps.

Si falla un PATCH, la readiness ARM o el smoke, intenta restaurar las imágenes
anteriores en orden inverso. Un cambio de configuración ajeno detiene esa
restauración para revisión manual; no se sobrescribe. Una cancelación forzada o
timeout del workflow puede interrumpir la recuperación: usar el plan y verificar
las revisiones reales antes de continuar. No se borran revisiones automáticamente.

Las revisiones saludables de ARM y el smoke HTTPS `/health` más un rechazo 401
de JWT inválido no certifican todas las APIs, readiness funcional de dependencias,
M2M, workers ni AMQP. El rollback de imágenes no revierte cambios de datos,
mensajes emitidos o migraciones previas. Este script no realiza esas acciones.

Las pruebas automatizadas simulan Azure y el rollback; no presentar sus resultados
como un ensayo real autorizado. La primera ejecución `plan` y el primer despliegue
deben registrar evidencia propia. El cambio de imagen crea una nueva revisión y
puede tener consumo transitorio; no cambia los recursos ni las réplicas configuradas.

## Traslado futuro al repositorio principal

Tras revisar la operación en el fork, trasladar estos cuatro archivos en una PR
pequeña. Cambiar el filtro `github.repository` del job Azure al repositorio destino,
crear allí el environment y una federación OIDC independiente con su subject exacto.
Provisionar sus referencias/secreto de lectura por el gestor autorizado; no copiar
tokens entre repositorios. La fuente de imágenes continúa siendo el Backend oficial.
No se necesita duplicar la lógica de autenticación de los servicios.

## Fuentes

- [Azure Login mediante OIDC](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect).
- [Revisiones de Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/revisions-manage).
- [Ejecución manual y rama predeterminada](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow?tool=webui).
