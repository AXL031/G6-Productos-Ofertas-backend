# Configuración de inventory-svc

Esta tabla describe las variables que lee actualmente `inventory-svc`. No contiene credenciales. Los valores entre `<...>` son marcadores que deben sustituirse por el owner indicado; no son secretos válidos.

| Variable | Requisito | Ejemplo seguro | Funcionalidad | Si falta | Owner |
|---|---|---|---|---|---|
| `DATABASE_URL` | Obligatoria para operar; alternativa a las variables `PG*` | `<URL PostgreSQL de runtime aprovisionada>` | Pool PostgreSQL, Drizzle, reservas, saldos, operaciones, Kardex y Outbox | El servicio inicia sin pool y las operaciones persistentes no están disponibles | Infraestructura G6 / Supabase |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Alternativa completa a `DATABASE_URL`; host, base, usuario y contraseña requeridos; puerto opcional (5432) | `<host privado>`, `5432`, `<base inventory>`, `<usuario runtime>`, `<secreto aprovisionado>` | Configura el pool PostgreSQL | Sin `DATABASE_URL` ni credenciales requeridas no hay conexión DB; si `PGPORT` está presente debe ser entero 1–65535, en caso contrario el arranque falla (fail-closed) | Infraestructura G6 / Supabase |
| `PGSSLMODE` | Opcional | `require` | Modo SSL al crear conexión por parámetros `PG*`; `disable` desactiva SSL | El cliente aplica configuración SSL predeterminada | Infraestructura G6 |
| `PGSSLROOTCERT` | Opcional | `<ruta del certificado CA montado>` | Certificado CA para validar PostgreSQL remoto | Se usa validación TLS predeterminada del cliente | Infraestructura G6 |
| `RABBITMQ_URL` | Opcional para arranque; requerido para publicar y consumir mensajes | `<URL RabbitMQ/vhost runtime aprovisionada>` | Despacho Outbox y consumidor de `po.inventario.q` | Outbox conserva eventos `PENDING`; el consumidor no conecta sin URL | Infraestructura G6 / owner RabbitMQ OCI |
| `G7_JWT_PUBLIC_KEY` | Obligatoria para endpoints protegidos; acepta PEM | `<PEM público provisionado por Seguridad>` | Verificación local RS256 | Fallo cerrado: token rechazado por falta de clave confiable | Seguridad G7, provisionada por Infraestructura |
| `JWT_PUBLIC_KEY` | Compatibilidad opcional; alternativa heredada a `G7_JWT_PUBLIC_KEY` | `<PEM público provisionado por Seguridad>` | Misma verificación RS256 cuando no está `G7_JWT_PUBLIC_KEY` | Sin ninguna clave configurada, endpoints protegidos rechazan tokens | Seguridad G7, provisionada por Infraestructura |
| `G7_JWT_ISSUER` | Obligatoria para endpoints protegidos | `<issuer acordado y configurado por G7>` | Validación del claim `iss` | Fallo cerrado; token rechazado | Seguridad G7 |
| `INVENTORY_DEMO_NO_AUTH_ENABLED` | Opcional; `false` por defecto | `false` | Excepción temporal solo para GET comercial y POST verificador, según #25/#100 | Conserva JWT y autorización productivos; valores distintos de `true`/`false` impiden arrancar | Taco / coordinación Gateway #107 |
| `INVENTORY_DEMO_GATEWAY_IPS` | Obligatoria si la excepción anterior está activa | `<IP privada exacta del Gateway>` | IPs literales separadas por comas, verificadas contra el peer TCP; admite IPv4/IPv6 | Demo activa sin IPs válidas impide arrancar; no admite hosts, CIDR ni comodines | Infraestructura G6 / Marco |
| `INVENTORY_SVC_PORT` | Opcional | `3005` | Puerto HTTP del servicio; precede a `PORT` | Usa `PORT` o `3005` | Owner inventory-svc |
| `PORT` | Opcional | `3005` | Puerto HTTP de respaldo | Usa `3005` | Plataforma de despliegue |
| `RESERVATION_TTL_SECONDS` | Opcional | `900` | Duración de la reserva antes de expirar | Usa `900`; entero positivo | Owner inventory-svc / Ventas para acuerdo operativo |
| `DEFAULT_LOW_STOCK_THRESHOLD` | Opcional | `5` | Umbral de disponibilidad baja por defecto | Usa `5`; si está presente debe ser un entero >= 0, en caso contrario el arranque falla (fail-closed) | Owner inventory-svc |
| `INVENTORY_WORKER_INTERVAL_MS` | Opcional | `5000` | Frecuencia de worker de expiración y Outbox (mínimo 250 ms) | Usa `5000` | Owner inventory-svc |
| `INVENTORY_WORKER_BATCH_SIZE` | Opcional | `50` | Máximo de reservas/eventos por pasada (1–500) | Usa `50` | Owner inventory-svc |

