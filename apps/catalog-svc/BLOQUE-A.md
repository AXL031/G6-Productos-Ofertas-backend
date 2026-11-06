# Bloque A — preparación, integración y consultas

## Auditoría del fragmento HTTP — 06/11/2026

Continuación sobre b6ba5fc5027074080b3d3dee94a17a1c7db6b5dc, exclusivamente
Catalog, #194 DRAFT. Este corte actualiza la validación del contrato candidato;
no convierte el fragmento en contrato normativo ni habilita producción.

- Corregidas propiedades YAML espurias verificadas en 400 y 409. Los tres
  códigos 409 quedan en una sola descripción. Validación semántica OAS 3.1
  offline con esquemas oficiales fijados por hash, referencias locales y
  dialecto OAS/JSON Schema 2020-12; la regresión rechaza el YAML original
  aunque sea parseable. No se agregan dependencias ni cambios compartidos.
- Coherencia con DTO: Pricing-only rechaza variantIds no vacío también en
  el esquema. Se contrastan selecciones válidas/inválidas y cuerpos Problem
  reales; ICU y unicidad UUID normalizada se conservan como reglas runtime.
  Los errores documentan application/problem+json, incluidos 413 y 500.
- Defecto adicional reproducido por HTTP: un cuerpo demasiado grande devolvía
  500. Corrección localizada del filtro conserva entity.too.large como 413
  VALIDACION sanitizado; otros errores arbitrarios siguen siendo 500.
- Cardinalidad evaluada: el límite HTTP existente de 100 KiB no garantiza
  duración total de transacción. 1024 UUID caben/validan; 4096 exceden el cuerpo
  y reciben 413 antes de admisión. No se ensayó una transacción de 1024 variantes:
  ese HTTP usa DB indisponible explícita. No se impone un maxItems arbitrario.
  Poma/Marco deben definir presupuesto operativo, medir contención PostgreSQL
  TLS y probar N/N+1, atomicidad y replay antes de habilitar producción.
- Pricing permanece cerrado por defecto y habilitable únicamente en pruebas;
  sin cambios al adaptador ni a los peers. SHA Pricing 7398e6fbc577ec3d595a6c04d4aa9f884fbf527d
  e Inventory 56aa4322725060b529bf316872f891582d7d1b2e se mantienen fijados.
  La E2E PostgreSQL existente añade validación del 202 real y su replay contra
  el esquema, conservando publicadores, bases, broker y consumidores auténticos.

Pruebas locales del corte: 638 unitarias Catalog PASS; 179 E2E Catalog PASS /
117 SKIP por infraestructura. Nueva suite semántica: 37 PASS; HTTP histórico:
10 PASS. Compilación TypeScript estricta explícita de los archivos de prueba:
PASS. General: 2291 unitarias PASS / 66 SKIP; E2E FAIL — Docker no disponible
localmente (ENOENT Bulk :265), 941 PASS / 329 SKIP. Typecheck, lint, formato
TypeScript/YAML, build:catalog-svc, build:all y git diff --check: PASS.
SHA final y ambas CI (HEAD puro y compatibilidad PR) se registran con sus
resultados exactos en #194 y el informe de entrega. Docker no está instalado
localmente; el FAIL ENOENT se conserva y solo permite publicar por la excepción
limitada ya autorizada.
Los SKIP locales no son PASS; la CI debe ejecutar realmente las 98 pruebas
PostgreSQL Catalog y las 2 de Bulk sobre el nuevo código.

| Requisito | Estado de implementación / condición restante |
| --- | --- |
| YAML, semántica OAS, coherencia DTO/errores y regresión 413 | Implementados y probados localmente; CI del SHA final en #194 |
| A1/A2 integración auténtica y activación simple/padre/variantes | Harness y peers inmutables conservados; nueva ejecución Docker obligatoria en CI |
| A3 regresiones | Pruebas existentes conservadas, resultados por ejecución separados |
| Cardinalidad operativa | Evaluación completa; presupuesto y límite justificado pendientes de Poma/Marco antes de producción |
| Contrato definitivo | Marco/owners Docs: publicar HTTP/moneda y contratos candidatos homologados |
| Uso compartido / despliegue | Owner DB/operación: aprobación separada de 0004, grants/ACL y prueba del SHA desplegado; no autorizado aquí |

Sin cambios en Pricing, Inventory, Docs master, Gateway, frontend, Supabase ni
infraestructura. Sin merge ni despliegue. Bloque A continúa PARTIAL por las
dependencias contractuales y operativas; CI descartable no las concede.

## Continuación consolidada — encargo 06/11/2026

Esta sección prevalece sobre los cortes anteriores. Rama poma, #194 DRAFT.
No se reinvestiga ni escribe Supabase: se acepta la auditoría externa informada
por el usuario (20 productos/51 variantes BORRADOR, 20 precios globales válidos,
14 balances/7 SKU, cero checks/Inbox/Outbox/barcodes y ausencia de tabla 0004).
No se regenera catálogo ni se corrigen referencias activas. En sku_identity,
variant_id con product_id=NULL es el modelo vigente y no se trata como error.

### Código propio

