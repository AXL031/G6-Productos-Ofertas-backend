# Ejecutar el piloto aislado en Azure

Actualización #234: [informe de cierre](../../../docs/hito-5/CIERRE_PILOTO_234.md). El runner ahora genera certificados efímeros en el host, usa PostgreSQL/TLS y arranca las apps Nest completas en producción, comprueba recuperación SQL sin HTTP y readiness tras detener el worker. La prueba positiva de identidad HTTP G7 no se simula. Los cuatro mensajes de prueba se archivaron por ID/hash/razón y se completaron mediante un manifiesto exacto; la cola quedó vacía. El modo de limpieza no envía ni reejecuta hechos.

Este laboratorio se ejecutó por solicitud expresa de Axel de continuar con Azure real y despliegue, el 2026-11-16. Su alcance es infraestructura nueva y prueba descartable; no sustituye el proceso de release de las Container Apps existentes. Resultado y recursos: [informe Azure](../../../docs/hito-5/EJECUCION_AZURE_SERVICE_BUS.md).

## Recursos y límites

- [isolated-infrastructure.bicep](isolated-infrastructure.bicep) crea dos identidades administradas y reutiliza `main.bicep` para Basic, cola y roles Sender/Receiver por cola. El operador necesita permisos de creación y asignación de estos roles en el grupo aislado. El runtime no recibe permisos de administración.
- [isolated-runner.bicep](isolated-runner.bicep) ejecuta una tarea Linux con Node y dos PostgreSQL 16 descartables, sin IP pública ni listeners fuera de loopback. Solicita 2 CPU/2 GiB en total. Imágenes fijadas por digest. No usa Supabase, VM existente, ACR ni imágenes publicadas desde el fork.
- El cómputo tiene límite de 900 segundos por contenedor, `restartPolicy: Never` y señal de finalización compartida. El wrapper termina con código 0 para evitar reinicios de plataforma; **el código de salida del contenedor no acredita PASS**. Se exige el registro JSON final y todos los checks del runner. Guardar evidencia y eliminar el grupo ACI al terminar, incluso si hubo fallo.
- El host del laboratorio tiene acceso a ambas identidades para pruebas positivas/negativas. Demuestra autenticación y derechos distintos en Azure, no aislamiento de seguridad entre dos workloads productivos. En producción cada aplicación debe acceder exclusivamente a su propia identidad.
- El namespace Basic y las identidades permanecen después de la prueba; ACI se elimina. La cola puede conservar mensajes de prueba en DLQ como evidencia, sin replay automático. Revisar el inventario antes de reutilizarla. No se midió una factura ni se afirma costo cero; no queda cómputo de la prueba encendido.

## Preparación

Usar un grupo nuevo con prefijo `rg-g6-sb-pilot-` y un namespace nuevo `g6-sb-test-*`. Confirmar suscripción, región permitida, cuota y ausencia de recursos ajenos. Registrar proveedores `Microsoft.ServiceBus` y `Microsoft.ContainerInstance` si falta. Consultar `what-if`; las asignaciones con principal IDs recién creados pueden aparecer como `Unsupported`, por lo que se verifican sus scopes también después del despliegue. No usar modo ARM Complete.

1. Ejecutar las pruebas enfocadas, `typecheck`, lint y builds de Pricing/Audit. Compilar ambos Bicep a un directorio privado/ignorado.
2. Desplegar `isolated-infrastructure.bicep`, con el namespace elegido. Guardar `{state:properties.provisioningState,outputs:properties.outputs}` del resultado como `infrastructure-result.json` en ese directorio. No exportar claves SAS.
3. Ejecutar `node ops/azure/service-bus/prepare-cloud-bundle.mjs <directorio>` después de compilar. Recorre únicamente imports estáticos del runner y de los JS compilados Pricing/Audit; añade package/lock y seis SQL explícitos. No recorre el árbol ni lee `.env`, logs o credenciales. Registra manifiesto de archivos y SHA-256 del gzip. La extracción remota repite allowlist, límites y verificación de hash.
4. Ejecutar `node ops/azure/service-bus/prepare-cloud-parameters.mjs <directorio>`. Produce `runner.parameters.private.json`, con contraseñas UUID exclusivas de las bases efímeras, pasadas como parámetros ARM/variables `secure`. No imprimir ni versionar ese archivo. El directorio usado en esta ejecución es `logs/service-bus-2026-11-16/cloud`, ignorado por Git.
5. Validar y desplegar `isolated-runner.bicep` con esos parámetros y una suscripción explícita. La tarea instala dependencias exactas con `npm ci --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund` y ejecuta el bundle identificado por hash. No se etiqueta el artefacto como release/CI oficial.

