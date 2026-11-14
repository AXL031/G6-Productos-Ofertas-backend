# Dependencias Oracle pendientes de retirada (corte H5)

Este inventario separa dependencias que mantienen pruebas/automatización de CI de componentes exclusivamente operativos. No propone retirar Oracle en el PR #212; la retirada requiere un cambio transversal posterior. Confirmar de nuevo las referencias en `master` al planificar ese trabajo.

## Dependencias que afectan CI o workflows GitHub

- `.github/workflows/ci.yml`: jobs obligatorios validan herramientas, registro de servicios, Compose, contenedores y despliegues simulados bajo `ops/oracle/`. Estas comprobaciones siguen protegiendo configuración y compatibilidad existentes.
- `.github/workflows/cd-services-oracle.yml`: workflow de despliegue Oracle que permanece habilitado y usa validadores, registro, publicación, APIs GitHub Deployments, credenciales SSH/Tailscale y evidencias Oracle.
- `.github/workflows/publish-only-images.yml`: flujo manual de publicación GHCR todavía usa `ops/oracle/validate-publish-only-source.sh`. Para evitar duplicar reglas de inmutabilidad, `ops/oracle/ensure-ghcr-sha-image.sh` ahora es un wrapper compatible hacia `ops/shared/ensure-ghcr-sha-image.sh`.
- `.github/workflows/cd-services-oracle.yml`, `.github/workflows/publish-only-images.yml` y el CD Azure comparten el grupo neutral `publish-g6-ghcr-<repo>-<servicio>` para que una publicación del mismo tag no corra en paralelo. El grupo compartido serializa publicación y la operación Oracle existente por servicio; el despliegue Azure conserva además su propio grupo `g6-azure-h5-...`.
- `ops/oracle/tests/**`: pruebas de ese flujo y del ejecutor Oracle permanecen en CI; se excluyen de la retirada de este PR.

## Dependencias exclusivamente operativas o documentales

- `ops/oracle/`: Compose, Caddy, registros, ejecutores, configuración de hosts, scripts de provisión, SSH/Tailscale, readiness, recuperación y documentación por servicio.
- `.github/workflows/cd-services-oracle.yml` y sus environments/credenciales: la ejecución operativa se conserva como flujo aparte hasta que exista plan y migración autorizados.
- `ops/azure/bootstrap-vm.sh` copia archivos desde `ops/oracle/` para el despliegue VM/Compose en Azure. Esa ruta de Azure VM es distinta al CD de Azure Container Apps H5.
- `ops/azure/deploy-g6-service.sh` comparte el registro y los artefactos Compose de `ops/oracle/`; mantenerlo junto a la compatibilidad VM mientras esa modalidad siga operativa.

## Frontera del CD Azure Container Apps H5

`.github/workflows/cd-services-azure.yml` y `ops/azure/container-apps/**` no invocan scripts `ops/oracle/`, no usan credenciales Oracle/SSH/Tailscale y no comparten el grupo de concurrencia Oracle. El único punto de compatibilidad del helper de imagen es el wrapper conservado para el publicador vigente.

Antes de retirar la infraestructura heredada, trasladar y validar los checks de CI que sigan siendo pertinentes, migrar explícitamente el publicador GHCR y coordinar la retirada del workflow Oracle, de la modalidad VM/Compose y de sus credenciales. No retirar por búsqueda/reemplazo general.