- DTO candidato añade moneda explícita solo para selección PRICING: ISO de tres
  letras mayúsculas conocida por ICU, sin default ni precio_regular. La moneda
  integra fingerprint/recibo; otra moneda con misma clave produce conflicto.
- Adaptador registrado usa pricing.product.initialization.requested v1,
  data.modalidad=RECUPERACION_HISTORICA conforme a Vera #205; channel_id=null,
  motivo_cambio=ALTA_PRODUCTO como metadata, sin importe. No cambia alta normal.
- Default cerrado: adapter null salvo NODE_ENV=test y flag candidato true;
  producción no puede habilitarlo. Capacidad humana sigue siendo independiente.
- Corrección de idempotencia: autorización/validación → lock/recibo/fingerprint →
  gate de admisión nueva. Recibos existentes sobreviven a deshabilitar Pricing;
  no se permiten efectos nuevos ni se reabren preparaciones.
- No cambia estados, perfiles, configuración readiness ni optimizaciones existentes.

Delta contractual nuevo pendiente de Marco: aprobar moneda en HTTP, su condición
y errores antes de publicación normativa. No se presenta como campo oficial.
[Contrato candidato](CONTRATO-CANDIDATO-RECUPERACION-HISTORICA.md),
[fragmento OpenAPI](contracts/recuperacion-historica.openapi.candidate.yaml) y
[propuestas SPEC/FLOW/AsyncAPI y prerrequisitos](contracts/recuperacion-historica.docs-proposal.md).

### Fuentes exactas de integración

| Servicio | PR / SHA inmutable | Uso |
| --- | --- | --- |
| Catalog | #194, HEAD final y CI enlazados en la descripción de PR | HTTP, transacciones, Outbox, Inbox, activación reales |
| Pricing | #205 / 7398e6fbc577ec3d595a6c04d4aa9f884fbf527d | Módulo real exportado y compilado sin cambios |
| Inventory | #176 / 56aa4322725060b529bf316872f891582d7d1b2e | userId g6_inventario y #199 en el mismo SHA |

El harness existente se amplía sin overlays ni merges de peers. PostgreSQL 17
TLS verify-full y RabbitMQ 4.2.9 son descartables. Taxonomy y JWKS siguen siendo
fixtures explícitas; no se atribuye E2E React/Gateway/G7 ni Supabase a esta prueba.
El runtime Catalog no importa módulos ni entidades de otros bounded contexts.

### Validación local y ejecución integral del candidato

599 unitarias Catalog PASS; 177 E2E Catalog PASS / 117 SKIP por infraestructura.
General: 2252 unitarias PASS / 66 SKIP; E2E FAIL — Docker no disponible localmente
(ENOENT Bulk en :265), 939 PASS / 329 SKIP. Se conserva la excepción limitada
autorizada a AGENTS §5.11; CI debe acreditar realmente Bulk y Catalog PostgreSQL.
Ambos SHA peer se exportaron y compilaron localmente: PASS, sin implicar E2E.
Primer script de compilación falló por URL ESM Windows; corregida a file URL.
La verificación estricta del archivo E2E detectó un array histórico sin tipo;
corregido dentro de Catalog sin any. El formato detectado se corrigió.

Docker permanece NO EJECUTADO localmente. La CI de compatibilidad del candidato
funcional 4d5b0ef218ea0e041d7a75a13ff30adff504b669 sí ejecutó y aprobó:

| Área / criterio | Evidencia real en CI |
| --- | --- |
| A1 simple histórico | HTTP → Pricing e Inventory auténticos → ambos COMPLETED → activación 200 |
| A1 padre y variantes | Pricing del padre una vez, Inventory de dos variantes seleccionadas; activar variantes y después padre; cero inicialización del sku_base no físico |
| A1 intención/idempotencia | Replay idéntico con adapter deshabilitado devuelve recibo durable; otra moneda/intención 409; concurrencia con único ganador; selección ajena sin efectos |
| A1 negativos monetarios | Moneda incompatible, precio ausente y vigencias ambiguas REJECTED con IDs/versiones nulos; no se activa ni se reabre |
| A2 Inventory definitivo | completed/rejected auténticos de 56aa432; userId g6_inventario verificado por RabbitMQ y Catalog; IDs/correlación/causalidad/esquema preservados |
| A2 seguridad/durabilidad | Cuarentena de origen/SKU ajenos, broker rechaza userId falso, duplicados/replay/reentrega sin efectos nuevos, resultado tardío STALE con check original intacto |
| A2 sin ubicación | Mismo SHA con #199: no ubicación arbitraria ni balances artificiales; saldos multiubicación conservados |
| Fallos y recuperación | Fallo PostgreSQL después de writes revierte check/Outbox/recibo; broker caído tras commit deja PENDING y reinicio de procesos reales completa la operación |
| Ausencia de mutación monetaria | Triggers rechazan INSERT/UPDATE/DELETE en prices/price_validities/scheduled_prices durante adopción y snapshot global permanece idéntico; cero price.changed histórico |
| Referencia de stock | 14 balances de fixture / 7 SKU / 2 ubicaciones idénticos; cero stock.changed espurios y cero saldo para sku_base del padre |
| A3 | Regresiones de consultas, barcode, elegibilidad, seguridad, persistencia y perf existentes PASS; no nueva optimización |

