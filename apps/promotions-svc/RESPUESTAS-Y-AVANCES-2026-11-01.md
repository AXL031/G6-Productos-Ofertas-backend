# Respuestas de owners y nuevo corte normativo — 01/11/2026

Este documento conserva las respuestas y el primer avance posterior a PR #106.
El desarrollo continuó: los adaptadores HTTP y cuatro eventos están registrados
detrás de sus gates, con pruebas HTTP/PostgreSQL. El estado vigente y condiciones
de cierre están en [AVANCE-ISSUES-2026-11-01.md](AVANCE-ISSUES-2026-11-01.md).

Rama `cueva`, base `b4cc18f070667602c31af41331c5b483e5abed18`, cambios sin
commit. Axel aportó respuestas de Vera, Poma y Taco y adjuntos de López y Marco
en esta sesión. Se registran como comunicaciones aportadas por Axel; no son una
revisión GitHub, aprobación BD, grant, homologación externa ni release.

## Cambio posterior a las respuestas

El remoto Docs avanzó desde `599c34f` a
`5124eeae4ec65b22ea9146cd7b1ce3888c617c10` por PR #106, el 01/11 en Lima.
Se consultaron el diff y
`arquitectura/decisiones/ACUERDOS-INTEGRACION-INTERNA-G6-H4.md`.
OpenAPI es ahora candidata `0.6.0-rc.2`; AsyncAPI, `0.6.0-rc.4`.
DEC-G6-INT-01–13 complementan DEC-F existentes; no se inventan nuevas DEC-F.
Estos acuerdos permiten desarrollar adaptadores internos; su despliegue y
conformidad de proveedores requieren evidencia separada.

## Qué cambia por owner

| Owner | Aporte y tratamiento                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vera  | Confirma handler y semántica de precio en `dff8b704cc1f2e1df5f87e17ed11d9c97c8f6e76`; contexto Catalog nulo y canales vacíos aún impiden integración. Su mención de `po.events.x` no se adopta: la topología normativa conserva `po.eventos.x`. El nuevo contrato ya tipifica `pricing.price.changed`, pendiente de adaptar/publicar coordinadamente.                                                                                                         |
| Poma  | Confirma que el productor previo no aporta versiones de entidad y que su allowlist implementada usa `modulo-pricing`. INT-01/04 y OpenAPI rc.2 ahora autorizan el diseño de lectura por `modulo-productos` y uso de `obtenerContextoSku` desde Promotions. Requiere adaptación del proveedor: no se toma su código anterior como conforme. Los eventos Catalog nuevos exigen versiones/changed_at; ejemplos previos con motivo/variant_id no pasan como rc.4. |
| Taco  | Confirma ciclo de reserva/Outbox en `9728207f664decc50e5a1b28002f4b946cb09954`. No se adopta ausencia=0 como regla comercial general. INT-02/07 distingue positividad, indeterminación, ausencia y fallos. Stock es snapshot por (sku,location_id), schema_version=2; stock_version no es global por SKU. Falta fuente contractual de reserva confirmada/snapshot para #33.                                                                                   |
| López | Aceptación técnica condicionada del modelo guard + UPDATE(id); no equivale a aprobación BD/Marco. Se incorporan resolución segura del rol y control del session_user, manteniendo auditoría por columna y probando runtime separado. Taxonomy debe implementar las lecturas/allowlists de rc.2.                                                                                                                                                               |
| Marco | Autoriza desarrollo/pruebas funcionales sin esperar G7 cuando proveedores tengan demo restringida verificada; conserva gates AMQP y release individual. Composición sigue aislada de HTTP hasta aceptación de consumidores. La respuesta proponía recomendaciones simples; INT-02/03 publicado después define ya variantes y precio mínimo para desarrollo interno.                                                                                           |

## Implementación realizada

- **#73 / INT-04:** el cliente saliente resuelve cestas sin product_id mediante
  `obtenerContextoSku`, preserva el SKU opaco, verifica identidad/flags y deduplica
  lecturas por llamada. Una referencia producto/SKU incoherente se clasifica como
  entrada inválida y el filtro usa el error contractual `400 VALIDACION`.
- **#73 / INT-02/03:** recomendaciones product-level consideran SKU simples y
  variantes. Sin sumar ubicaciones, agregan disponibilidad positiva y calculan
  el mínimo efectivo con Decimal entre SKU con precio válido y stock positivo,
  bajo un único instante y canal por llamada. Precio 404 legítimo excluye SKU;
  fallo técnico/corrupción/moneda heterogénea falla la operación. Sin positividad
  y precio válido se representa exclusión interna con null, nunca AGOTADO
  inventado. No se añade SKU al DTO público.
- **#75 / INT-07:** dos adaptadores candidatos de baja Catalog validan payload
  rc.4 estricto, fecha y versión de dominio segura; reutilizan el writer propio
  transaccional, con producto/SKU separados. No están registrados en runtime;
  el registro productivo sigue protegido y faltan las invalidaciones de
  Pricing/Inventory y sus pruebas de transición coordinada.
