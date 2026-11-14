# CD Azure Container Apps — Hito 5

## Estado y límites de evidencia

Este flujo es un candidato de CD manual. `workflow_dispatch` es el único disparador; no se habilitó `workflow_run`, `push` ni despliegue masivo automático. En este cambio solo se hicieron simulaciones locales. No se autenticó en Azure ni se verificó un recurso remoto. Un éxito de pruebas locales o CI no equivale a integración autenticada, homologación ni despliegue.

El workflow se detiene si no puede comprobar el repositorio, SHA, CI, digest, variables Azure o el estado/configuración de la Container App. No crea apps ni cambia recursos auxiliares.

## Arquitectura

1. `workflow_dispatch` desde `master` elige un servicio o `all` y un SHA completo.
2. El validador de `master` comprueba que el SHA pertenece al historial vigente, y que hay un run de `.github/workflows/ci.yml` exitoso desde `push` de `master` para ese mismo SHA.
3. El job de publicación verifica y reutiliza una etiqueta GHCR existente si sus etiquetas OCI y digest coinciden. Si no existe, construye una sola vez desde el checkout del SHA seleccionado, etiqueta origen/revisión/servicio, publica y verifica el digest.
4. Un job aprobado por el environment `azure-h5` actualiza por digest solo el contenedor del servicio seleccionado. Lee la app primero, valida identidad/contenedores, compara la configuración antes/después y comprueba la revisión.
5. Smoke HTTPS independiente registra liveness, readiness y, cuando se configura una ruta contractual, el rechazo 401/403 sin credenciales.
6. Si fallan el despliegue o los smoke tests, recuperación supervisada vuelve a requerir aprobación del environment. Solo restaura cuando imagen y configuración siguen iguales al recibo; ante drift o evidencia incompleta deja el estado como desconocido para atención manual.

El selector soporta `api-gateway`, `bulk-svc`, `catalog-svc`, `combos-svc`, `inventory-svc`, `price-audit-svc`, `pricing-svc`, `promotions-svc` y `taxonomy-svc`. `all` ejecuta en serie, con recibos por servicio y reconciliación del conjunto ante fallo. Una ejecución parcial nunca se informa como despliegue/recuperación completa.

## Configuración GitHub y OIDC

Crear el environment `azure-h5`, permitir despliegues desde `master` solamente y requerir aprobación de una persona responsable de Azure. El workflow no puede saltar esa aprobación.

Configurar una identidad de Microsoft Entra dedicada. Su credencial federada debe usar:

| Propiedad | Valor |
| --- | --- |
| Issuer | `https://token.actions.githubusercontent.com` |
| Audience | `api://AzureADTokenExchange` |
| Subject | `repo:Taller-SW-Web/G6-Productos-Ofertas-backend:environment:azure-h5` |

