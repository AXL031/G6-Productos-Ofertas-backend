# PR #143 — transporte autenticado e invalidaciones

Revisión solicitada sobre `0b1ba5ec88523687330233ed5b8aa030e580b2b1`, rama `cueva`. Alcance #73/#75/#144: aclaraciones junto al código, pruebas de comportamiento y este informe. No se cambia la lógica del transporte o de las invalidaciones, ni se implementan componentes de otros owners, recuperación nueva, flags, contratos o migraciones. El nuevo HEAD y su CI se registran en el mismo PR sin reemplazar la evidencia del corte anterior. El PR permanece draft.

Fuentes: OpenAPI `0.6.0-rc.2` (blob `54164d48c7919854ac4636a27162ab880cb202aa`), AsyncAPI `0.6.0-rc.4` (blob `52443be2510c6ca344b4cd18689c21d8245d5766`), SPEC-005/006/007, DEC-F-007/008/009/012, INT-01/06/07/13, `ops/oracle/CONTRATO_DESPLIEGUE.md` y política #144. Las verificaciones de red, permisos y proveedores compartidos siguen siendo evidencias externas independientes.

## 1. Token de servicio y condición de red privada

`internal-http.ts` es un transporte de lectura. El modo por defecto es AUTHENTICATED; solicita al callback el token propio para operationId, audiencia `api-productos` y scope de esa operación. No recibe el bearer del usuario ni fabrica identidad. Si falta token, falla antes de enviar HTTP; nunca cambia a demo. `PROMOTIONS_SERVICE_TOKENS` sigue sin proveedor G7 real en el módulo: configurar URLs no acredita ni habilita credenciales reales.

La validación de origen admite HTTPS; HTTP se limita a loopback o al alias exacto del servicio configurado (`catalog-svc`, `pricing-svc`, `inventory-svc`, `taxonomy-svc`). Rechaza HTTP público, IP privada arbitraria, alias ajeno/sufijos, credenciales en URL, path, query y fragmento. **Una cadena de alias aceptada no prueba DNS privado, destino efectivo ni confidencialidad.**

En AUTHENTICATED, el bearer viaja en claro cuando el esquema es HTTP. Por tanto, **antes de configurar tokens reales para esos aliases**, Marco/infra debe verificar y aportar evidencia de:

- Emisor y destino en la red privada autorizada `g6-http`, alias asociado al contenedor correcto y resolución/ruta efectiva desde Promotions; no DNS público ni alias controlado por otra carga no confiable.
- Aislamiento de esa red frente a terceros, cargas no autorizadas y entrada pública; sin publicación directa de puertos de negocio. `g6-edge` corresponde al Gateway, no a estos clientes internos.
- Captura/configuración no secreta y smoke por SHA/imagen/entorno que identifiquen el destino. No registrar el token para demostrarlo.

Loopback se reserva a procesos de confianza en el mismo host/namespace; no identifica otro contenedor. Si no se puede asegurar la confidencialidad del enlace, se requiere TLS con validación de certificado y configuración/red autorizadas antes de habilitar la llamada; no se debe enviar bearer por HTTP a una red no verificada. El código comprueba la forma de la URL, no realiza una auditoría de infraestructura ni pinning DNS. No se añade un booleano que finja esa evidencia.

`redirect: 'error'` impide seguir redirecciones con credenciales; cookies omitidas, correlación nueva, respuesta JSON/UTF-8 de hasta 1 MiB y cancelación/deadline del adaptador se conservan. RESTRICTED_DEMO no adquiere ni envía tokens y conserva su gate de red privado; tampoco prueba G7. Las pruebas usan tokens sintéticos identificados y servidores HTTP de test, nunca credenciales reales ni providers compartidos.

## 2. Efecto exacto de consultar Inbox

El dispatcher rc.4 persiste en una transacción propia el resultado `handled:true`, `completed_at` e `invalidation` en Inbox para un evento válido. El rechazo durable usa `handled:false/rejected:true` y no crea invalidación. Un fallo SQL revierte y no permite ACK. El runtime compartido sigue protegido.

