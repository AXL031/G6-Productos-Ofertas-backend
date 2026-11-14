# Azure Container Apps H5

El CD candidato está documentado en [CONFIGURACION_OIDC_H5.md](CONFIGURACION_OIDC_H5.md). El único trigger es manual (`workflow_dispatch`) desde `master`; exige el HEAD exacto vigente, CI exacta y auditoría de dependencias limpia antes de publicar. El environment `azure-h5` aún no está verificado: su referencia no garantiza aprobación. El owner debe configurar reviewers, restricción exclusiva a `master` y prevención de autoaprobación; el workflow consulta y valida esas reglas antes de OIDC.

El flujo contempla los nueve servicios. La opción `all` es manual y secuencial. Antes de actualizar comprueba el recurso ACA y conserva la configuración del resto de contenedores; Gateway conserva Caddy. Cada cambio registra recibo y el rollback supervisado comprueba que no haya drift o concurrencia. El smoke obligatorio corre en el runner privado `azure-h5-smoke` y falla si falta URL/ruta o el servicio no responde como exige el contrato.

Las pruebas locales usan dobles de Azure CLI; no prueban una suscripción real. No se afirma integración autenticada, smoke funcional, homologación ni despliegue sin evidencia remota ligada al SHA/digest.