[E2E del candidato funcional](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42227609213/job/127924983199):
98 PostgreSQL Catalog PASS, 0 FAIL, 0 SKIP; Bulk 2 PASS; general 1060 PASS / 200 SKIP.
[Unitarias](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42227609213/job/127924983192):
2326 PASS / 71 SKIP. Checkout PR 267265a08aab4e4f2594b9bec8dfd2e96ee1f622
contra master 61171913510daddc5baedc9532b236de1953fac5. El SHA final documental
y sus ejecuciones de compatibilidad / HEAD puro se enlazan en #194 y el informe
de entrega; no se atribuye una ejecución a un SHA distinto.
Run 42227609213 del candidato funcional: SUCCESS, 18/18 jobs, incluidas imágenes,
smokes, infraestructura y agregadores. El HEAD puro se verifica además mediante
workflow_dispatch final, separado del merge sintético de compatibilidad.

Los balances son fixtures representativos, no exportación ni ejecución sobre
los 14 balances compartidos. Taxonomy/JWKS siguen siendo fixtures identificadas.
El caso ambiguo elimina/restaura temporalmente una exclusión SOLO en el fixture
descartable; no modifica SQL normativo ni migraciones de Pricing.

0004 sigue siendo candidata, no aplicada en Supabase. PASS de owner del schema,
RLS, SELECT/INSERT, unicidad y denegación de UPDATE/DELETE/ALTER y schema ajeno.
Revoca ACL runtime antes de conceder los dos permisos, sin depender de defaults.
Compatible con 0001–0003; no se modifican migraciones aplicadas ni bootstrap.

### Historial de correcciones del harness — no fallos ocultos

- 3d3c74a / run 42225060321: FAIL de seedPrice por commits separados incompatibles
  con timeline diferido. Corregido a definición+vigencia en la misma transacción;
  fixture ambigua conserva versión/snapshots coherentes antes de medir adopción.
- abcc4c7 / run 42225646340: FAIL por orden supuesto en DLQ; el resultado real
  de colisión con SKU ajeno ya estaba correctamente en cuarentena. Se verifica
  y consume ese ID explícito; tres fallos posteriores en cascada desaparecieron.
- 359b7d1 / run 42226736913: FAIL del observador por recoger el negativo
  catalog-joint al buscar por causa una respuesta real g6_inventario. Se consume
  y verifica primero el negativo por su ID, sin relajar validación ni identidad.
- 4d5b0ef: 98/98 PostgreSQL Catalog PASS, incluido el integral histórico. Los
  mensajes positivos proceden de publicadores reales; fixtures negativas se
  contabilizan y se comprueba su cuarentena. Ninguna suite fue deshabilitada.

Master consultado: 61171913510daddc5baedc9532b236de1953fac5 (posterior a 5da1279
del encargo); poma 45 commits detrás al consultar. No se sincroniza masivamente.
La CI pull_request verifica el merge sintético; se registran HEAD/base/checkout
exactos en PR para acreditar compatibilidad sin merge local ni force push.

Estado al corte: IMPLEMENTAR_PARCIAL / DRAFT. Publicación Docs, aprobación del
delta HTTP, Gateway, grants G7, ACL/red operativa, migración compartida y despliegue
permanecen separados. No se cierran/editaron issues automáticamente.

### Criterios de issues y solicitud de cierre técnico

| Issue | Acreditado / estado | ¿Solicitar cierre técnico? |
| --- | --- | --- |
| #12 | Dataset existente según auditoría externa aceptada; no regenerado ni activado compartidamente | Revisión del owner del dataset, sin atribuir nueva validación Supabase |
| #23 | Consultas/barcode implementados y regresiones PASS; cero registros barcode compartidos no es fallo de código ni exige carga | Revisión de cierre interno con evidencia existente; no homologación externa |
| #43 | Config/probes/readiness existentes pasan unitarias, provider y CI; no reimplementados | Sí para criterios internos de configuración; no READY_FOR_DEPLOY |
| #44 | 0001–0004 en PostgreSQL TLS, restricciones/rollback/owner/permisos PASS | Sí para persistencia interna; aplicación compartida requiere autorización aparte |
| #45 | Evidencia funcional histórica simple/padre/variantes e invariantes PASS con peers reales | Presentar aceptación técnica candidata; publicación contractual pendiente |
| #46 | Consultas y perfiles existentes PASS; G2 externo/grants separados | Revisión de cierre interno, conservando pendientes externos |
| #47 | Operación histórica candidata completa y probada, incluido delta moneda | Pendiente aprobar/publicar HTTP y errores; no cierre global todavía |
| #48 | Pricing/Inventory auténticos por SHA, AMQP/Outbox/Inbox/causalidad/seguridad PASS | Subalcance interno acreditado; contratos/ACL/homologación pendientes, no cierre global automático |
| #49 | Cuatro SELECT de listados ya probados; N+1 restantes no reproducidos en este encargo | No refactor ni cierre adicional; mantener evidencia y pendientes originales |
| #50 | Frontend/Gateway externos a Catalog, ruta candidata no publicada allí | No, coordina su owner; no se implementa en esta PR |
| #51 | E2E histórico de tres servicios reales aislados PASS; no equivale a React/Gateway/G7 reales | Subalcance G6 acreditado; cierre completo externo pendiente |