`PromotionsRepositories.inbox(messageId, handler)` hace únicamente SELECT del recibo por ambas claves: no consume la fila, modifica `completed_at`, confirma un mensaje, refresca caché ni quita una invalidación. La consulta de replay del dispatcher es distinta: usa `fn_begin_inbox` y devuelve el resultado ya completado sin reaplicar el evento. Tampoco restaura las proyecciones.

`price()` y `stock()` consultan primero la existencia de una invalidación completa y manejada del handler `promotions-assigned-events-v1` en Inbox. Si existe, devuelven `undefined` sin leer la proyección. No convierten ausencia de caché en precio cero o `AGOTADO`. Si no existe, hacen el SELECT de proyección. Es una consulta adicional a Inbox por lectura; `LIMIT 1` limita filas devueltas, no garantiza coste constante ni evita recorrer historial. No se añaden índices ni una política de retención sin alcance/decisión.

Las lecturas normales usan una transacción REPEATABLE READ READ ONLY: comprobación y proyección comparten snapshot. Un evento confirmado después del inicio de ese snapshot se observa en la siguiente transacción, no retroactivamente. Error/timeout/permisos SQL fallidos propagan `PromotionsPersistenceError` sanitizado; no se recupera una proyección como fallback ante un fallo de Inbox.

## 3. Alcance y recuperación

| Marcador durable | Efecto de la lectura de caché |
| --- | --- |
| Precio SKU, canal concreto | Oculta ese SKU/canal. No oculta su proyección global ni otros canales por sí solo. |
| Precio SKU, canal null | Oculta ese SKU en todos los canales, incluido global. |
| Precio PRODUCTO, canal concreto | Oculta conservadoramente todos los SKU de ese canal: no existe mapa local completo producto→SKU para reducir el alcance. |
| Precio PRODUCTO, canal null | Oculta conservadoramente todos los SKU/canales. |
| Stock SKU/location | Oculta la disponibilidad cacheada del SKU; location/version se conservan como procedencia. No se suman ubicaciones ni se compara `stock_version` como versión global del SKU. |

**Los marcadores son persistentes; no existe recuperación automática de estas proyecciones.** No se comparan sus versiones/fechas con la fila de caché. Una proyección posterior o de versión mayor sigue oculta; una nueva instancia de repositorio/reinicio tampoco borra Inbox. Una respuesta HTTP correcta no actualiza estas tablas ni elimina el marcador. La lógica comercial registrada consulta HTTP autoritativo y puede operar cuando el proveedor real está disponible, sin reutilizar caché invalidada. Fallo de esa fuente mantiene el error técnico contractual, sin fallback ficticio.

No borrar/truncar Inbox, cambiar `handled`, omitir su consulta o actualizar solo la proyección como mecanismo de recuperación: retirar el marcador podría volver visible una fila vieja. Antes de cualquier retención/rehidratación, Axel + BD/Marco deben definir y aprobar frescura, concurrencia, persistencia atómica y preservación de idempotencia. Esta revisión no introduce ese mecanismo ni declara refresco homologado. Las invalidaciones antiguas válidas pueden mantener la caché oculta de forma conservadora; no se infiere orden global desde versiones por entidad/ubicación.

## 4. Verificaciones y trazabilidad

`src/infrastructure/http/internal-http.spec.ts`: rechazo de orígenes indebidos antes de pedir token, credencial propia y scope por operación, default autenticado, ausencia de token sin envío anónimo, redirección no seguida y demo sin token. No prueba aislamiento físico ni grants.

`test/support/h4-invalidation-checks.mjs`, ejecutado por `persistence.isolated.smoke.mjs` con PostgreSQL/TLS real descartable: matriz SKU/producto/canal/global, versiones de stock por ubicación, consultas repetidas a Inbox sin cambios, recreación del provider, proyecciones actualizadas que siguen ocultas, rechazo que no invalida otro SKU y replay durable. Envelope/procedencia de test son explícitos; no se activa ningún consumidor compartido.