No repetir sobre el mismo grupo ACI: recopilar evidencia y eliminar únicamente el ACI propio antes de una ejecución nueva, para asegurar bases/volúmenes nuevos. No eliminar el grupo de recursos ni la cola para ocultar un fallo. Conservar los intentos fallidos en el reporte.

## Criterios de resultado

[cloud-runner.mjs](cloud-runner.mjs) usa los repositorios, mutaciones, relay y handler compilados de los servicios existentes. Los imports entre servicios se limitan a esta orquestación de pruebas fuera de `apps/`; no existen imports entre aplicaciones en runtime.

El runner aplica los mismos SQL de fixtures comprobados por hash, sus migraciones y la candidata de entregas, solo en PostgreSQL loopback nuevo. `ManagedIdentityCredential` selecciona un client ID por cliente; no existe fallback a Azure CLI ni contraseña para Service Bus.

Se requiere evidencia de todos estos checks:

| Check | Evidencia requerida |
|---|---|
| `MANAGED_IDENTITIES_AUTHENTICATED` | Sender y receiver conectan con identidades diferentes; cola activa inicialmente vacía |
| `RECEIVED_DATA_SECTION` | Llega el envelope UTF-8 como bytes desde el SDK/broker |
| `PRICING_AZURE_AUDIT_REDELIVERY` | Mutación real, entrega SQL confirmada, recepción real, commit Audit, abandon deliberado después del commit y redelivery con un solo efecto SQL |
| `AUDIT_CANNOT_SEND` | SDK rechaza apertura Sender con `UnauthorizedAccess` |
| `PRICING_CANNOT_RECEIVE` | SDK rechaza peek con `UnauthorizedAccess` |
| `INVALID_MESSAGE_REAL_DLQ` | Handler dispone mensaje inválido en DLQ y el ID/razón se comprueban con peek real; se conserva para inspección |
| `AZURE_ISOLATED_PILOT` | PASS final con SHA del bundle; ningún check anterior falló |

Un timeout no sustituye `UnauthorizedAccess`. El abandon posterior al commit es una inyección de fallo explícita, no una caída física del host ni una prueba de pérdida real de lock. No prueba el bootstrap completo Nest/HTTP, escalado, convivencia de revisiones ACA, release oficial o homologación externa.

## Cierre y promoción

Guardar los logs sanitizados del runner, imágenes/estado/tiempos ACI, namespace, cola, roles y hashes. No exportar variables de ACI, tokens, contraseñas, payloads o cadenas de conexión. Eliminar únicamente el recurso `Microsoft.ContainerInstance/containerGroups` creado para el test y confirmar su ausencia mediante listado. Borrar el archivo local de parámetros privados cuando ya no se necesita.

La promoción a las aplicaciones existentes conserva el proceso [CD H5](../container-apps/CONFIGURACION_OIDC_H5.md): commit oficial, CI del SHA, environment protegido y aprobación final del deployment. La excepción de autoaprobación del usuario se limita a `azure-h5-pilot-234` y Pricing/Audit. La configuración productiva ahora exige identidad asignada y activación explícita; el usuario eligió no activar la ruta parcial en las apps compartidas. No se retira RabbitMQ.

Fuentes técnicas: [identidades en ACI](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-managed-identity), [grupos multicontenedor](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-multi-container-group), [política de reinicio](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-restart-policy). El tratamiento binario se comprobó contra `dataTransformer.js` del SDK fijado `@azure/service-bus@7.10.0` y luego en el broker real.