E2E históricos propios del encargo ejecutados: simple, padre/dos variantes,
rechazos, idempotencia/concurrencia, fallos y preservación. Pendientes: contrato
normativo/moneda, Gateway/frontend, grant G7/homologación, migración compartida y
operación/despliegue autorizados. No se presenta esa ausencia como defecto de
Catalog ni se declara Bloque A COMPLETE o despliegue por la evidencia aislada.

## Estado vigente — continuación autorizada de #194

Esta sección prevalece sobre los diagnósticos históricos conservados abajo.
Marco aprobó la operación histórica candidata y la semántica monetaria,
confirmadas explícitamente por el usuario en el chat. No se infiere publicación
de OpenAPI/AsyncAPI ni se inventa el discriminador de Pricing.

| Área | Implementación / evidencia nueva | Pendiente específico |
| --- | --- | --- |
| A1 propia | Operación candidata recuperar-historica, userBearer/GESTOR_COMERCIAL, capacidad interna default cerrado, selección explícita, ledger inmutable, fingerprint, locks y PENDING+Outbox atómicos; pruebas PostgreSQL PASS | Publicar/revisar DTO candidato; activación histórica integrada pendiente de Pricing |
| A1 Pricing | Puerto interno aislado sin adaptador registrado; selección Pricing falla cerrada sin efectos; ALTA_PRODUCTO conserva importe obligatorio | BLOCKED_CONTRACT solo emisión histórica: Vera/Marco deben publicar discriminador/ubicación/versión en SPEC-013/AsyncAPI y entregar SHA |
| A2 Inventory Taco | Prueba bilateral apunta exactamente a 8adcb6e2937580d289b9d20a1c7437473428aa8b, usuario g6_inventario y publicador real | Ese SHA todavía infiere ubicación; no acredita #199 |
| A2 sin ubicación | Prueba independiente sobre master 167090af6d4ae93adbde54b6741dd994d91bf70b, que incluye #199 | Ese SHA no acredita userId; falta SHA único de Taco con ambas correcciones |
| A3 | Se conservan y vuelven a ejecutar consultas, barcodes, elegibilidad, JWT y regresiones existentes | Autenticación G7/homologación/despliegue separados |

Detalle completo del HTTP propuesto, persistencia y decisiones pendientes:
[CONTRATO_CANDIDATO](CONTRATO-CANDIDATO-RECUPERACION-HISTORICA.md).
Migration 0004 es aditiva y candidata: solo pruebas aisladas, sin Supabase.
El consumidor ahora exige identificadores de vigencia/versionado al aceptar
Pricing COMPLETED y conserva REJECTED como terminal; no fabrica confirmaciones.

Taco entregó PR #176, HEAD 8adcb6e, CI 42148293659 (18/18 jobs success
consultados). Se incorpora como evidencia de Inventory, no como prueba bilateral
Catalog. #199 está fusionada (merge a9c19ded7f6ac6e7714cf8d84244a396bdec0559).
El usuario confirmó que todavía no existe un SHA verificado con ambas mejoras.
Las dos fuentes se exportan sin modificaciones a directorios descartables y
se compilan por separado. No se mezclan archivos, no se hace merge de taco,
no se sustituye el publicador real ni se altera producerUsers para aceptar fraude.

Nuevos escenarios preparados para CI: A1 401/403/default cerrado, 202 real con
ledger/check/Outbox, replay, conflicto, concurrencia, selección de variantes,
rollback total, estados terminales y Pricing BLOCKED_CONTRACT sin efectos.
A2 completed/rejected auténticos, userId/messageId/correlation/operation/causation/
schema, rechazo broker de userId falso, cuarentena de identidad incorrecta,
reentrega por Outbox Inventory real, replay de operación y saldos multiubicación.
El caso #199 sin ubicación se ejecuta separadamente, sin atribuirlo a 8adcb6e.
La CI de cbfd53c ya ejecutó los casos Docker nuevos (detalle abajo);
585 unitarias de Catalog y 2238 unitarias generales pasaron localmente.
E2E Catalog: 169 PASS / 116 SKIP por infraestructura; la nueva suite HTTP
sin base añade 3 PASS de autorización con JWT/JWKS firmado y modo demo cerrado.
E2E general: FAIL — Docker no disponible localmente (ENOENT en
apps/bulk-svc/test/bulk-postgres-outage.e2e-spec.ts:265), con 931 PASS / 328 SKIP.
Typecheck, lint, formato y compilaciones Catalog/general: PASS local.
Las dos fuentes Inventory también se exportaron y compilaron localmente: PASS;
esto no constituye evidencia bilateral ejecutada.
No se declara COMPLETE:
faltan E2E histórico Pricing+Inventory y activación contractual histórica de
simple, padre y variantes con el contrato compartido.

### Evidencia ejecutada de la continuación

[Run 42160422132](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42160422132),
HEAD cbfd53c04345601a60f3d2b65575329473d37c69. El workflow pull_request
usa el merge sintético 33ad6db485c16797027e788a362068cb438af378 contra
master 5da12790b56af998cb853c76148f73e2e9c0c207; no se hizo merge local.

