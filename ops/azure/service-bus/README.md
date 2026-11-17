# Piloto interno H5: Pricing → Service Bus → Price Audit

**Cierre #234:** ver [estado vigente](../../../docs/hito-5/CIERRE_PILOTO_234.md). El usuario eligió mantener el piloto aislado y no omitir Promotions/BFF. La configuración productiva ya requiere G7, activación adicional e identidad administrada; el arranque Nest completo con TLS y recuperación SQL se comprobó en Azure. Las evidencias locales anteriores conservan su corte histórico.

**Actualización Azure 2026-11-16:** infraestructura aislada desplegada y flujo real autenticado validado, incluida redelivery/idempotencia, denegación de permisos cruzados y DLQ. El cómputo de prueba se retiró; las apps actuales todavía no activan H5. Ver [evidencia Azure](../../../docs/hito-5/EJECUCION_AZURE_SERVICE_BUS.md) y [procedimiento cloud](CLOUD_PILOT.md). Las secciones de preparación siguientes describen el corte local original.

Implementación local del primer incremento del plan, con excepción de ownership/Issue autorizada expresamente por Axel el 2026-11-16. La autorización permite el piloto en `cueva`; no registra aprobación de Marco, homologación externa, permisos Azure ni despliegue. Base local `8bf6b6ecf3e60730c945fe707769f95ffa450a8e`; contrato AsyncAPI `0.6.0-rc.4`, Docs `f77c442485203695a5e877fce188a4d249c129fb`.

## Qué ejecuta

Los módulos Nest existentes de Pricing y Audit registran los adaptadores H5, inactivos por defecto. Al seleccionar el piloto, las transiciones efectivas de Pricing guardan negocio, Outbox y entrega para `g6.price-audit.from.pricing` en la misma transacción. Esto incluye escrituras individuales, reconciliación de programaciones y hechos de inicialización que genere su caso de uso; los resultados de inicialización mantienen su ruta H4 y no se habilita su consumidor RabbitMQ en el proceso piloto.

El relay reclama una entrega durante 30 s, libera la transacción y envía mediante el SDK. Cada batch se limita a 256 KiB **codificados**, incluidas propiedades, mediante `tryAddMessage`. Solo marca `sent_at` después de confirmación; ante error reintenta con el mismo ID y backoff de 2 a 60 s. El token/fecha del claim impiden confirmar con un lease vencido o reemplazado. El contrato de negocio no recibe campos nuevos: versión de ruta y productor se cotejan también en propiedades técnicas del mensaje.

Audit recibe con Peek-Lock, finalización manual y un handler concurrente. Pricing envía bytes UTF-8 del envelope para evitar que el SDK lo serialice como otra cadena JSON; Audit conserva la sección binaria (`skipParsingBodyAsJson`) y valida bytes/texto con el decoder del dominio. Guarda Inbox/auditoría atómicamente y solo después completa el mensaje. Una falla SQL abandona; una entrega inválida se mueve a DLQ con razón fija sin copiar su contenido al log. Una falla de settlement posterior al commit no se convierte en rechazo de negocio. Inbox absorbe la redelivery.

DEC-F-009 también exige conservar el contenido de la identidad original: al detectar un duplicado, el repositorio coteja el envelope contra el JSONB persistido. El mismo mensaje con contenido diferente se rechaza y el adaptador H5 lo dispone en DLQ; no reemplaza ni duplica la auditoría original. El orden de propiedades JSON no produce un conflicto artificial.

Ambos workers drenan/cierra sus recursos en `onModuleDestroy`, antes del cierre de los pools PostgreSQL en `onApplicationShutdown`. La readiness incorpora disponibilidad del worker seleccionado; liveness sigue siendo independiente. Los logs nuevos solo admiten códigos fijos mediante los SafeLogger existentes.

## Configuración y arranque

Consultar [runtime.env.example](runtime.env.example). Variables nuevas reconocidas por ambos parsers:

| Variable | Regla |
|---|---|
| `MESSAGING_PROVIDER` | `AZURE_SERVICE_BUS` para el piloto. Sin selección o con `RABBITMQ` y sin variables H5, conservar comportamiento anterior |
| `G6_SERVICE_BUS_PILOT_ENABLED` | `true` explícito para abrir H5 |
| `SERVICE_BUS_NAMESPACE_FQDN` | Host Azure público exacto, sin esquema, puerto, path ni credenciales |
| `NODE_ENV` | `development`, `test` o producción con las condiciones adicionales siguientes |
| `G6_SERVICE_BUS_PRODUCTION_ENABLED` | `true` obligatorio solo en producción; se rechaza en desarrollo/test |
| `AZURE_CLIENT_ID` | Identidad administrada asignada explícitamente, obligatoria en producción |
| `PRICING_PRICE_CHANGED_PUBLISH_ENABLED` | `true` explícito en Pricing |

El proceso Pricing rechaza `PRICING_AMQP_URL` en modo H5; Audit rechaza `PRICE_AUDIT_AMQP_URL`. No hay dual-write ni fallback automático. No usar el interruptor del piloto para migrar otros flujos del servicio. La aplicación conserva su configuración previa de puerto, PostgreSQL/TLS y autenticación G7; estas variables nuevas no conceden permisos HTTP.

Con client ID los clientes usan exclusivamente `ManagedIdentityCredential`; en producción se exige además `G6_SECURITY_MODE=G7_AUTHENTICATED`. Desarrollo/test sin identidad explícita puede usar `DefaultAzureCredential`. Cada workload necesita su identidad independiente; una identidad de desarrollador compartida no acredita aislamiento por servicio. El campo `producer` es integridad contractual, no autenticación. La cola debe estar preaprovisionada con el acceso de envío/recepción correcto.

Antes de arrancar el productor, aplicar la [migración candidata](../../../apps/pricing-svc/migrations-candidate/h5/0001_outbox_delivery.sql) únicamente a una base autorizada, con `po_pricing_owner`, mediante su proceso de migración. El bootstrap nunca hace DDL. Se requieren schema/rol y migraciones de Pricing ya instalados. No cambiar migraciones históricas ni trasladar esta candidata a la base compartida por ejecutar un test.

Compilar con `npm run build:pricing-svc` y `npm run build:price-audit-svc`; arrancar los `dist/apps/<servicio>/main.js` existentes con la configuración privada completa. Los flag H5 del ejemplo no sustituyen `DATABASE_URL`, CA/TLS, puertos o identidad HTTP requeridos por cada parser. No incluir secretos en Git.

## Infraestructura preparada

[main.bicep](main.bicep) crea declarativamente un namespace Basic y la cola piloto, TLS mínimo 1.2, SAS deshabilitado y roles Sender/Receiver al nivel de cola para identidades existentes. No crea usuarios, credenciales ni Container Apps. Basic usa el endpoint público TLS/Entra; no se declara red privada o Private Link en este tier.

Parámetros requeridos: `namespaceName`, `location`, `pricingPrincipalId`, `auditPrincipalId`. `maxDeliveryCount` es opcional (default 10). Los principal IDs son object IDs, no client IDs o secretos; deben ser distintos. Preparar un JSON ARM de parámetros privado y ejecutar `node ops/azure/service-bus/validate-pilot.mjs <archivo.json>` antes de cualquier despliegue. El validador rechaza identidades iguales/nulas, propiedades inesperadas y valores fuera de rango.

Compilar con Bicep `build ops/azure/service-bus/main.bicep --outfile <ruta-temporal.json>`. La compilación no valida que existan cuotas/identidades ni aplica recursos, roles o costos. Posteriormente se ejecutaron `what-if`, despliegue y verificación del laboratorio, registrados en el informe Azure enlazado arriba.