## Endpoints de salud y readiness

- `GET /health` — **liveness** público. Responde `200` con `{ "status": "ok", "service": "inventory-svc" }` mientras el proceso esté vivo. No verifica dependencias.
- `GET /health/readiness` — **readiness** público. Verifica únicamente dependencias propias del servicio:
  - Responde `200` con `{ "status": "ready", "service": "inventory-svc" }` cuando PostgreSQL es alcanzable.
  - Responde `503` con `{ "status": "not_ready", "service": "inventory-svc" }` cuando PostgreSQL no responde.
  - El broker RabbitMQ es opcional: su ausencia conserva eventos `PENDING` en el Outbox y no marca el servicio como no listo.
  - La respuesta nunca expone DSN, credenciales, rutas ni detalles internos.

## Arranque fail-closed

El servicio valida la configuración de arranque (`loadInventoryConfig`) antes de escuchar. Un valor inválido en `INVENTORY_SVC_PORT`/`PORT`, `RESERVATION_TTL_SECONDS`, `DEFAULT_LOW_STOCK_THRESHOLD`, `INVENTORY_WORKER_INTERVAL_MS`, `INVENTORY_WORKER_BATCH_SIZE` o `PGPORT` detiene el arranque con `exit(1)` en lugar de continuar con un valor por defecto silencioso.

Los valores numéricos explícitos deben representar enteros decimales seguros; una cadena vacía o solo espacios es inválida, incluso para `PGPORT`. Los valores predeterminados se aplican únicamente cuando la variable está ausente. El intervalo del worker admite de 250 a 2147483647 ms para evitar el desbordamiento del temporizador. Los errores identifican la variable y el rango sin imprimir su valor. Cuando no se usa `DATABASE_URL`, deben estar presentes `PGHOST`, `PGDATABASE`, `PGUSER` y `PGPASSWORD`; el servicio no sustituye una base ausente por `postgres` ni una contraseña ausente por una cadena vacía.

## Acceso humano y técnico

Las rutas administrativas de Inventario requieren un JWT humano con firma RS256, `iss` igual a `G7_JWT_ISSUER`, `aud` que incluya `api-productos`, `sub` no vacío, `exp` futuro y rol `GESTOR_COMERCIAL`. Las capacidades locales de traslados se verifican adicionalmente. Un token `tipo=servicio` no habilita las rutas humanas aunque contenga un rol.

`GET /api/v1/inventario/disponibilidad` admite esa vía humana y la vía técnica contractual de Ventas/Postventa. La vía técnica conserva sus scopes/allowlists y el guard de Inventario; Marketplace/Chatbot/Retail siguen limitados a consultas comerciales. Si hay saldos en varias ubicaciones, la consulta detallada exige `location_id` explícito. La consulta de operaciones sigue siendo exclusiva de Ventas y no admite JWT humano.

## Excepción comercial para demo vía Gateway (#25/#100/#107)

