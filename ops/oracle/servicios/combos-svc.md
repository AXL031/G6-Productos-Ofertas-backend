# Ficha operativa — combos-svc

## Identidad y estado

Owner: Castilla. Aplicación: `apps/combos-svc`. Puerto HTTP predeterminado: 3007 (`COMBOS_SVC_PORT`). Consume PostgreSQL, Catalog y Pricing por HTTP; opcionalmente consume RabbitMQ cuando `COMBOS_AMQP_ENABLED=true`. La persistencia usa el schema `combos` existente y no ejecuta migraciones al arrancar.

Esta ficha describe código preparado en el repositorio. No demuestra configuración de producción, grant G7, integración autenticada, homologación, despliegue ni readiness en Oracle. Registrar cada estado junto al SHA que lo acredita.

## Configuración

Requeridas para operaciones de negocio: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE=verify-full`, `PGSSLROOTCERT`, `COMBOS_CATALOG_URL` y `COMBOS_PRICING_URL`. `G6_SECURITY_MODE` acepta `PUBLIC_READ_ONLY`, `SIMULATED_AUTH` o `G7_AUTHENTICATED` y por defecto es `G7_AUTHENTICATED`. En G7 se requieren `SECURITY_ISSUER`, `SECURITY_DISCOVERY_URL` y `SECURITY_JWKS_URL`; audiencia `api-productos`. En modo simulado se requieren `COMBOS_SIMULATED_ISSUER`, `COMBOS_SIMULATED_DISCOVERY_URL` y `COMBOS_SIMULATED_JWKS_URL`, con emisor distinto al de G7. No se aceptan tokens simulados en modo G7. `COMBOS_PUBLIC_READ_OPERATIONS` está vacío por defecto y solo permite operationIds de lectura con método/ruta exactos registrados en código; no hay operaciones Combos anónimas aprobadas hoy.

Para M2M saliente, `COMBOS_G7_TOKEN_URL` y `COMBOS_G7_CLIENT_SECRET` deben entregarse juntos; el client id implementado es `modulo-productos`, con scopes `catalogo:leer` y `precios:leer` para upstreams. Las rutas `obtenerCombo` y `consultarDisponibilidadCombo` admiten `serviceBearer` con `combos:leer` solo para los clientes enumerados explícitamente en `COMBOS_ALLOWED_CLIENTS_COMBOS_READ`. El listado está vacío por defecto. Para permisos humanos, cada operationId requiere una lista no vacía `COMBOS_ALLOWED_ROLES_<OPERATION_ID_EN_MAYUSCULAS_CON_GUIONES_BAJOS>`; está vacía por defecto en todas las operaciones. No se fija una URL de identidad ni se afirma un grant efectivo.

`COMBOS_AMQP_ENABLED` acepta solo `true` o `false`; si se activa, `COMBOS_AMQP_URL` es obligatoria. La cola contractual es `po.combos.q`. El acceso al contexto de Catalog vía HTTP para eventos de SKU requiere `COMBOS_CATALOG_CONTEXT_AUTHORIZED=true`, sujeto a autorización real de red/grant. `COMBOS_RESTRICTED_DEMO_ENABLED` permanece separado del selector y del JWT; su perímetro de red no sustituye autenticación ni otorga permisos.

Configuración incompleta o inválida falla cerrada. Readiness depende de PostgreSQL y, si AMQP está habilitado, de conexión, canal y suscripción activa. `/health` es liveness; `/ready` no devuelve secretos.

## HTTP y autorización

Rutas bajo `/api/v1`: `GET /combos`, `POST /combos`, `GET /combos/:comboId`, `PATCH /combos/:comboId`, `POST /combos/:comboId/desactivar` y `GET /combos/:comboId/disponibilidad`; además `/health` y `/ready` fuera del prefijo.

En `SIMULATED_AUTH` se exige JWT RS256 del emisor simulado independiente, con audience, vigencia, tipo de identidad y claims de roles/scopes válidos. En `G7_AUTHENTICATED` se valida issuer/discovery/JWKS G7 y se rechaza un emisor simulado. `PUBLIC_READ_ONLY` conserva el acceso autenticado y no habilita hoy rutas anónimas: las lecturas de la matriz siguen `PENDIENTE_VERIFICACION`. Se distingue 401 (credencial inválida/ausente), 403 (identidad válida sin permiso), y 503 (proveedor de identidad indisponible). OpenAPI declara `userBearer` para las seis operaciones y `serviceBearer` más scope `combos:leer` para `obtenerCombo` y `consultarDisponibilidadCombo`. No publica roles humanos ni clientes permitidos; no se inventan. La asignación efectiva de roles/grants requiere acuerdo externo y configuración explícita.

La disponibilidad permanece informativa; no representa una reserva ni disponibilidad de cesta completa. No se añade canal al DTO: DEC-G6-INT-11 requiere un mismo instante UTC, canal y moneda en precios, pero la interfaz de Combos no aporta un canal seleccionable. Se conserva la frontera sin inventar un canal.

## Datos y eventos

Catalog es autoridad de identidad, actividad y elegibilidad SKU; Pricing, de precios y vigencia. El servicio consulta Catalog antes de escritura y compara precios con aritmética entera en centavos. La evaluación de elegibilidad es interna y no añade campos contractuales. La proyección de baja conserva la observación de Catalog y evita que eventos históricos superados bloqueen reactivación o reviertan una observación nueva.

Inbox conserva deduplicación y fallos durables. Los eventos inválidos se registran; fallos persistentes se reintentan hasta tres veces y el consumer se pausa sin ACK conforme a DEC-G6-INT-12. El apagado drena trabajo activo antes de cerrar canal y conexión. No se suscribe a `pricing.price.changed`.

## Validación

En entorno con dependencias locales disponibles:

```bash
npm test -- apps/combos-svc/src
npm run build:combos-svc
npm run typecheck
npm run lint -- apps/combos-svc
bash apps/combos-svc/test/run-postgres-isolated.sh
```

El runner aislado necesita Docker, certificados/volúmenes locales temporales y las migraciones oficiales de Docs en `../docs` o `COMBOS_TEST_DOCS_ROOT`. Un resultado local no acredita CI, grant real, homologación ni despliegue. `COMBOS_TEST_EPHEMERAL=1` solo se habilita dentro de los runners locales de prueba.

## Pendientes externos y despliegue

Owner de identidad/plataforma: provisionar endpoint de token, issuer/discovery/JWKS y credencial `modulo-productos`; desbloqueo verificable: emisión client_credentials de `api-productos` con scopes Catalog/Pricing y validación autenticada desde el runtime. Owners de consumidores/API: homologar roles/scopes por cada `operationId`; desbloqueo: asignación contractual aprobada y grants probados. Owner de red/Oracle: confirmar egress/DNS/CA a Catalog, Pricing, G7 y RabbitMQ; desbloqueo: prueba TLS/autenticada en entorno destino. Owner de negocio/arquitectura: resolver canal comercial de Combos conforme a DEC-G6-INT-11; desbloqueo: decisión/documento contractual aprobado sin alterar unilateralmente OpenAPI.

Pricing real: no se acredita E2E hasta que el owner de Pricing habilite un provider Catalog autoritativo en su runtime y autorice contractualmente `modulo-productos` con `precios:leer` en el guard de lecturas comerciales. En el checkout actual, `PRICING_CATALOG_CONTEXT` se registra como `null` y el guard solo permite `modulo-marketplace`, `modulo-chatbot` y `modulo-retail`; no se altera ese otro bounded context ni se simula Pricing con un servidor que imite su DTO.

La respuesta actual de contexto SKU de Catalog no aporta una versión monotónica de estado que permita ordenar de forma autoritativa la observación HTTP con `changed_at` de eventos, especialmente con relojes desincronizados. Combos captura el inicio de cada lectura y vuelve a enumerar SKU bajo el advisory lock antes de aplicar una baja de producto; esto cierra la omisión de referencias creadas durante la enumeración, con reintentos locales acotados. La exclusión estricta de una baja concurrente a la lectura requiere versión/revisión autoritativa de Catalog en contexto/evento o un mecanismo de fencing homologado; hasta esa adaptación, no declarar garantía distribuida estricta.

No declarar `READY_FOR_DEPLOY` hasta adjuntar evidencia ligada al SHA para build, configuración, persistencia, mensajería, seguridad, contratos, Docker y readiness según `ops/oracle/CHECKLIST_PREDEPLOY.md`.
