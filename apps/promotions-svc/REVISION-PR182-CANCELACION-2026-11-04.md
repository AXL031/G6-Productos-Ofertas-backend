# PR #182 — sincronización y cancelación HTTP

## Historial preservado

`cueva` incorpora `master@41ce14092f6031eb9cd521e3eaaa8cc24fc6ed4f` mediante
merge convencional `0636427fbf6243eb6aa83581eff62f86d04e786c`, sin conflictos.
Sus padres son `20f09d5d83d37d3938cd7ae777061fe3966151bf` y el master indicado.
No se hizo rebase, squash, force push ni merge de la PR hacia master.
Los cambios de otros owners provienen íntegramente de ese merge autorizado;
las correcciones adicionales están solo en `apps/promotions-svc/`.

Las siete evidencias JSON de integración anteriores se conservan byte por byte.
Sus hashes se verificaron contra `20f09d5` y constan en la
[evidencia nueva](test/evidence/http-cancellation-review-2026-11-04.json).
No se atribuyen los 61 escenarios históricos con proveedores `7f1ffc1` al nuevo
master `41ce140`, ni se reescribe la procedencia de `dec96b8`.

## Corrección de cancelación

`PromotionsQueryService.execute` crea una señal vinculada a la conexión HTTP
directa del cliente de Promotions y la pasa a `basket`, `recommendationOrigin`
y `recommendationProducts`, reemplazando el anterior `undefined`.
El wrapper comercial conserva su deadline interno de 2500 ms y combina ambas
señales; los adaptadores nativos la transmiten a las llamadas salientes.

El bridge escucha `request.aborted` y `response.close` si la respuesta aún no
terminó (`!writableFinished`). **No escucha `request.close`**: terminar de recibir
un POST normal no significa que el cliente haya abandonado la respuesta.
Los listeners se retiran al terminar o fallar la consulta. Un cliente ya
desconectado no inicia el trabajo, y una señal no afecta a otras solicitudes.

## Prueba con sockets reales

[http-cancellation.e2e-spec.ts](test/http-cancellation.e2e-spec.ts) levanta Nest
con sus guard/query/adaptadores nativos, JWT RS256 local y un upstream HTTP real
en loopback. Persistencia, credencial saliente y datos comerciales son fixtures
explícitos. No se sustituye `fetch` ni se simula el evento de desconexión en E2E:
se destruye el socket del cliente y se observa `close` en el upstream pendiente.

| Escenario                                | Aserción verificada                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Evaluar: contexto SKU pendiente          | Cierra socket saliente; no llega a la lectura de persistencia                                           |
| Validar cupón: contexto SKU pendiente    | Cierra socket saliente; no llega a la lectura de persistencia                                           |
| Recomendar: producto origen pendiente    | Cierra socket saliente; no inicia otra lectura comercial                                                |
| Recomendar: producto candidato pendiente | Cierra socket saliente; no inicia Inventory/Pricing                                                     |
| Recomendar: Inventory pendiente          | Cierra socket saliente; no inicia Pricing                                                               |
| Recomendar: Pricing pendiente            | Cierra socket saliente sin producir un resultado parcial                                                |
| POST completo con cliente conectado      | Sigue esperando; al completar upstream devuelve HTTP 200 y resultado 80                                 |
| Upstream colgado, cliente conectado      | Sigue vigente el timeout interno: 503 `SERVICIO_NO_DISPONIBLE` correlacionado y socket saliente cerrado |

En los seis casos de desconexión, el cierre ocurre antes de 1500 ms desde la
desconexión y antes de 2000 ms desde el inicio de la solicitud. Así la prueba no
puede aprobar esperando simplemente al timeout interno de 2500 ms. Se comprueba
que no haya lecturas posteriores ni reintentos. El control de timeout espera al
menos 2400 ms y conserva el error contractual existente.

Las cinco unitarias del bridge cubren fin normal, aborto de request, cierre de
respuesta incompleta, desconexión anterior al inicio, limpieza ante fallo e
independencia entre solicitudes. El primer fixture unitario sin socket no podía
simular un flush real de `ServerResponse`; se controla esa propiedad en la unidad
y el POST normal se verifica aparte con sockets reales.

## Límites de la garantía

- La señal corresponde al **cliente HTTP inmediato de Promotions**. Si Gateway
  mantiene abierta su conexión cuando el navegador abandona, esta prueba no
  acredita propagación navegador → Gateway → Promotions; Gateway no se modificó.
- El bridge comienza al ejecutar la consulta, después de los guards. No amplía
  esta garantía a la fase JWT/JWKS del guard, escrituras ni comandos AMQP.
- Abortar el transporte HTTP no demuestra que el proveedor haya cancelado su
  procesamiento o una query PostgreSQL ya iniciada. Se conserva esa limitación
  de la evidencia anterior. No se añade cancelación SQL ni se inventa HTTP 499.
- El cliente que se desconectó no recibe una respuesta HTTP. Los logs sanitizados
  de fallo de dependencia no representan un 503 entregado a ese cliente.

## Validación sobre el árbol sincronizado

| Comando                                                          | Resultado                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `npm test -- apps/promotions-svc --maxWorkers=1`                 | **383 PASS**, cero pendientes, incluye cinco unitarias nuevas |
| `npm run test:e2e -- apps/promotions-svc --maxWorkers=1`         | **19 PASS**, cero pendientes, incluye ocho E2E nuevos         |
| `npm run typecheck`                                              | **PASS**                                                      |
| `npm run lint`                                                   | **PASS**                                                      |
| `npm run build:promotions-svc`                                   | **PASS**                                                      |
| `npm run format:check` y Prettier del alcance nuevo              | **PASS**                                                      |
| Auditoría contractual de las cuatro consultas con Docs `4d285c5` | **PASS**, sin cambios contractuales                           |
| `git diff --check`                                               | **PASS**                                                      |

Los resultados estructurados de Vitest y hashes de las cuatro fuentes nuevas o
modificadas constan en el JSON nuevo. La CI sobre el SHA final y el enlace de la
ejecución se publican en la descripción de [PR #182](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/182).
No se presenta la CI anterior de `20f09d5` como validación del nuevo candidato.

Issues #72, #73 y #78 abiertos. Catalog/Inventory/Pricing/G7 conservan sus
dependencias ya documentadas; no se cambió código de esos propietarios ni se
publicaron comentarios a compañeros. Estas correcciones no cierran el E2E
comercial H4, homologación G7, RabbitMQ compartido o despliegue.