Con `INVENTORY_DEMO_NO_AUTH_ENABLED=true`, únicamente `consultarDisponibilidadComercial` (GET `/api/v1/inventario/disponibilidad/comercial`) y `verificarCantidadComercial` (POST de esa ruta más `/verificar`) admiten la excepción sin JWT cuando `request.socket.remoteAddress` pertenece a `INVENTORY_DEMO_GATEWAY_IPS`. El modo demo del Gateway se activa por separado con `GATEWAY_DEMO_NO_AUTH_ENABLED`; no habilita automáticamente Inventario. Ambos están apagados por defecto. Activar una variable de entorno en una prueba no demuestra activación ni autorización de exposición en runtime.

La comparación normaliza IPv4, IPv6 y direcciones IPv4 mapeadas. No confía en `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `request.ip`, headers de modo demo ni en `trust proxy`. No se introdujeron headers ni tokens nuevos. La solicitud se marca internamente, conserva la validación del enum de canal y de los datos de negocio, y no recibe `user`, `sub`, `clientId`, roles ni scopes inventados. `canal`/`channel_id` es contexto comercial declarado, no identidad autenticada. Al apagar el flag, se restaura la correspondencia canal/cliente verificado y el JWT productivo existente.

El guard de Inventario permanece instalado. La excepción se limita a esos dos handlers y sus métodos exactos; disponibilidad detallada, dashboard, umbrales, traslados, operaciones y todas las escrituras conservan sus requisitos de autorización. El soporte anónimo adicional requiere conciliar el alcance específico de #25/#100 con #107; no se deduce que el bypass del Gateway habilite automáticamente permisos upstream.

Infraestructura debe mantener puertos de Inventario, PostgreSQL y RabbitMQ privados y configurar las IPs de salida reales del Gateway. Una IP permitida identifica el salto de red, no un proceso: otros procesos que compartan esa IP/NAT también pueden llegar a esa excepción. Los proxies compartidos, el puerto público de Inventario y el aislamiento de datos no se resuelven con CORS ni con esta allowlist. Las pruebas usan loopback y datos sintéticos en memoria; no acreditan firewall, aislamiento del entorno desplegado ni permisos mínimos de PostgreSQL/RabbitMQ.

En la revisión `32153bffb35daa8761272c7b55fe23dc1df70007` del Gateway (PR #130, integrado en `master@6bf7ddb`), los códigos de error del POST verificador figuran vacíos en `CONTRACT_ROUTES`. La integración HTTP reproduce que 400/401/422/503 correctos de Inventario se convierten en 500 `ERROR_INTERNO`. El GET conserva sus errores. Marco, owner de #107, debe incorporar los `x-error-codes` del OpenAPI vigente al registro y revalidar. La prueba de caracterización documenta el defecto; no lo considera comportamiento aceptable ni acredita cierre de #25/#100.

## Mensajería, recuperación y límites locales

El consumidor comprueba la existencia de `po.inventario.q`, usa prefetch 20 y ACK manual posterior al commit de Inbox, saldo, operación y resultado Outbox. No crea ni modifica exchanges, colas, bindings ni permisos. La inicialización SKU de Catálogo es la única entrada con handler implementado en este bloque: crea saldo cero con versión cero y conserva saldos existentes. Otro `message_id` con la misma operación devuelve el resultado durable con `causation_id` del nuevo intento; una entrega idéntica no repite efectos ni resultados.

`inventory.bulk.stock.adjust.requested` y `catalog.sku.deactivated` quedan aislados con `BLOCKED_CONTRACT`: el AsyncAPI consultado declara `GenericData`, sin payload ejecutable suficiente. Un mensaje inválido, un contrato bloqueado o un fallo técnico pausa el consumidor y cierra el canal sin ACK. RabbitMQ puede volver a poner las entregas pendientes en la cola al cerrar el canal; este proceso no reconecta automáticamente mientras esté pausado. Requiere resolver la causa y llamar internamente a `resume()` o reiniciar. Un mensaje persistente incompatible puede bloquear el avance de esa cola compartida. No hay endpoint público de reanudación, retry/DLX productivo ni publicación a colas alternativas. La pérdida de conexión sin pausa programa reconexión a los 30 s.

### Topología física AMQP adoptada (Resolución #29 / AsyncAPI 0.6.0-rc.3)

El código adopta los nombres físicos en español homologados con la topología Oracle (RabbitMQ 4.2.9, vhost `g6-productos-ofertas`) y el contrato AsyncAPI `0.6.0-rc.3`:

| Elemento | Nombre en código (AsyncAPI 0.6.0-rc.3) | Referencia histórica (0.6.0-rc.2) | ACL `g6_inventario` | Estado |
|---|---|---|---|---|
| Cola consumida | `po.inventario.q` | `po.inventory.q` | read `po.inventario.q` | Alineado con ACL |
| Exchange de eventos | `po.eventos.x` | `po.events.x` | write `po.eventos.x` | Alineado con ACL |
| Exchange de resultados | `po.resultados.x` | `po.results.x` | write `po.resultados.x` | Alineado con ACL |
| Configure | — | — | ninguno (`^$`) | El servicio no crea ni altera recursos |

*Nota histórica:* Previo a la actualización AsyncAPI 0.6.0-rc.3 y la resolución #29, el código utilizaba los identificadores en inglés del AsyncAPI 0.6.0-rc.2 (`po.inventory.q`, `po.events.x`, `po.results.x`) frente a la topología física en español. Con la actualización de contrato y código, los recursos coinciden plenamente con los permisos del usuario de servicio.

**Independencia HTTP/PostgreSQL:** `RABBITMQ_URL` es opcional al arranque; sin
broker el proceso sirve HTTP y mantiene los eventos en Outbox como `PENDING`.
`/health/readiness` solo depende de PostgreSQL. La pausa del consumidor no
bloquea HTTP ni las transacciones. El estado AMQP se consulta aparte en
`getMetrics()`. Un deploy HTTP/DB es viable con AMQP bloqueado; eso no acredita
el flujo de eventos.

Para recuperar una pausa, consultar internamente `getMetrics().pauseReason` y resolver primero su causa: `BLOCKED_CONTRACT` requiere contrato ejecutable y handler revisados con Marco y el productor; `INVALID_MESSAGE` requiere corregir el productor y acordar con Infra el tratamiento de la entrega retenida; `DEPENDENCY_OR_PROCESSING_FAILED` requiere restablecer la dependencia y verificar el estado durable. Llamar a `resume()` o reiniciar sin esa resolución puede volver a pausar la misma cola. La reanudación es una llamada interna del proceso o un reinicio coordinado con Infra, no una nueva ruta HTTP. Tras reanudar, contrastar ACK/duplicados/fallos con Inbox, operación y Outbox; readiness de PostgreSQL por sí solo no demuestra recuperación del consumidor.

La prueba real del consumer se prepara en `test/inventory.real.integration.spec.ts`: cola quorum y binding de inicialización únicamente en el vhost efímero propio, entrega duplicada, replay de operación, rechazo durable y retención/redelivery de JSON inválido. Retirar y confirmar ese fixture corrupto es una acción exclusiva de la prueba para poder comprobar `resume()`, no una autorización para descartar mensajes productivos. Esta cobertura debe ejecutarse con `INVENTORY_REAL_INTEGRATION=1`; las omisiones locales no acreditan su resultado ni homologación de topología/retry/DLX.

El modelo físico vigente usa UUID para `message_id` y correlación de operación; el consumidor exige UUID para ambos. El envelope AsyncAPI general admite cadenas más amplias: esa discrepancia necesita resolución contractual antes de admitir otros identificadores. La validación no equivale a autenticación del productor: el aislamiento efectivo depende de credenciales/vhost/grants RabbitMQ provisionados.

Límites actuales: conexión PostgreSQL 5 s, lock 5 s, sentencia 15 s y espera de consulta 20 s; conexión AMQP con timeout de socket 5 s, creación de canal/checkQueue/prefetch/consume 5 s, confirm de publicación 3 s y cierre AMQP 3 s. Un deadline limita la espera y no cancela efectos ya enviados. Outbox conserva el mismo `message_id` al reintentar: entrega al menos una vez, con deduplicación a cargo del receptor. Sus lotes están limitados a 10 eventos, incluso si la configuración del worker es mayor. La expiración y el despacho se ejecutan por separado dentro del ciclo; un error de expiración no impide intentar Outbox.

`InventoryConsumerService.getMetrics()` informa conexión, pausa, recibidos, ACK, duplicados, rechazos, fallos y reconexiones. `InventoryWorkersService.getMetrics()` informa ciclos, fallos de expiración/publicación y duración del último ciclo. Son contadores locales en memoria accesibles por instrumentación interna; se reinician con el proceso y no hay endpoint/exportador de métricas implementado. Los errores nuevos pasan por `SanitizedLogger`; no se registra el cuerpo del comando y los errores de JSON se sustituyen por `INVALID_MESSAGE` para evitar fragmentos del payload en logs. Readiness sigue comprobando PostgreSQL y no demuestra salud del consumidor ni homologación de RabbitMQ.

## Variables exclusivas de pruebas aisladas

La suite real se habilita con `INVENTORY_REAL_INTEGRATION=1`. No requiere ni consume URLs de prueba o runtime configuradas manualmente: aprovisiona PostgreSQL y RabbitMQ efímeros mediante Docker, genera credenciales aleatorias por ejecución, publica puertos dinámicos ligados a loopback y crea un vhost de pruebas. La suite conserva la etiqueta única de ejecución y solo elimina los contenedores, volúmenes y red que tengan esa etiqueta. Necesita Docker CLI con acceso a un daemon activo y capacidad para descargar las imágenes si aún no están disponibles. Sin la variable de activación, Vitest omite estos casos; activados sin Docker operativo, fallan durante el aprovisionamiento.

La suite depende expresamente del repositorio hermano `docs`, ubicado junto a `backend` en el checkout de trabajo. Antes de ejecutarla, revisa y sincroniza el repositorio contractual para que sus migraciones de Inventario correspondan a la revisión que se está validando. La suite lee y aplica en la base temporal vacía `docs/datos/inventory-svc/migration.sql` y `docs/datos/inventory-svc/migrations/0002_order_id_operaciones_disponibilidad.sql`; no mantiene copias de estas migraciones en backend ni las ejecuta contra Supabase compartido. Si el modelo físico o las migraciones oficiales cambian, revisa primero esos archivos del repositorio `docs` y confirma que la suite aplique el conjunto vigente antes de interpretar sus resultados.

La conexión de runtime con Supabase/RabbitMQ OCI, los usuarios y permisos, así como la distribución de claves/issuer G7, siguen pendientes del frente de infraestructura y seguridad. Este documento no indica que esas conexiones existan ni estén operativas.

## Marketplace H4: seguridad y cumplimiento

El cliente contractual Marketplace es `modulo-marketplace`, audiencia `api-productos`, con `inventario:disponibilidad:leer` y allowlist publicada para cada una de las dos operaciones comerciales. La excepción `INVENTORY_DEMO_NO_AUTH_ENABLED` solo habilita demo acotado a las rutas GET disponibilidad comercial y POST verificador desde IPs del Gateway permitidas; no valida token ni cumple autenticación H4. No copiar secretos ni declarar grant G7 a partir de scopes del YAML.

GET comercial devuelve `DISPONIBLE`, `STOCK_BAJO`, `AGOTADO` o `INDETERMINADO`, sin saldo ni ubicación. D-INV-01 prohíbe agregar existencias entre ubicaciones independientes: usar fuente única de cumplimiento ejecutable. POST verificador recibe contexto MARKETPLACE/ENVIO_DOMICILIO y líneas con SKU/cantidad; `fulfillment_ref` solo cuando su owner haya definido referencia válida. `binding=false`; no crea reserva. Contexto inválido puede ser 422; fuente única no resoluble produce `INDETERMINADO` HTTP 200.

Consultar operación vigente y condición de despliegue en la [matriz Marketplace H4](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/castilla/integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md). PR #10 es draft; el CI de SHA `b026158` no se debe citar como CI de una punta documental posterior.