Los resultados nuevos se adjuntan al PR por HEAD tras ejecutarlos; no se deducen de este texto. Evidencia anterior conservada:

- [CI de `0b1ba5e`](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/41466937743): SUCCESS, 16 comprobaciones, E2E remoto 924 PASS/106 omitidas.
- Windows local del mismo corte: DATA-002 de Catalog `postgres.persistence.e2e-spec.ts:882` falló dos veces (6338/6312 ms, límite 5000 ms). Archivo idéntico a master; [comunicación a Poma](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/51#issuecomment-6579561813) y excepción expresa de Axel para publicar en cueva. No se cambian pruebas ajenas ni timeouts y el PASS remoto no borra ese FAIL local.
- [Entrega por SHA/imagen/entorno de `0b1ba5e`](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/143#issuecomment-6580461261), flujo local CLEAN y digest de imagen. No se atribuye esa imagen automáticamente a un HEAD posterior.

Validación local del árbol de esta revisión, antes de confirmarlo como hijo de `0b1ba5e`:

| Comando | Resultado ejecutado |
| --- | --- |
| `npm test -- apps/promotions-svc --maxWorkers=1` | PASS, 327 pruebas (incluye 11 de la frontera de credenciales). |
| `npm test -- --maxWorkers=2` | PASS, 1643 pruebas; 47 optativas omitidas. |
| `npm run test:e2e -- apps/promotions-svc --maxWorkers=1` | PASS, 11 pruebas en dos suites. No sustituye al E2E general. |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | PASS; lint sin advertencias. |
| `npm run build:promotions-svc` | PASS. |
| `G6_TEST_OPENSSL=<OpenSSL existente>; node apps/promotions-svc/test/persistence.isolated.smoke.mjs` | PASS, 22 grupos; PostgreSQL/TLS real, runtime restringido y fixtures declarados. `sharedWrites:false`, integración externa no probada. |
| `git diff --check` | PASS. |

No se repite ni se modifica la prueba de Catalog que agotó su timeout dos veces; se conserva el FAIL local anterior. La excepción expresa de publicación concedida por Axel y la solicitud de actualizar este mismo PR permiten publicar el seguimiento y verificar una CI nueva, manteniendo esa evidencia y el draft. CI del nuevo HEAD, homologación y despliegue se informan separadamente.

## 5. Integraciones compartidas que siguen pendientes

| Owner | Operación afectada | Desbloqueo verificable |
| --- | --- | --- |
| Poma | `obtenerProducto`/`obtenerContextoSku`, referencias y cesta solo SKU | SHA/URL y permiso de lectura/demo privada; datos aprobados y prueba HTTP real positiva/negativa. |
| Vera (+ Poma contexto) | `obtenerPrecioSku`, evaluación/recomendaciones | Contexto Catalog y canales conectados; precio efectivo/herencia/override/instante y fallos por HTTP real identificado. |
| Taco | `consultarDisponibilidadComercial` | Permiso preciso y origen de Promotions, cuatro estados por canal/lote y errores con proveedor real. |
| López | `obtenerCategoriaAdmin` | Endpoint/DTO y autorización rc.2; categoría activa/inactiva/ausente y fallo técnico vía HTTP real. |
| Marco/infra + G7 | Transporte con token real y activación Oracle | Red/DNS/confidencialidad verificados, issuer/JWKS/grants y positivos/negativos por SHA/entorno; release autorizado aparte. |
| G5/Inventario + Marco/infra | Consumidor/pump compartido | Reserva efectivamente confirmada, snapshot durable, procedencia/ACL/bindings/red y prueba bilateral. |

Los fixtures comprueban adaptadores/SQL propios; no acreditan ninguna fila compartida de esta matriz. Se conservan los [pendientes y solicitudes existentes](H4-REVISION-2026-11-02.md). Estado IMPLEMENTAR_PARCIAL, sin DATA, despliegue, consumidores compartidos ni READY_FOR_DEPLOY.