| Evidencia del job E2E 127704504147 | Resultado realmente ejecutado |
| --- | --- |
| A1 ausencia histórica previa | PASS: 503 read / 409 retry, sin fabricar preparación |
| A1 candidato HTTP/ledger | PASS: JWT/capacidad, 202, locks, fingerprint, replay y concurrencia |
| A1 selección/rollback/terminales | PASS: variantes elegidas, atomicidad y no reapertura REJECTED/COMPLETED |
| A2 Taco 8adcb6e | PASS: completed/rejected auténticos, g6_inventario, causalidad, broker rechaza userId falso, cuarentena, duplicados/replay y saldos preservados |
| A2 activación ordinaria | PASS: simple, variante y padre; Pricing del padre una vez |
| A2 master 167090a con #199 | PASS de semántica sin ubicación; no balances ni stock.changed espurios; userId ausente causa cuarentena y PENDING en Catalog |
| Persistencia Catalog | 97 PASS, 0 FAIL, 0 SKIP |
| Bulk outage PostgreSQL | 2 PASS, realmente ejecutadas en CI; FAIL ENOENT local se conserva |
| E2E general CI | 1054 PASS / 200 SKIP; 39 suites PASS / 14 SKIP |
| Unitarias CI | 2312 PASS / 71 SKIP; conteos distintos de local por checkout PR con master |

Los marcadores de logs acreditan ambos SHA Inventory por separado. Los escenarios
de saldos y replay utilizan publicador real, no fixtures con userId añadido.
La ampliación posterior b7e6b91d267cf2e06e4a55f6c9a7aa7fd68f5ba9 comprobó
explícitamente admisión HTTP histórica Inventory-only → consumidor/publicador
auténticos → check COMPLETED del producto histórico. PASS, sin fabricar Pricing.
No acredita activación histórica del agregado ni E2E histórico de variantes
con ambos peers. La selección de variantes histórica sí pasa las pruebas internas.

### CI completa del candidato funcional b7e6b91

[Run 42161018091](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42161018091):
SUCCESS, 18/18 jobs. HEAD b7e6b91d267cf2e06e4a55f6c9a7aa7fd68f5ba9,
checkout PR 46fdf0a3a53f4ad72d40d4c2652b8ad5442120bd contra
master 5da12790b56af998cb853c76148f73e2e9c0c207.

- Unitarias: 2312 PASS / 71 SKIP.
- E2E: 1054 PASS / 200 SKIP; 97 PostgreSQL Catalog PASS, sin omisiones.
- [Job E2E aprobado](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42161018091/job/127708675506):
  A1, A2 de ambos SHA separados, histórico Inventory-only y Bulk 2 PASS.
- Typecheck, lint, formato, compilación, imágenes, smokes y agregadores: PASS.
- Primer intento E2E, job 127706506201: FAIL antes de pruebas por preflight
  Docker/OpenSSL. Bulk sí pasó allí. Reintento de jobs fallidos sin cambios de
  código, condiciones ni exclusiones: PASS. Se conserva el fallo original.
- El run anterior 42160422132 terminó CANCELLED por el push de la ampliación,
  después de pasar E2E/unitarias; no se cuenta como CI completa aprobada.

Este registro identifica el candidato funcional ejecutado. La PR #194 enlaza
el SHA final de documentación y su CI correspondiente sin atribuir a un SHA
resultados ejecutados en otro. Estado global PARTIAL: faltan contrato/SHA Vera,
SHA Taco con userId + #199 y E2E/activación históricos simple, padre y variantes.

## Antecedente de la primera iteración — no es estado vigente

Rama `poma`. Base auditada: `15941b6fa3e6f00e595995abca4b328da65ff73f`.
Refs #12, #23, #45, #46, #48, #51. Corte: 2026-11-05.

## Clasificación y límites

| Alcance | Estado operativo | Evidencia / condición |
| --- | --- | --- |
| A1: reproducir ausencia histórica | IMPLEMENTAR_AHORA | `BLOCK-A1` en postgres.persistence.e2e-spec.ts |
| A1: iniciar preparación histórica faltante | BLOQUEADO_ESPECÍFICO | Marco + Poma + Vera/Taco: aprobar operación, intención e idempotencia de recuperación para identidades/precios existentes |
| A2: Pricing real | IMPLEMENTAR_AHORA | `BLOCK-A2`: módulos sin modificaciones, proceso separado, PostgreSQL TLS y broker descartables |
| A2: Inventory real → aceptación Catalog → activación | IMPLEMENTAR_PARCIAL | Productor Inventory omite AMQP userId; Catalog exige identidad autenticada; Taco debe corregir publicador y demostrar replay |
| A3: consultas / reglas / autenticación | Ya implementado, verificar suites existentes | No se cambia política comercial ni se duplica código |

El test BLOCK-A2 es una **reproducción del bloqueo**, no una aprobación del flujo completo.
Comprueba Pricing COMPLETED, resultados Inventory INITIALIZED emitidos por el proceso real,
causalidad y cuarentena de esos resultados sin identidad de transporte. Catalog permanece
PENDING y rechaza activación. Cuando Taco corrija el publicador se debe reemplazar la
expectativa del defecto por COMPLETED y completar activación simple/padre/variantes.
No se inyecta un publicador que añada userId, ni se rebajan los guards de Catalog.