El renderer ACA acepta un plan explícito `--service-bus-pilot <json>` con namespace e identidades `{pricing-svc:{resourceId,clientId},price-audit-svc:{resourceId,clientId}}` dentro de `identities`. Valida identidades distintas, configuración coherente y fija mínimo una réplica en ambos procesos. Es preparación pura, no autoriza cambiar las apps compartidas ni sirve para aplicar el template de nueve apps sobre un despliegue existente sin revisión. El escalado solo por longitud de cola no recupera intenciones que todavía estén en PostgreSQL. Probar solapamiento de revisiones antes de aumentar concurrencia.

## Pruebas reproducibles

- `npm test -- apps/pricing-svc apps/price-audit-svc --maxWorkers=1`: unitarias de los servicios y contratos H4/H5.
- `node --test ops/azure/service-bus/validate-pilot.test.mjs`: parámetros, identidad separada y consistencia de la ruta/Basic; sin llamadas Azure.
- Con `G6_SERVICE_BUS_POSTGRES_TESTS=1`: `npm run test:e2e -- ops/azure/service-bus/pilot.postgres.e2e-spec.ts --maxWorkers=1`. Crea dos PostgreSQL Docker propios, aplica la candidata solo allí y los elimina al terminar. Prueba negocio/Outbox/entrega atómicos, rollback, duplicados, crash post-commit, envío ambiguo, leases y ausencia de locks SQL durante IO. El broker es un doble explícito; esta ejecución **no acredita Service Bus real**.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, build de ambos servicios y suites generales según el plan. Los tests con servidores locales requieren loopback; las suites H4 TLS necesitan OpenSSL de Git en PATH.

### Prueba Azure separada, no ejecutada por defecto

`pilot.azure.e2e-spec.ts` requiere `G6_SERVICE_BUS_AZURE_TESTS=1`, `G6_SERVICE_BUS_TEST_NAMESPACE` con prefijo `g6-sb-test-`, y client IDs distintos `G6_PRICING_TEST_CLIENT_ID` / `G6_AUDIT_TEST_CLIENT_ID`. Se ejecuta desde un entorno con acceso a ambas identidades administradas; usa `ManagedIdentityCredential` explícito, sin fallback al usuario de Azure CLI. Requiere una cola piloto vacía y un namespace descartable autorizado. No aprovisiona recursos.

Comando: `npm run test:e2e -- ops/azure/service-bus/pilot.azure.e2e-spec.ts --maxWorkers=1`. Hace el flujo real SDK+broker+dos bases aisladas y pruebas negativas de rol: la identidad Audit no debe abrir un sender y la identidad Pricing no debe hacer peek. Se exige el código `UnauthorizedAccess`; un timeout u otro fallo técnico no se considera prueba de permisos. Los tests negativos no envían mensajes ni eliminan datos. No ejecutar esta suite contra un namespace compartido/productivo.

## Recuperación y reversión

La tabla nueva solo recibe entregas para hechos creados dentro de transacciones H5; no hay backfill histórico implícito. `pricing.outbox.published_at` no se actualiza al entregar Azure. Antes de volver a encender RabbitMQ, inventariar ambas tablas, mensajes en vuelo y los Inbox/efectos de todos los consumidores: los pendientes H4 pueden incluir hechos ya enviados por Azure. Un cambio de flag no equivale a conciliación.

Detener adquisición H5, drenar o clasificar mensajes por ID, conservar las tablas y registrar la decisión por ruta. No borrar el Outbox ni marcar entregas confirmadas por intuición. Reenviar solo con la misma identidad funcional y autorización después de comprobar efecto terminal. Al recuperar una DLQ, conservar correlación y verificar Inbox antes de replay. El TTL Basic y la retención SQL no son la misma cosa; no purgar pendientes porque expire un mensaje del broker.

El resto de rutas, G5 y el retiro RabbitMQ mantienen los gates del plan. Resultado/evidencias locales: [EJECUCION_PILOTO_SERVICE_BUS.md](../../../docs/hito-5/EJECUCION_PILOTO_SERVICE_BUS.md).
