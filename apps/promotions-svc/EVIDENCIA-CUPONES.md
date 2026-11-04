# Evidencia y elegibilidad de consumo — paso 4, #33

Rama `cueva`, owner Axel Cueva. Estado `IMPLEMENTAR_PARCIAL`.
Fuentes consultadas: Docs G6 `1ee0d9e5a788dbe559a376bf96a60c6117af3956`,
SPEC-005, DEC-F-007/008/009/012, OpenAPI `0.6.0-rc.1`, AsyncAPI
`0.6.0-rc.3`, matriz intermodular; G5
`8fa0f0d0e48ae10f8a25540eab78c956ece044f3`,
`specs/api/api-ventas.md` §1.3 y `integraciones/ACUERDO_G6_PRODUCTOS.md`.

## Implementación interna

`AuthoritativeCouponEvidence` verifica la correspondencia entre hechos durables
y comando: pedido, reserva, referencia comercial, comprador, canal, código
normalizado e instante efectivo. Una referencia existente o `202` no prueba
reserva confirmada. Los hechos incompletos/desconocidos deben producir fallo
técnico en su fuente; solo hechos verificados pueden expresar un rechazo de
precondiciones.

La fuente devuelve un modelo **interno** `DurableCouponFacts`, reutilizando
`ResolvedBasket`. No constituye un DTO, evento o endpoint externo nuevo. Debe
aportar cesta completa, identidad SKU/producto, cantidad, moneda y precios
regular/oferta verificables vinculados al snapshot durable. No convierte
`precioUnitario` de G5 en precio regular/oferta por inferencia, ni sustituye el
snapshot por una consulta comercial actual.

La verificación externa conserva el límite de 1 s existente y no recibe el
cliente SQL. Después, `revalidate` usa el mismo cliente/transacción del comando:

- Bloquea cupón y promoción con el orden de la función/migraciones oficiales.
- Relee estado/configuración y reutiliza repositorios propios y `evaluateBasket`;
  no confía en un booleano de elegibilidad emitido por Ventas o el navegador.
- Comprueba vigencia, canal, alcance, mínimo y alternativa comercial definida.
  Una composición ambigua de varios beneficios conserva su fallo protegido.
- `fn_consume_coupon` revalida límites globales/por comprador e identidad bajo
  lock, conservando códigos específicos y unicidad de uso por pedido/cupón.
- Espera completamente las consultas locales antes de commit/rollback/release.
  El timeout de la fuente externa no libera un cliente usado por consultas
  todavía en vuelo. SQL conserva `statement_timeout=5s` y `lock_timeout=3s`.

Los hechos preparados pertenecen a su prueba en memoria y se eliminan al
revalidar; no se persisten fuera del receipt/resultado definidos por el contrato.
Un replay durable devuelve el resultado anterior sin consultar la fuente ni
revalidar reglas actuales. Un fallo técnico revierte receipt/Inbox/Outbox y uso;
no produce un rechazo definitivo de negocio.

## Frontera pendiente: fuente real de reserva/snapshot

La clase **no está registrada** en los providers de Nest. `COUPON_EVIDENCE_PROVIDER`
sigue rechazando con `COUPON_EVIDENCE_UNAVAILABLE`; el runtime y pump permanecen
desactivados por defecto, protegidos aun si se cambia su flag.

| Owner | Operación afectada | Condición concreta de desbloqueo |
| --- | --- | --- |
| Inventario/Taco + arquitectura/Marco | Verificar reserva desde `reservation_id` y pedido | Fuente publicada y autorizada para Promotions, o correlación contractual verificable. El GET existente requiere **operationId**, es solo de Ventas y no admite intercambiarlo por reservation_id. |
| G5 + arquitectura/Marco | Resolver snapshot comercial durable completo | Fuente autorizada para la identidad propia de Promotions y representación verificable de condiciones congeladas. GET pedido §1.3 solo concede consulta interservicio a Postventa y no publica evidencia de reserva ni distinción regular/oferta suficiente. La política documental H4 `commercial_snapshot_ref = order_id` no acredita esas condiciones por sí sola. |
| G7 + owners de las APIs | Autenticar las lecturas de evidencia | Identidad, audience/scopes/allowlist/grants efectivamente acordados y prueba autenticada, sin usar credenciales de Ventas/Postventa. |
| Owners Catálogo/Pricing/Inventario y mensajería G6 | Activar consumidor/pump compartidos | Decoders de los cuatro eventos, identidad/ACL y supervisión acordadas, más fuente de evidencia implementada y prueba bilateral G5/G6. |

No se añaden llamadas a endpoints inexistentes, acceso cross-schema,
suscripciones a eventos no asignados, datos de producción ni migraciones.
La implementación interna, prueba local, integración autenticada, homologación
y despliegue conservan estados separados. #33 permanece abierto.

## Pruebas

`coupon-evidence-lifecycle.spec.ts` comprueba timeout externo, espera de SQL
local y rollback técnico sin rechazo durable. El smoke
`node apps/promotions-svc/test/coupons.isolated.smoke.mjs` ejecuta la clase real
con repositorios, función normativa y PostgreSQL 17.11 en contenedor descartable.
Solo su **fuente de hechos** usa fixtures explícitos: no acredita G5/Inventario.

Incluye identidades incoherentes, reserva/snapshot sin confirmar, canal,
comprador, código e instante diferentes, alcance incorrecto, mínimo exacto y
un centavo por debajo, cantidad inválida, rollback, dos pedidos compitiendo por
el último uso y replay sin recarga de evidencia. Las pruebas anteriores de
consumo/restauración y broker real descartable se conservan.