## Auditoría previa

Fetch de master/poma: ambos coinciden con la base auditada; ninguna divergencia ni PR
abierta de poma al inicio. Los cambios locales anteriores en scripts/seed/mcp/catalog y
el certificado sin seguimiento se preservan y excluyen del cambio.

PR fusionadas verificadas mediante GitHub:

| PR | Merge |
| --- | --- |
| #119 | 83d75a5095ccdd9a9c06f53d9edaca4120197e37 |
| #125 | ef104d1204ea48e18676a313b2f804338a381402 |
| #162 | eeaf39ad666d7bc5a11c0b2a80d9c8c4b0016414 |
| #168 | 9f7be5e38be7b643acb956d8b3499459c146755b |
| #175 | 56e475442e5f10a5d08ffa3daf6c66e500ac5caa |
| #185 | c18a91f51c4702b0e24a166cc0eb1d9cd478e6d6 |
| #187 | d5a336614082e9e4af5af4e70a4bc2780b7b4406 |
| #191 | 9f1bed8abcab2f58677cf3cb63a40b7855e914a3 |
| #192 | 15941b6fa3e6f00e595995abca4b328da65ff73f |

La prueba Pricing opt-in existente exige además una worktree limpia en un SHA histórico;
activar solamente PRICING_TEST_CATALOG no basta para validar el candidato actual.
Las nuevas pruebas se descubren en el job E2E ordinario, sin editar workflows. El guard
existente falla en CI si faltan Docker/OpenSSL. Los SKIP locales no son PASS.

## A1 — diagnóstico y propuesta pendiente de decisión

El alta HTTP persiste BORRADOR, preparaciones PENDING y comandos Outbox en una transacción.
La carga SQL histórica no crea esos mensajes. La lectura no puede representar una
dependencia ausente con EstadoPreparacionDependencia sin inventar estado: devuelve 503.
El retry exige check PENDING e intento previo reconstruible; sin check devuelve 409
PREPARACION_NO_REINTENTABLE. No constituye una inicialización administrativa.

No se identificó una operación vigente que admita iniciar esa preparación faltante.
PATCH conserva identidad y no reejecuta alta; repetir POST colisiona por SKU. Bulk no
autoriza fabricar coordinación histórica ni COMPLETED. Se conserva la frontera.

Propuesta técnica para decisión de Marco (sin endpoint, DTO ni código nuevo):

1. Autorizar recuperación explícita sobre una selección revisada, nunca por lectura,
   arranque automático o retry. Autorización humana GESTOR_COMERCIAL no concede por sí
   sola una nueva operación: primero publicar contrato y alcance de datos.
2. Bloquear el agregado y verificar BORRADOR, identidad/SKU, maestros, modelo y ausencia
   real de preparación. En padres, Pricing solo para padre e Inventory solo por variante.
3. Exigir intención monetaria autoritativa aprobada por Pricing. No derivar un precio
   inicial de precios vigentes ni reenviar ALTA_PRODUCTO sobre un precio existente sin
   acuerdo de replay/adopción. Inventory debe confirmar tratamiento de SKU y saldos
   ya existentes sin reinicializar a cero ni duplicar ubicación.
4. Definir identidad estable de recuperación y fingerprint por dependencia. Conservar
   operación existente cuando la haya; para ausentes, creación controlada de una sola
   operación. Lock/UNIQUE aseguran un ganador; replay conserva intención.
5. Transacción local de check PENDING + Outbox; nunca COMPLETED por SQL. Cada envío tiene
   message_id, operation_id, correlation_id y causation_id trazables. Confirmar publicado
   antes de published_at; resultado debe coincidir con intento activo. Inbox deduplica.
6. Resolver adopción/rechazo con resultados reales de cada owner. COMPLETED terminal;
   REJECTED sin recuperación habilitada. Timeout de 300000 ms requiere publicación
   confirmada e idempotencia verificada; no es recuperación de una preparación ausente.
7. Probar dos solicitudes concurrentes, replay, precio/SKU existente, resultado tardío,
   fallo después de commit y antes de publicación, y ninguna modificación de saldos.

Riesgos: duplicar primer precio, perder intención original, inicializar saldos existentes,
aceptar resultados ajenos y atribuir publicación histórica sin evidencia. No se ejecuta
esta propuesta ni se activan productos compartidos.

## A2 — dependencia concreta de Inventory

- Owner: Taco, apps/inventory-svc/src/outbox/outbox-publisher.service.ts.
- Operación afectada: publicación de inventory.sku.initialization.completed/rejected.
- Comportamiento observado estáticamente: opciones publish incluyen messageId,
  correlationId, contentType, mandatory y persistent; falta userId.
- Catalog, apps/catalog-svc/src/catalog-amqp.ts, contrasta userId con producerUsers.
  Sin identidad autenticada el mensaje se considera inválido y se envía a DLQ.