Variables requeridas del environment (no secretos): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` y `AZURE_SUBSCRIPTION_ID`. Sin environment, variables o federación válidos, el workflow falla cerrado. No almacenar claves de service principal.

Asignar a la identidad un rol personalizado en el scope del resource group de ACA que permita como mínimo lectura/escritura de Container Apps, lectura de revisiones, lectura de Managed Environments y lectura del resource group. No dar permisos de crear/eliminar ni roles `Owner`/`Contributor` por defecto. `Microsoft.App/containerApps/write` permite cambios amplios de la app; no restringe por sí solo la escritura al campo de imagen. El executor aplica comparación de configuración y el revisor debe inspeccionar el cambio y la auditoría de Azure.

Permisos del token GitHub: `actions: read` para verificar la CI, `contents: read` para validar código; `packages: write` solo al publicar; `id-token: write` solo en los jobs Azure que usan OIDC. No se requieren secretos Azure.

## Smoke HTTPS (variables opcionales del environment)

Para cada servicio se puede configurar `AZURE_SMOKE_URL_<SERVICIO>` con una URL HTTPS base sin ruta. Se usa `/health` para liveness y los siguientes endpoints de readiness definidos por la aplicación:

| Servicio | Readiness |
| --- | --- |
| `api-gateway` | No tiene ruta HTTP readiness pública en este flujo; la salud de revisión ACA es evidencia separada. |
| `bulk-svc` | `/health/readiness` |
| `catalog-svc` | `/health/ready` |
| `combos-svc` | `/health/ready` |
| `inventory-svc` | `/health/readiness` |
| `price-audit-svc` | `/health/ready` |
| `pricing-svc` | `/health/ready` |
| `promotions-svc` | `/health/ready` |
| `taxonomy-svc` | `/health/ready` |

La ausencia de URL deja el smoke funcional como `PENDIENTE`; no acredita disponibilidad externa. `AZURE_SMOKE_PROTECTED_<SERVICIO>` puede indicar una ruta GET de lectura ya confirmada con el contrato y el owner. El script la solicita sin token e informa éxito solo para 401/403. No inventa credenciales. Sin esa ruta, autorización, rutas comerciales, propagación de errores y conectividad externa quedan pendientes. La readiness prueba únicamente los checks que el endpoint del servicio tenga implementados; no demuestra toda la integración con G7.

No usar una ruta que escriba datos. Si una prueba funcional necesita fixture/identidad de G7, debe configurarse en una fase homologada con credenciales y evidencia reales, separada de estos smoke anónimos.

## Procedimiento manual

1. Confirmar que el commit candidato está en `master` y que la ejecución CI de ese SHA terminó exitosamente.
2. Iniciar `CD Azure Container Apps H5` con `workflow_dispatch` desde `master`, elegir un servicio y pegar el SHA completo. Para `all`, revisar previamente las aprobaciones y disponibilidad de los nueve recursos.
3. Revisar la evidencia de origen y aprobar el environment `azure-h5` solo después de verificar servicio, SHA y alcance.
4. Revisar digest inmutable, etiquetas OCI, nombre de app/contenedor, revisión, estado/readiness y comparación de configuración.
5. Consultar el resultado por separado: imagen GHCR, deploy ACA, smoke, rollback, integración autenticada y homologación. No inferir un estado de otro.

El resource group y las apps se descubren/validan mediante lectura antes de actualizar; si el nombre o identidad histórica no coincide, se bloquea la operación. Para Gateway se valida la presencia del contenedor auxiliar `caddy` y la comparación conserva su imagen/configuración. Variables, secretos referenciados, ingress, escala, probes y volúmenes están incluidos en la comparación normalizada. No se usa `az containerapp create/delete`.

## Rollback y recuperación

El recibo por servicio guarda SHA-256 de la configuración normalizada e imágenes anterior/objetivo fijadas por digest; no serializa valores secretos. Ante fallo se comprueba el estado vivo antes de restaurar. Una modificación concurrente de otro operador, falta de recibo o estado no verificable impide el rollback automático. La recuperación supervisada requiere nuevamente aprobación. Se informa `RECUPERACIÓN COMPLETA` únicamente cuando cada servicio desplegado se restauró y verificó o GitHub demuestra que no se desplegó.

No se ha probado rollback en Azure real. Las pruebas con Azure CLI simulado no prueban permisos, comportamiento remoto ni homologación.

## Pendientes antes de autorizar un primer despliegue

- Owner Azure: crear/revisar `azure-h5`, revisor obligatorio, OIDC, RBAC de mínimo alcance y acceso de ACA a GHCR.
- Owner de cada servicio: confirmar app/container name y endpoint de readiness en Azure contra la configuración vigente.
- Owners de contrato/identidad: escoger rutas de lectura protegidas, validar status sin credenciales y homologar pruebas autenticadas con G7 cuando corresponda.
- Operación: hacer una lectura autenticada de cada app y validar rollback supervisado con una ventana y aprobación explícitas.
- Seguridad: revisar versión de acciones, permisos efectivos, auditoría/RBAC y hallazgos de dependencias/estático ligados al SHA candidato.

## Evidencia de esta rama

El merge, pruebas simuladas, actionlint, ShellCheck y CI del SHA final se registran como evidencia propia de código/CI. No se realizaron operaciones Azure, no se configuraron credenciales y no se afirma despliegue u homologación.

La revisión local de dependencias ejecutó `npm audit --omit=dev --audit-level=high` y encontró 3 vulnerabilidades altas y 1 moderada: `body-parser` (DoS), `multer` vía `@nestjs/platform-express` (DoS) y `qs` (DoS). No se modificaron dependencias ni lockfile porque son archivos globales fuera de la autorización acotada de este PR. Se requiere Issue/cambio autorizado del owner de dependencias y una nueva auditoría antes de que la revisión de seguridad H5 pueda considerarse cerrada.
