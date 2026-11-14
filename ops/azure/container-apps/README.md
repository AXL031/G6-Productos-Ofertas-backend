# Azure Container Apps H5

El CD candidato está documentado en [CONFIGURACION_OIDC_H5.md](CONFIGURACION_OIDC_H5.md). El único trigger es manual (`workflow_dispatch`) desde `master`, con SHA y servicio seleccionados explícitamente, CI exacta validada, aprobación del environment `azure-h5` y despliegue por digest.

El flujo contempla los nueve servicios. La opción `all` es manual y secuencial. Antes de actualizar comprueba el recurso ACA y conserva la configuración del resto de contenedores; Gateway conserva Caddy. Cada cambio registra recibo y el rollback supervisado comprueba que no haya drift o concurrencia.

Las pruebas locales usan dobles de Azure CLI; no prueban una suscripción real. No se afirma integración autenticada, smoke funcional, homologación ni despliegue sin evidencia remota ligada al SHA/digest.