- Además, Inventory emite schema_version=2 para los resultados. El envelope oficial
  AsyncAPI rc.4 admite enteros desde 1 y el payload de inicialización no cambia.
  Catalog solo admitía v1. Se corrige Catalog para aceptar v1/v2 únicamente en los
  dos resultados de inicialización Inventory ya tipados; v3, otros productores,
  causalidad/operación ausentes y payload incorrecto siguen rechazados. Se añaden
  pruebas positivas/negativas; el test entre procesos valida el sobre real v2.
  Esto no elimina el bloqueo independiente de userId ni habilita una activación.
- Desbloqueo: publicador real emite userId correspondiente a la conexión autenticada,
  RabbitMQ lo valida; pruebas entre procesos demuestran aceptación, idempotencia y
  activación sin modificar el consumidor ni añadir identidad mediante una fixture.
- Hasta la ejecución CI, la reproducción runtime nueva sigue NO EJECUTADA localmente.
- Los fixtures de Taxonomy y JWKS son explícitos: no acreditan integración Taxonomy,
  grant G7 ni autenticación con credenciales reales.

## Escenarios y evidencia reutilizada

| Escenario | Suite / caso | Tipo |
| --- | --- | --- |
| Histórico sin checks vs alta HTTP | postgres.persistence / BLOCK-A1 | HTTP + PostgreSQL TLS real en CI |
| Pricing real simple y padre, Inventory real simple y variante | postgres.persistence / BLOCK-A2 | procesos reales; reproducción de frontera bloqueada |
| Atomicidad alta, Outbox, SKU, padre sin Inventory | postgres.persistence / creates simple and variant products atomically | PostgreSQL; maestros/resultados fixtures |
| Variantes independientes, hijos no activos no bloquean | postgres.persistence / ignores unprepared draft/inactive siblings | PostgreSQL; resultados fixtures |
| Retry concurrente, stale, terminal e Inbox dedupe | postgres.persistence / admits only one manual retry | PostgreSQL; resultados fixtures |
| Sin confirm, broker desconectado/reconectado | postgres.persistence / JOINT-01 y keeps Outbox pending | broker real; productor de resultado fixture |
| PostgreSQL timeout / saturación / recuperación | postgres.persistence / PG-FAULT-01/02 | PostgreSQL real |
| Código literal, retiro, conflicto, variante no elegible | postgres.persistence / D-CAT-01..04; barcode.service | PostgreSQL + unitarias |
| Elegibilidad antes de count/paginación | postgres.persistence / D-CAT-05/06; commercial-eligibility.postgres | PostgreSQL |
| ID/slug/variantes/contexto/barcode/401/403 | catalog-http; catalog-sku-context.http; catalog-auth; catalog-security.provider | alcance de cada fixture explícito en la suite |
| Datos físicos, 422/503, estados y JWT firmado | postgres.persistence / OPEN-09-PROVIDER | HTTP + PostgreSQL + issuer de prueba |

No se presenta cobertura con resultados fabricados como integración real entre servicios.
No se añadieron tests espejo ni cambios de producción para reglas ya implementadas.
La herencia de precios sigue en Pricing; este candidato no acredita su consulta real
autenticada ni el flujo de activación posterior al bloqueo de Inventory.

## Contratos y decisiones

Consultados en master remoto de Docs: OpenAPI 0.6.0-rc.3, AsyncAPI 0.6.0-rc.4,
SPEC-003/004/010, FLOW-003/004, modelo físico, errores, kit, pruebas contractuales,
registro/matriz DEC-F, acuerdos internos H4, skuContext, matriz intermodular y G1/G2.
También AGENTS, seis guías Oracle y paquete operativo Marketplace del backend.
Fuentes y blobs en bloque-a-fuentes.json.

DEC-F-011: perfil del SKU físico; DEC-F-001/003 y decisiones internas: separar
catálogo/precio/disponibilidad, admisión y confirmación; DEC-G6-INT-01/05/13:
permisos puntuales, correlación y contexto SKU. No se amplía ninguna decisión.
D-CAT-05/06 mantiene ratificación externa pendiente. La SPEC-004/acuerdo G2 actuales
registran precedencia bilateral posterior al texto histórico de #46; no se toma
ese issue anterior como prueba del estado actual.

Fixtures SQL Inventory copiados byte a byte desde Docs master (blobs verificados en
el test); SQL Pricing reutilizado solo como infraestructura de prueba. Se ejecutan
exclusivamente dentro del PostgreSQL descartable creado por la suite. Runtime de
cada peer usa rol propio y entorno explícito, sin cargar .env ni URLs compartidas.
No se modifica otro microservicio, contratos, migraciones históricas ni workflows.

## Validación local y estado por issue

Windows / Node instalado, sin Docker. Primer intento Vitest en sandbox: FAIL EPERM
en caché temporal antes de ejecutar tests; repetición fuera del sandbox:

| Comando | Resultado |
| --- | --- |
| npm test -- apps/catalog-svc --maxWorkers=2 | PASS, 573 pruebas |
| npm run test:e2e -- apps/catalog-svc --maxWorkers=2 | 169 PASS, 114 SKIP; no acredita las dos pruebas nuevas con Docker |
| npm run typecheck | PASS |
| npm run lint | PASS |
| npm run format:check | PASS |
| npm run build:catalog-svc | PASS |
| npm run build:all | PASS |
| node --check apps/catalog-svc/test/support/preparation-peer.mjs | PASS |
| npm ci | NO EJECUTADO local; dependencias existentes; obligatorio en CI |
| npm test -- --maxWorkers=2 | 2226 PASS, 66 SKIP; 185 suites PASS y 2 SKIP |
| npm run test:e2e -- --maxWorkers=2 | FAIL: 931 PASS, 326 SKIP; una suite Bulk falla en setup por Docker ENOENT |
| git diff --check | PASS |

