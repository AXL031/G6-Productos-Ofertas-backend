# CD Azure Container Apps — Hito 5

## Estado y límites de evidencia

Este flujo es un candidato de CD manual. `workflow_dispatch` es el único disparador; no se habilitó `workflow_run`, `push` ni despliegue masivo automático. En este cambio solo se hicieron simulaciones locales. No se autenticó en Azure ni se verificó un recurso remoto. Un éxito de pruebas locales o CI no equivale a integración autenticada, homologación ni despliegue.

**Bloqueo operativo actual:** la consulta de solo lectura a GitHub API devolvió `404` para `azure-h5`; actualmente no existe. GitHub puede crear un environment faltante al ejecutar un job que lo referencia y dejarlo sin protección. Antes del login OIDC, el workflow vuelve a consultar las reglas reales mediante la API y falla si falta cualquiera. No se ha creado ni modificado el environment desde este PR.

El workflow se detiene si no puede comprobar el repositorio, SHA, CI, digest, variables Azure o el estado/configuración de la Container App. No crea apps ni cambia recursos auxiliares.

## Arquitectura

1. `workflow_dispatch` desde `master` elige un servicio o `all` y un SHA completo. El SHA debe ser exactamente el HEAD vigente de `master` en cada revalidación; un ancestro con CI exitosa ya no se acepta.
2. El validador consulta la punta actual de `master` y requiere un run de `.github/workflows/ci.yml` exitoso desde `push` de `master` para ese SHA exacto.
3. Antes de publicar, un job con Node.js 24.15.0 ejecuta `npm audit --omit=dev --audit-level=high --json` usando el `package-lock.json` del SHA seleccionado. Si la auditoría falla, publicación y despliegue quedan bloqueados.
4. El job de publicación verifica y reutiliza una etiqueta GHCR existente si sus etiquetas OCI y digest coinciden. Si no existe, construye una sola vez desde el checkout del SHA validado, etiqueta origen/revisión/servicio, publica y verifica el digest.
5. Antes del login OIDC, el job consulta `azure-h5` con `actions: read` y confirma que existan required reviewers, que `prevent_self_review` esté habilitado y que la única policy de ramas sea `master`. Recuperación vuelve a comprobar esas reglas antes de autenticarse.
6. Smoke se ejecuta en un runner self-hosted etiquetado `azure-h5-smoke`, desde la red autorizada. Requiere URL HTTPS y ruta contractual protegida; ausencia de cualquiera o fallo de liveness/readiness/autorización falla el job.
7. Si fallan el despliegue o los smoke tests, recuperación supervisada conserva el recibo de rollback y también comprueba la atestación de protección antes de autenticarse. Solo restaura cuando imagen y configuración siguen iguales al recibo; ante drift o evidencia incompleta deja el estado como desconocido para atención manual.

El selector soporta `api-gateway`, `bulk-svc`, `catalog-svc`, `combos-svc`, `inventory-svc`, `price-audit-svc`, `pricing-svc`, `promotions-svc` y `taxonomy-svc`. `all` ejecuta en serie, con recibos por servicio y reconciliación del conjunto ante fallo. Una ejecución parcial nunca se informa como despliegue/recuperación completa.

## Configuración GitHub y OIDC

### Bloqueo previo al despliegue: GitHub Environment

El owner de Azure/Repository debe revisar manualmente `Settings > Environments > azure-h5` y acreditar todo lo siguiente antes de habilitar despliegues:

1. Required reviewers incluye al menos una persona/equipo responsable.
2. La opción de prevenir autoaprobaciones está activada.
3. La política de deployment branches/tags permite únicamente `master`.
4. Guardar la configuración y verificar que la API de GitHub devuelve las tres propiedades anteriores.

GitHub puede crear automáticamente un environment referenciado que aún no existe y dejarlo sin estas reglas. Por eso `environment: azure-h5` por sí solo no prueba aprobación humana. El workflow hace una consulta `GET` y falla antes del login OIDC ante un environment ausente, reviewers vacíos, autoaprobación permitida o una política distinta de `master`. La aprobación humana solo queda activa tras la configuración externa del owner; este PR no la configura ni declara que ya esté activa.

Crear/configurar el environment y permitir despliegues desde `master` únicamente es una operación del owner, fuera de este cambio.

Configurar una identidad de Microsoft Entra dedicada. Su credencial federada debe usar:

| Propiedad | Valor |
| --- | --- |
| Issuer | `https://token.actions.githubusercontent.com` |
| Audience | `api://AzureADTokenExchange` |
| Subject | `repo:Taller-SW-Web/G6-Productos-Ofertas-backend:environment:azure-h5` |

