# PR #159 — correcciones G7 y composición #72

Owner Axel Cueva, rama permanente `cueva`, 02/11/2026. Actualización de la misma
[PR #159](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/159),
solicitada por Axel; sin merge. Sustituye el pendiente interno de composición
del informe de cierre anterior. Solo `apps/promotions-svc/`.

Base `c848c2b527c31a8a3fa619ef84cebef78523c14c`: [CI 41501738156](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/41501738156)
SUCCESS, 16 checks, incluida validación de imágenes. La CI del SHA final de esta
corrección se registra por separado en la PR; no se infiere de la base.

Fuentes vigentes: Docs `783a60efa5772548fce66ef63198e17361d8460b`, OpenAPI
rc.2 / AsyncAPI rc.4 sin cambios respecto del corte previo; SPEC-005/006/007,
DEC-F-007/008/009/012 e INT-01/04/12/13. Regla v1 de composición aprobada el
26/10 y ratificada por INT-13; instrucción actual de conectar al HTTP.
G7 `6045c013fd454cff998169bd1b114323324cda72`, emitirTokenServicio/TokenServicio.
No se cambian contratos, Gateway, otras aplicaciones, dependencias ni migraciones.

## Observaciones de revisión resueltas

- **P2 concurrencia:** una petición en curso por scope compartida por los
  consumidores. Cada llamada cancela su espera independientemente; cancelar una
  no cancela las demás. Cuando no quedan esperas, se aborta el transporte y se
  retira inmediatamente esa petición para admitir un nuevo intento. Fallo/timeout
  limpia su entrada; una respuesta abandonada tardía no llena la caché ni borra
  un intento nuevo. Se conservan timeout de un segundo y errores sanitizados.
- **P2 operación/scope:** `InternalHttpReader` y el emisor de tokens reutilizan
  `internalOperations`. Se verifica la pareja operationId/scope y audiencia antes
  de usar caché, unirse a trabajo o pedir token. Se captura el scope contractual
  validado para que el request del llamador no cambie una emisión en curso.
- **P3 wiring:** el runner PostgreSQL construye `PromotionsSvcModule` real con
  sus factories de tokens, JWKS, identidad y contexto HTTP. No sustituye esos
  providers. Configura credencial sintética propia, G7 contractual explícito y
  upstream HTTP local; un serviceBearer Marketplace válido entra por el handler,
  y el upstream recibe el token modulo-productos correcto por operación. Verifica
  caché, ausencia de reenvío del bearer entrante y 401/403/503 sin llamada anónima.
  PostgreSQL/TLS y sus transacciones son reales; G7 y datos de proveedor son fixtures.

## #72 — implementación interna completada

`evaluateBasket` conecta `composeBenefits` y `projectBenefitMoney` a las
operaciones HTTP existentes. No requiere grant G7 para probar lógica propia:

- Valida hechos del mismo canal/instante/moneda y consolida duplicados del SKU
  conservando cantidades/subtotales. Producto o precio incoherente entre líneas
  duplicadas falla; alcances producto/SKU superpuestos no duplican descuento.
- Evalúa subconjuntos con permiso bilateral, porcentajes sucesivos sobre saldo y
  monto fijo una vez con reparto proporcional. Conserva ofertas Pricing como
  alternativa y solo las combina cuando todos los participantes lo permiten.
- Compara importes exactos antes de redondear y conserva los desempates v1. PEN
  usa escala 2; resultado total mitad hacia arriba y reparto por mayor resto, sin
  redondeo intermedio. Precios unitarios no representables, moneda sin escala
  acordada o número HTTP que pierda precisión fallan con 503, sin inventar escala.
- Mantiene hasta 100 líneas de entrada, 12 campañas elegibles, 250000 unidades de
  trabajo y 100 ms de búsqueda. No trunca campañas, aproxima ni devuelve ganador
  parcial. El fallo se traduce al error técnico contractual correlacionado.
- `promotion_id` sigue siendo la primera campaña que aportó ahorro, sin nuevos
  campos públicos. La validación individual conserva la campaña real del cupón,
  incluso si Pricing exclusivo ganaría la evaluación completa. Evaluar, validar
  y reintentar no consumen cupos ni escriben Inbox/Outbox.
- La revalidación transaccional del consumo identifica por separado el cupón
  efectivamente aplicado; una automática principal no lo suplanta. El cupón de
  una combinación ganadora es elegible; uno que pierde frente a una exclusiva no
  se consume. Límites SQL, reserva confirmada/snapshot durable, ACK tras commit,
  recibos/Inbox/Outbox y flags del runtime compartido conservan sus gates.

Pruebas de aceptación: 10% + 20% sobre 100 = 72; exclusivo 50% frente a 30% +
40% gana 42; fijo 1 sobre líneas 1/2 y luego 50% solo en la primera da 5/3 exacto,
publicado 1.67 con descuento 1.33; automática principal + cupón da 81, mientras
validar ese cupón individual conserva su campaña y resultado 90. Se comprueban
casos adversos, orden de líneas, duplicados y cero efectos de consumo en PG.

## Resultados de validación

Las validaciones previas al commit se ejecutaron sobre base c848c2b más árbol
MODIFIED. El SHA/hash limpio final, CI y comandos posteriores se adjuntan en la PR.
Hash SHA256 agregado de `src/` y `test/` validados (128 archivos):
`d0ce37a7ab576f0fee45ea0fd1aab89a82b0bd3302e85e239d3ec9640176faa6`.

| Comando | Resultado |
| --- | --- |
| `npm test -- apps/promotions-svc --maxWorkers=1` | PASS, 373 pruebas, 32 suites. |
| `npm run test:e2e -- apps/promotions-svc --maxWorkers=1` | PASS, 11 pruebas, dos suites. |
| `npm test -- --maxWorkers=2` | PASS, 1689 pruebas; 47 optativas omitidas, 148 suites PASS y dos omitidas. |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | PASS; lint sin advertencias. |
| `npm run build:promotions-svc` | PASS. |
| `G6_TEST_OPENSSL=<existente>; node apps/promotions-svc/test/persistence.isolated.smoke.mjs` | PASS, 27 grupos, PG17.11/TLS y runtime restringido reales; incluye wiring y composición HTTP. |
| `node apps/promotions-svc/test/coupons.isolated.smoke.mjs` | PASS, 24 grupos PG/Rabbit descartables; incluye elegibilidad del cupón combinado, rechazo exclusivo y conservación/idempotencia/restauración. |
| `git diff --check` | PASS. |

La primera prueba nueva de wiring usó por error un token humano en evaluarPromociones,
que exige serviceBearer: obtuvo 403 correcto. Se corrigió el fixture al actor
contractual y se conservó el 403 como negativo; segunda ejecución PASS. No se
relajó autorización productiva ni se omitió una prueba.

E2E general Windows no se repite: Catalog DATA-002 agotó dos veces su límite
5000 ms en el corte anterior (6338/6312 ms), reportado al owner. La CI de base pasó
ese alcance por separado; esta entrega exige CI verde del SHA final. Publicación
y actualización de esta PR autorizadas por Axel con esa limitación ya informada.
Los nuevos tests se ejecutan en el job existente de persistencia de Promotions;
no se añade workflow global. Logs previos al commit en caché local
`node_modules/.cache/promotions-work/pr159-composition-http.log` y
`pr159-composition-amqp.log`; no equivalen a artefactos CI publicados.

## Pendientes específicos externos

| Owner | Operación afectada | Condición verificable de desbloqueo |
| --- | --- | --- |
| Poma | producto/contexto SKU y referencias | SHA/URL privada/dataset aprobado; identidad modulo-productos y pruebas nominales, ausencia/inelegibilidad y error real. |
| Vera, con Poma | precio efectivo por SKU/canal/instante | Contexto Catalog y canales conectados; herencia/oferta/override y errores reales por SHA. Moneda distinta de PEN requiere escala acordada antes de habilitarla. |
| Taco | disponibilidad comercial | Acceso preciso del origen Promotions y pruebas de los cuatro estados por canal/lote, sin sumar ubicaciones. |
| López | categoría administrativa e integración frontend vigente | Endpoint/permiso rc.2, activo/inactivo/ausente; circuito UI/Gateway con SHA/URL/CORS. No se rehace frontend. |
| G7 con Marco/infra | tráfico autenticado real | Issuer/JWKS/grants y credencial propios provisionados por canal privado; red/DNS/confidencialidad o TLS acreditados y positivos/negativos auténticos. |
| G5/Inventario, productores y Marco/infra | AMQP compartido | Reserva definitivamente confirmada, snapshot durable, procedencia/red/ACL/bindings y compatibilidad bilateral probados antes de habilitar consumidor/pump. |
| BD/Marco | DATA y envelopes brutos | Aprobación del locking y lote/hash/destino/proceso; disposición durable aprobada para mensajes que no caben en Inbox. |
| Marco/infra y consumidores | release, homologación y E2E compartido | Autorización individual SHA/imagen/entorno, recuperación y pruebas por tramo; interpretación contractual verificada sin inferir aceptación por silencio. |

Trabajo interno solicitado de PR #159/#72: implementado y probado. Integración
autenticada compartida, homologación externa y despliegue se acreditan aparte;
no READY_FOR_DEPLOY, cierre automático, activación ni merge.