- **#15:** fixture reforzado con to_regrole, rechazo si falta el rol y membresía
  de session_user para impedir escape mediante SET ROLE de login NOINHERIT.
  Se verifica login runtime independiente y contención real por PK. Evidencia
  nueva del 01/11; la evidencia del 26/10 permanece intacta. No se crea migración
  ni se aplican permisos o datos compartidos.

## Pendientes concretos

1. **Axel + Poma/López:** completar adaptador administrativo sobre las lecturas
   precisas de rc.2 y comprobar rechazo de referencias sin confundir 404 comercial
   con inexistencia administrativa. Los proveedores deben implementar dichas
   lecturas/allowlists y aportar entorno/versiones verificables.
2. **Axel + Vera/Taco:** adaptar proyecciones de precio/stock a invalidación,
   sin convertir snapshots locales por ubicación en disponibilidad comercial ni
   una versión de precio de definición en secuencia global. Evaluar compatibilidad
   con persistencia normativa antes de cambiar columnas/permisos.
3. **Poma/Vera/Taco/López + Marco:** entorno privado y providers en demo
   restringida operativos, canal/mapeos reales, URL y prueba por tramo. El cliente
   sigue candidato no registrado; sus tests usan un servidor DTO sintético
   explícito. No se ha conectado a los servicios compartidos.
4. **G5/Inventario + Marco:** fuente real de reserva confirmada/snapshot, identidad
   AMQP/ACL/red/bindings y prueba bilateral antes de activar consumidor/pump.
5. **BD/Marco + Poma/Vera/Taco:** revisión de roles reales, entrega BD separada,
   contenido/referencias/precios/disponibilidad actuales y autorización de cada
   carga por hash/destino. López aportó aceptación condicionada, no autorización
   de ejecución.
6. **Marco/consumidores:** aceptación de promotion_id singular y pruebas
   operativas de límites antes de composición HTTP. Se mantienen los límites
   comunicados de 12 campañas, 100 líneas, 250000 unidades y 100 ms.

G7 queda diferido en fase funcional; ello no constituye autorización para omitir
fuentes comerciales, publicar mutaciones anónimas o activar AMQP.

## Validación ejecutada

| Comando                                                                                                         | Resultado                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm test -- apps/promotions-svc --maxWorkers=1`                                                                | 288 PASS                                                                                   |
| `npm run test:e2e -- apps/promotions-svc --maxWorkers=1`                                                        | 11 PASS                                                                                    |
| `npm test -- --maxWorkers=1`                                                                                    | 1017 PASS, 17 omisiones optativas                                                          |
| `npm run test:e2e -- --maxWorkers=1`                                                                            | 397 PASS, 87 omisiones optativas                                                           |
| `npm test -- apps/promotions-svc/src/coupons/catalog-h4-adapters.spec.ts --maxWorkers=1`                        | 7 PASS tras añadir rechazo explícito de envelope distinto de v1, antes de SQL              |
| `npm run typecheck`, `npm run lint`, `npm run build:promotions-svc`, `npm run format:check`, `git diff --check` | PASS                                                                                       |
| `node scripts/seed/mcp/promotions/test/seed-locking-proposal.mjs`                                               | 9 grupos PASS con PostgreSQL 17.11 descartable; hashes actualizados en evidencia del 01/11 |
| Regresión node:test de seed/DATA/restore (mismo comando de AVANCE-ISSUES)                                       | 50 PASS                                                                                    |

Los primeros intentos de desarrollo detectaron el test de coexistencia con
sesión superuser y una expectativa de error de cesta que quedó obsoleta tras
INT-04; se corrigieron y repitieron los comandos. No se omitieron esas pruebas.
Se conservaron los cambios previos sin commit. No se ejecutó integración de
estos nuevos adaptadores con proveedores compartidos ni CI de un SHA publicado.

## Archivos de este avance

- `apps/promotions-svc/src/domain/commercial-context.ts`
- `apps/promotions-svc/src/infrastructure/http/commercial-http.ts`
- `apps/promotions-svc/src/infrastructure/http/commercial-http.spec.ts`
- `apps/promotions-svc/src/http/query-controller.ts`
- `apps/promotions-svc/src/coupons/catalog-h4-adapters.ts`
- `apps/promotions-svc/src/coupons/catalog-h4-adapters.spec.ts`
- `apps/promotions-svc/RESPUESTAS-Y-AVANCES-2026-11-01.md`
- `apps/promotions-svc/AVANCE-ISSUES-2026-11-01.md`
- `scripts/seed/mcp/promotions/PROPUESTA-LOCKING-SEED.md`
- `scripts/seed/mcp/promotions/test/seed-locking-proposal.mjs`
- `scripts/seed/mcp/promotions/test/support/seed-locking-proposal.sql`
- `scripts/seed/mcp/promotions/test/evidence/seed-locking-proposal-2026-11-01.json`