Bloqueo de publicación local: `apps/bulk-svc/test/bulk-postgres-outage.e2e-spec.ts:265`
ejecuta Docker de forma obligatoria en beforeAll. Error exacto:
`Docker disposable database command failed (ENOENT).`
No hay Docker instalado en esta máquina. No se elimina ni omite la prueba.
Owner: Castilla / entorno de validación. Desbloqueo: ejecutar la validación con
Docker en el runner existente. El usuario autorizó expresamente una excepción
limitada y condicionada a AGENTS §5.11 para publicar solo este Bloque A en poma
y abrir PR DRAFT: comprobar ausencia del ejecutable, conservar el FAIL local,
validar todas las comprobaciones locales disponibles y ejecutar CI completa
por SHA, incluyendo Bulk sin omisiones. No autoriza cambios de ownership,
contratos, Supabase, despliegue, merge ni marcar la PR lista.
Get-Command docker no encuentra ejecutable; la llamada real de Bulk devuelve
ENOENT antes de crear un contenedor. No hay otro fallo local de código detectado.
El run del candidato se registra en la descripción de la PR después de publicarlo.

Primer candidato publicado: fa82ef052f8404b86e500cd10a7ac64810692d4f,
PR DRAFT #194, CI 42095502089. Bulk outage ejecutó sus dos pruebas y pasó;
BLOCK-A1 pasó con PostgreSQL TLS. BLOCK-A2 falló por configuración de fixture
que combinaba DATABASE_URL y credenciales PG individuales: Inventory rechaza
expresamente esa ambigüedad. Se corrige exclusivamente el entorno de prueba de
Catalog para utilizar URL + configuración TLS, y se añade comprobación real
de salud PostgreSQL del peer antes de anunciar arranque. No se modifica Inventory
ni su parser. El FAIL original se conserva; la nueva CI validará la corrección.

Después de corregir el candidato: 34 pruebas enfocadas de mensajes PASS;
575 unitarias Catalog PASS; 169 E2E locales PASS y 114 SKIP por las mismas
dependencias/opt-in; typecheck, lint, format:check, build:catalog-svc, build:all,
node --check del peer y git diff --check PASS. La E2E general local conserva
su FAIL de Docker y no se reclasifica. La comprobación nueva de salud del peer
consulta PostgreSQL real, sin sustituir el servicio ni su repositorio.

Segundo candidato 0f482cb89cb1ebf7b07d3a8d0e2df9978fb3c34e, CI 42096850031:
Bulk outage 2/2 PASS y BLOCK-A1 PASS. BLOCK-A2 superó Pricing COMPLETED,
sobres reales Inventory v2 y cuarentena por identidad ausente; falló posteriormente
en la solicitud negativa de activación de variante porque la fixture enviaba
un cuerpo vacío donde el contrato exige ausencia de cuerpo (400 VALIDACION,
antes de evaluar preparación). Se corrige solo esa llamada para omitir body
y comprobar 422 por preparación incompleta, igual que la suite HTTP existente.
No se cambia el endpoint ni se altera su validación para conseguir el resultado.

Archivos del cambio, todos bajo Catalog:

- `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts`
- `apps/catalog-svc/src/catalog-messages.ts`
- `apps/catalog-svc/src/catalog-messages.spec.ts`
- `apps/catalog-svc/test/support/disposable-catalog-broker.ts`
- `apps/catalog-svc/test/support/preparation-peer.mjs`
- `apps/catalog-svc/test/fixtures/inventory-initial.sql`
- `apps/catalog-svc/test/fixtures/inventory-operations.sql`
- `apps/catalog-svc/BLOQUE-A.md`
- `apps/catalog-svc/bloque-a-fuentes.json`

| Issue | Evidencia previa | Trabajo | Pendiente | Candidato a cierre |
| --- | --- | --- | --- | --- |
| #12 | #175 / DATA-002 | diagnóstico histórico | decisión de recuperación / aceptación dataset | No |
| #23 | #125/#162/#185 | regresión consultas existente | homologación/grants/E2E externo | No |
| #45 | #125/#185 | regresión reglas y ausencia | activación con resultados reales Inventory | No |
| #46 | #162/#185 | regresión HTTP/seguridad existente | consumidores/grants y evidencia real | No |
| #48 | #168/#187 | proceso real Pricing/Inventory y causalidad | identidad de transporte Inventory; escenarios completos | No |
| #51 | #125/#162 | prueba aislada entre peers | activación completa, E2E externo/autenticado | No |

Implementación, pruebas locales, integración entre procesos, credenciales reales,
homologación, despliegue y cierre formal son estados separados. No hay credenciales
G7 reales, nueva homologación, escritura Supabase, activación compartida ni despliegue
en esta tarea. Estado del Bloque A: PARTIAL.
