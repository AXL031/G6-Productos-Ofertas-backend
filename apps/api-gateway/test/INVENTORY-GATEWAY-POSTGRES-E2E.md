# E2E de Gateway → Inventory → PostgreSQL

Esta suite opt-in inicia la aplicación compilada actual de Inventory, un servidor HTTP real de Gateway con el `GatewayIdentity` de producción y un contenedor PostgreSQL 17 aislado. Aplica las migraciones base e incremental oficiales de Inventory y la migración actual del ciclo de vida; luego inserta únicamente fixtures de prueba para ubicación, ruta y stock. Estas operaciones de solo lectura no requieren RabbitMQ.

## Ejecución local

Usa una versión de Node compatible con el repositorio (`^22.22.3 || >=24.15.0`) y asegúrate de que Docker esté disponible. Desde la raíz del backend:

```powershell
npm.cmd run build:api-gateway
npm.cmd run build:inventory-svc
$env:G6_INVENTORY_GATEWAY_POSTGRES_E2E = '1'
node_modules/.bin/vitest run --config ./vitest.config.e2e.ts --exclude 'node_modules/**' apps/api-gateway/test/inventory-postgres.gateway.e2e-spec.ts --maxWorkers=1
```

El harness reutiliza `Phase1Postgres`, etiqueta su contenedor, publica puertos solo en loopback, comprueba PostgreSQL 17 y limpia exclusivamente el contenedor que creó y su directorio temporal de certificados. Define `G6_DOCS_ROOT` si la copia de Docs no está en `../docs`.

En CI, el job `gateway_inventory_postgres` obtiene las migraciones oficiales fijadas de `G6-Productos-Ofertas-docs`, define `G6_DOCS_ROOT` y exige exactamente siete pruebas aprobadas y cero omitidas. El job verifica además que no queden contenedores PostgreSQL etiquetados por el harness y conserva el reporte JSON y el log como artefacto.

## Autenticación y cobertura

La suite genera un único par de claves RSA-2048 local. El mismo JWT firmado se valida mediante el `SignedIdentityVerifier` real de Gateway a través de un endpoint JWKS local y mediante el `InventoryAuthGuard` real usando la clave PEM pública correspondiente. Usa `iss=https://isolated.test/issuer`, `aud=api-productos`, tokens de servicio, listas de clientes por ruta y el scope `inventario:disponibilidad:leer`. No afirma que existan credenciales ni homologación G7.

Los flags de demo sin autenticación de Gateway e Inventory y el modo de solo lectura de demo permanecen desactivados; el modo de seguridad es `G7_AUTHENTICATED`. La prueba no reemplaza `GatewayIdentity`, `InventoryAuthGuard`, el proveedor HTTP ni el proveedor de base de datos.

Incluye GET autenticado para `modulo-productos` en MARKETPLACE; POST comercial autenticado para `modulo-marketplace`; los tres resultados que no reservan stock; rechazo de POST para `modulo-productos`; JWT ausente, malformado y con firma inválida; cliente y scope incorrectos; incompatibilidad de cliente/canal; Problem Details 400 y 422; cabecera de correlación; error real de permisos PostgreSQL con respuesta interna sanitizada; y un upstream HTTP real de Inventory no disponible. Compara saldos de los fixtures y cantidades de reservas, operaciones y Kardex antes y después de los POST válidos. La instantánea no cambia.

La suite no afirma haber obtenido un 429 real: no se configura ni provoca una condición real de límite de tasa.

## Defecto pendiente para el owner de Inventory, Taco

Al detener PostgreSQL mientras Inventory sigue ejecutándose, tanto el GET HTTP directo a Inventory como el GET enrutado por Gateway respondieron **500 `ERROR_INTERNO`**, en vez del **503 `SERVICIO_NO_DISPONIBLE` esperado por el contrato**. Es una caracterización temporal del defecto, no un resultado correcto. La respuesta fue sanitizada. La prueba reinicia la base aislada y el proceso Inventory antes de limpiar.

La reproducción está en la prueba opt-in `caracteriza la respuesta real de Inventory ante caída PostgreSQL y recupera el servicio`. Usa el `inventory-svc` real compilado desde el checkout probado, no un proveedor simulado. Otra prueba confirma que Gateway responde 503 cuando se detiene el proceso HTTP de Inventory.

El problema está en Inventory, fuera del alcance autorizado de este PR: [`ProblemDetailsFilter`](../../inventory-svc/src/errors/problem-details.filter.ts) revisa el `code` de primer nivel contra el conjunto de códigos de PostgreSQL no disponible. La versión de Drizzle usada en producción envuelve el error PostgreSQL dentro de `DrizzleQueryError.cause`; el wrapper no tiene el código PostgreSQL en primer nivel y el filtro lo clasifica como `ERROR_INTERNO`. Owner: Taco. Tras la corrección, esta prueba debe exigir **503 `SERVICIO_NO_DISPONIBLE` tanto en la respuesta directa de Inventory como en la enrutada por Gateway**.

Esta evidencia corresponde a una integración local/CI aislada. No demuestra aprovisionamiento u homologación G7, despliegue Oracle ni readiness para producción.
