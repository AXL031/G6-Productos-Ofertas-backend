# Robustez y observabilidad — #76

## Corrección interna del 01/11/2026

El pump avisa con el código existente `COUPON_OUTBOX_PENDING` cuando la
publicación queda pendiente por falta de confirmación, además de ante una
excepción transaccional. Emite un aviso por racha continua de fallos; después de
publicar o comprobar la cola vacía puede informar una nueva incidencia.
El observer recibe cero argumentos, no expone payload/diagnósticos y sus fallos
no detienen el pump. El cierre no informa un fallo tardío. Se mantienen los
intervalos, serialización, confirms y persistencia existentes; esto no activa
el consumidor compartido ni incorpora una política retry/DLX.

Estado: IMPLEMENTAR_PARCIAL. Implementación interna y pruebas no equivalen a
integración autenticada, homologación ni despliegue (DEC-F-012).

Fuentes actuales: Docs G6 `5124eeae4ec65b22ea9146cd7b1ce3888c617c10`, Arquitectura
§24/25/46/47, OpenAPI 0.6.0-rc.2, AsyncAPI 0.6.0-rc.4,
DEC-F-007/008/009/012 e INT-12/13.
No se cambia ningún contrato compartido.

## Comportamiento

- `/health` conserva liveness independiente de PostgreSQL y RabbitMQ.
- Readiness interna comprueba PostgreSQL y, cuando el perfil lo requiere,
  RabbitMQ; no consulta servicios ajenos. `check()` conserva el perfil completo;
  `check(false)` corresponde a HTTP sin consumidor de cupones.
- Los probes reales tienen límite de un segundo y señal de cancelación. Las
  comprobaciones concurrentes del mismo perfil comparten trabajo; las terminadas
  no se cachean. Un fallo produce `not_ready` y la siguiente muestra puede recuperar.
- Al cerrar, readiness deja de admitir estado ready. El monitor cancela su timer,
  espera como máximo la muestra acotada en curso y evita logs tardíos.
- El monitor interno usa el flag ya existente
  `PROMOTIONS_DEPENDENCY_PROBES_ENABLED`, apagado por defecto. Muestra cada cinco
  segundos tras terminar el probe y registra solo transiciones de estado. No
  arranca consumidores, conexiones comerciales, topología ni reintentos de negocio.
- Las 22 operaciones HTTP registran una observación JSON con identificador
  contractual, estado, duración acotada y UUID de correlación. Los errores añaden
  únicamente códigos declarados por operación/estado. La respuesta comparte el
  mismo `X-Correlation-Id`; uno inválido se sustituye y no se refleja.
- No se registran URLs, query strings, tokens, cabeceras de autenticación,
  cuerpos, referencias de clientes, códigos de cupón ni excepciones crudas.
  Un fallo del destino de logs no altera el resultado HTTP.

## Fronteras pendientes

La continuación del 01/11 adopta INT-12/13 de Docs PR #106, AsyncAPI rc.4.
El consumidor realiza como máximo tres intentos locales totales, con backoff
de 100 y 200 ms, únicamente ante fallos técnicos transaccionales conocidos.
Agotados los intentos, pausa/alerta sin ACK y sin bucle NACK/requeue; cierre o
fallo del canal cancela el backoff. No se incorpora DLX.

Los cuatro eventos asignados con envelope válido y datos contractualmente
inválidos registran rechazo durable en Inbox, sin aplicar proyecciones, antes
de resolver para ACK. Si ese registro falla, se revierte y no se confirma.
Envelopes brutos malformados o procedencia inválida pausan sin ACK: el esquema
actual no es una bandeja de cuarentena arbitraria. Hace falta mecanismo
aprobado BD/Marco para esos mensajes, sin inventar tablas ni permisos.

Readiness técnica, disponibilidad funcional y health se mantienen separadas.
La suite funcional comprueba tanto éxito HTTP/PG como 503 ante fuentes caídas,
sin declarar disponibilidad funcional por un health técnico correcto.

| Owner                               | Operación afectada                       | Desbloqueo verificable                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Marco / arquitectura y contratos G6 | Exponer readiness/liveness técnicas HTTP | Arquitectura menciona `/health/live` y `/health/ready`, pero OpenAPI no las declara. Homologar/documentar las rutas y respuestas antes de publicarlas. Ambas siguen 404. |
| Infra / observabilidad G6           | Centralizar métricas, alertas y trazas   | Destino y configuración de colector/scrape homologados y prueba en el entorno autorizado. Los logs locales de latencia/error no acreditan esa plataforma.                |
| Marco / infra AMQP y G7             | Recuperación de consumidor compartido    | ACL, identidad y contrato rc.4 homologados; luego prueba de desconexión/recuperación bilateral. El runtime sigue desactivado/protegido.                                  |

Los límites de las fronteras comerciales se documentan en CONSULTAS-DOMINIO.md.
No se conectan bases/brokers compartidos para estas comprobaciones. Los scripts
isolated utilizan PostgreSQL/TLS y RabbitMQ reales, desechables, con datos fixture
expresamente identificados. Las pruebas HTTP verifican correlación, atribución de
rutas estáticas y ausencia de secretos tanto en éxito como en errores.