Variables requeridas del environment (no secretos): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` y `AZURE_SUBSCRIPTION_ID`. La verificación de reglas usa el token de workflow con `actions: read`. El runner autorizado de smoke se registra en GitHub Actions con las etiquetas `self-hosted`, `linux` y `azure-h5-smoke`; no publicar servicios privados solo para habilitar pruebas. Sin environment protegido, variables Azure, runner privado o federación válidos, la validación queda bloqueada. No almacenar claves de service principal.

Asignar a la identidad un rol personalizado en el scope del resource group de ACA que permita como mínimo lectura/escritura de Container Apps, lectura de revisiones, lectura de Managed Environments y lectura del resource group. No dar permisos de crear/eliminar ni roles `Owner`/`Contributor` por defecto. `Microsoft.App/containerApps/write` permite cambios amplios de la app; no restringe por sí solo la escritura al campo de imagen. El executor aplica comparación de configuración y el revisor debe inspeccionar el cambio y la auditoría de Azure.

Permisos del token GitHub: `actions: read` para verificar la CI, `contents: read` para validar código; `packages: write` solo al publicar; `id-token: write` solo en los jobs Azure que usan OIDC. No se requieren secretos Azure.

## Smoke HTTPS desde red autorizada (variables obligatorias)

Para cada servicio, el owner configura `AZURE_SMOKE_URL_<SERVICIO>` con una URL HTTPS base sin ruta y `AZURE_SMOKE_PROTECTED_<SERVICIO>` con una ruta GET de lectura, contractual y protegida. El job corre en el runner self-hosted con acceso a la red privada autorizada. Para Container Apps privadas, apunta la URL al dominio interno/resoluble desde esa red; no habilites ingress público para el smoke. Se usa `/health` para liveness y los siguientes endpoints de readiness definidos por la aplicación:

| Servicio | Readiness |
| --- | --- |
| `api-gateway` | No tiene ruta HTTP readiness contratada en este flujo; la salud de revisión ACA es evidencia separada. |
| `bulk-svc` | `/health/readiness` |
| `catalog-svc` | `/health/ready` |
| `combos-svc` | `/health/ready` |
| `inventory-svc` | `/health/readiness` |
| `price-audit-svc` | `/health/ready` |
| `pricing-svc` | `/health/ready` |
| `promotions-svc` | `/health/ready` |
| `taxonomy-svc` | `/health/ready` |

La ausencia de URL o de ruta protegida termina el smoke con error y bloquea el resultado global de despliegue validado. El script solicita la ruta sin token e informa PASS solo para 401/403. No inventa credenciales. La readiness prueba únicamente los checks que el endpoint del servicio tenga implementados; no demuestra toda la integración con G7.

No usar una ruta que escriba datos. Si una prueba funcional necesita fixture/identidad de G7, debe configurarse en una fase homologada con credenciales y evidencia reales, separada de estos smoke anónimos.

## Procedimiento manual

1. Confirmar que el commit candidato está en `master` y que la ejecución CI de ese SHA terminó exitosamente.
2. Confirmar con el owner que `azure-h5` fue configurado. El workflow volverá a comprobar por API required reviewers, prevención de autoaprobación y restricción exclusiva a `master` antes de usar OIDC.
3. Iniciar `CD Azure Container Apps H5` con `workflow_dispatch` desde `master`, elegir un servicio y pegar el HEAD exacto vigente. Para `all`, revisar previamente las aprobaciones y disponibilidad de los nueve recursos. La auditoría de dependencias debe terminar limpia antes de publicar.
4. Aprobar el deployment en GitHub únicamente después de revisar servicio, SHA y alcance.
5. Revisar digest inmutable, etiquetas OCI, nombre de app/contenedor, revisión, estado/readiness y comparación de configuración.
6. Consultar el resultado por separado: imagen GHCR, deploy ACA, smoke, rollback, integración autenticada y homologación. No inferir un estado de otro.

El resource group y las apps se descubren/validan mediante lectura antes de actualizar; si el nombre o identidad histórica no coincide, se bloquea la operación. Para Gateway se valida la presencia del contenedor auxiliar `caddy` y la comparación conserva su imagen/configuración. Variables, secretos referenciados, ingress, escala, probes y volúmenes están incluidos en la comparación normalizada. No se usa `az containerapp create/delete`.

## Rollback y recuperación

El recibo por servicio guarda SHA-256 de la configuración normalizada e imágenes anterior/objetivo fijadas por digest; no serializa valores secretos. Ante fallo se comprueba el estado vivo antes de restaurar. Una modificación concurrente de otro operador, falta de recibo o estado no verificable impide el rollback automático. La recuperación supervisada requiere nuevamente aprobación. Se informa `RECUPERACIÓN COMPLETA` únicamente cuando cada servicio desplegado se restauró y verificó o GitHub demuestra que no se desplegó.

El rollback supervisado ante fallo restaura únicamente la imagen previa registrada en el recibo. Solicitar intencionalmente un release anterior es un procedimiento aparte: Issue/solicitud explícita, digest previo identificado en evidencia, evaluación del owner de servicio y aprobación de Azure; no se puede seleccionar un SHA histórico mediante el dispatch ordinario. El procedimiento no debe debilitar el rollback supervisado existente.

No se ha probado rollback en Azure real. Las pruebas con Azure CLI simulado no prueban permisos, comportamiento remoto ni homologación.

## Pendientes antes de autorizar un primer despliegue

- Owner Azure/Repository: configurar required reviewers, prevención de autoaprobación y restricción exclusiva a `master` en `azure-h5`. Este bloqueo sigue abierto hasta verificar la configuración en GitHub; el workflow solo la lee y falla cerrado.
- Owner de red/operación: disponer el runner self-hosted `azure-h5-smoke` dentro de la red autorizada y sin ingress público para endpoints privados.
- Seguridad/owner de dependencias: remediar findings y obtener auditoría limpia; el gate del workflow bloquea publicación mientras `npm audit` falle.
- Owner de cada servicio: confirmar app/container name y endpoint de readiness en Azure contra la configuración vigente.
- Owners de contrato/identidad: escoger rutas de lectura protegidas, validar status sin credenciales y homologar pruebas autenticadas con G7 cuando corresponda.
- Operación: hacer una lectura autenticada de cada app y validar rollback supervisado con una ventana y aprobación explícitas.
- Seguridad: revisar versión de acciones, permisos efectivos, auditoría/RBAC y hallazgos de dependencias/estático ligados al SHA candidato.

## Evidencia de esta rama

El merge, pruebas simuladas, actionlint, ShellCheck y CI del SHA final se registran como evidencia propia de código/CI. No se realizaron operaciones Azure, no se configuraron credenciales y no se afirma despliegue u homologación.

La auditoría local del SHA `c151441769d43f1ca5f329bd5059a0071252174b` encontró 3 vulnerabilidades altas y 1 moderada: `body-parser` (DoS), `multer` vía `@nestjs/platform-express` (DoS) y `qs` (DoS). Se ejecutó `npm audit --omit=dev --audit-level=high --json` con Node.js `v24.3.0`, npm `11.4.2` y `package-lock.json` SHA-256 `2d27b837c4529a4e91d64b4276fc48494fc6ad371dd920a3902bc7396c5be0b8`; los cuatro findings reportaron `fixAvailable=true`. El job H5 repite la auditoría con Node.js 24.15.0 contra el `package-lock.json` exacto del SHA candidato, conserva salida JSON, stderr, versión de Node/npm y SHA-256 del lockfile como artifact incluso si falla, y bloquea `publish` ante hallazgos high o superiores. Las fuentes de advisories cambian con el tiempo; el artifact liga cada resultado a la ejecución, hora, SHA y lockfile concretos.

### Propuesta acotada de remediación

Abrir un Issue separado con el owner de dependencias para identificar las rutas transitivas fijadas en el lockfile. El reporte actual marca vulnerables `body-parser` `2.0.0–2.3.0` (fijo desde `2.4.0`), `multer` `2.0.0–2.4.0` (fijo desde `2.5.0`) y `qs` `6.7.0–6.16.0` (fijo posterior a `6.16.0`); `@nestjs/platform-express` aparece afectado vía `multer`. Evaluar primero la actualización mínima compatible de `@nestjs/platform-express` y confirmar que resuelva los tres caminos; usar overrides solo si el owner los acepta. Cambiar manifests/lockfile únicamente en ese Issue autorizado; ejecutar instalación reproducible, tests de los servicios afectados y `npm audit --omit=dev --audit-level=high --json`, adjuntando el reporte antes/después. No usar `npm audit fix --force` ni actualizar dependencias globales en este PR.

El gate previo a despliegue es obligatorio y ya está cableado como dependencia de `publish`: el workflow no construye/publica imágenes ni inicia deploy si la auditoría de producción falla. SAST puede añadirse en el mismo job cuando el owner seleccione una herramienta/versionado; no sustituye a la auditoría de dependencias.
