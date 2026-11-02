# Resolución de los puntos 4–9 — Catálogo

Fecha: 2026-10-26. Rama: `poma`. Issues auditados: #43, #44, #45 y #46.
Fuente funcional: decisiones entregadas por Gabriel para los puntos 4–9 y su
aclaración sobre PRODUCT_TYPE_CHARACTERISTIC. No autoriza ejecutar migraciones
compartidas, modificar otros servicios, abrir/fusionar PR ni cerrar issues.

## Fuentes consultadas

- Docs `master@e6a8ec28dad2d0eba8dc2f273ec9cc6891376df6`: OpenAPI, AsyncAPI,
  SPEC-003/004/010, modelo físico Catalog, registro/matriz DEC-F e intermodular.
  DEC-F-001 (SKU), 006 (Pricing) y 009 (idempotencia) siguen aplicando.
- Acuerdo G1–G6 H4 y ALINEACION_MARKETPLACE publicados en Docs; se consultó además
  README, matriz de 25 operaciones y plan de pruebas Marketplace de Backend.
- Guía DevTeam, contrato/ficha Catalog, matriz de dependencias, compatibilidad
  RabbitMQ y checklist predeploy de Oracle. Son fuentes con cortes históricos,
  no verificación del ambiente al día de esta implementación.
- GitHub #43–#46 consultados en esta fecha: los cuatro permanecen abiertos.
  Sus evidencias históricas no sustituyen la validación del nuevo SHA.

## Implementación

| Punto | Estado interno | Implementación y límites |
|---|---|---|
| 4 Q-06 | IMPLEMENTAR_AHORA | PATCH acepta tipoProductoId no vacío. Cambio real requiere BORRADOR, simple, cero hijos persistidos, publicado_alguna_vez=false y catalogVersion vigente. Valida todos los atributos conservados contra el tipo/esquema efectivo y su schemaVersion; incompatibles rechazan sin borrado automático. Permite colección corregida en el mismo PATCH; obligatorios ausentes solo impiden activar. |
| 5 REJECTED | IMPLEMENTAR_AHORA | Se verifica y conserva manual_retry_allowed=false para cualquier código; no se borra el diagnóstico real. Ediciones locales no habilitan replay. COMPLETED sigue terminal. |
| 6 PENDING | IMPLEMENTAR_AHORA | Configuración integrada aprobada: CATALOG_PREPARATION_TIMEOUT_MS=300000. Límite inclusivo desde published_at del intento vigente, nunca desde created_at ni desde una publicación no confirmada. Sin variable, no hay recuperación por timeout; producción permanece así antes de homologación. No se han modificado runtime.env ni ambientes remotos. |
| 7 SKU explícito | IMPLEMENTAR_AHORA | Ausente/null/vacío/no string: 422 SKU_INVALIDO antes de la transacción. Se elimina el puerto de generación; no hay generador. Se conservan ceros, opacidad, unicidad global y reserva histórica de sku_identity. |
| 8 Barreras | IMPLEMENTAR_PARCIAL | Cuatro entidades resueltas, Inbox/Outbox/barrera atómicos, source_version obligatoria, dedupe técnico y por operación, advisory locks compartidos por escrituras y check. Final coincidente libera; CLEAR, timeout propio, final obsoleto, versión ausente/distinta u otra operación no liberan. |
| 8 Asociación | BLOQUEADO_ESPECÍFICO | entity_id no tiene resolución inversa aprobada. Se conserva una barrera bloqueante, alerta y evidencia; no hay CLEAR ni liberación de la asociación. La propuesta de añadir tipo_producto_id/caracteristica_id NO se implementa ni se presenta como aprobada. |
| 9 Consultas variantes | IMPLEMENTAR_AHORA | Controller valida IDs UUID, queries soportadas y correlación antes de repositorios. Inválidos: 400 VALIDACION. IDs válidos ausentes: 404 contractual. DTO, seguridad y demás respuestas permanecen. |

## Persistencia y concurrencia

`migrations/0003_product_publication_history.sql` se añade después de 0002.
No modifica 0001. Añade BOOLEAN nullable sin backfill; solo después establece
DEFAULT false para nuevas filas. Trigger en la misma transacción confirma true
cuando el producto pasa BORRADOR→ACTIVO. true es irreversible; tampoco se permite
convertir manualmente NULL a false. No se infiere historial de SKU, estado actual,
preparación ni una activación fallida. Una reversión de transacción revierte el
indicador junto con la activación. Aplicación exclusivamente mediante el owner
`po_catalog_owner`, no por bootstrap ni comandos SQL administrativos ordinarios.

Las barreras utilizan las tablas existentes, sin migración propia. La clave de
advisory lock codifica sin ambigüedad `(master_type, master_id)`; IDs opacos no se
interpretan. Las mutaciones toman claves en orden estable. Los checks no toman
locks de filas de producto después del lock de maestro, evitando invertir el
orden de las mutaciones. Se comprueba uso tras obtener el advisory lock.

CHARACTERISTIC_VALUE revisa atributos de producto ACTIVO, de variante ACTIVA y
`variants.identifying_key` de variantes activas, incluso con padre no activo.
Las filas de sku_identity no tienen un estado activo independiente.

Una asociación no resoluble requiere un gate compartido/exclusivo adicional para
serializar su instalación con nuevas dependencias. Mientras exista esa barrera
no es posible conocer qué tipo afecta: por seguridad se rechazan nuevas
dependencias y activaciones; no se bloquean lecturas, bajas o cambios que no
introduzcan referencias. Se alerta al instalarla y periódicamente si falta final.
El diagnóstico de un minuto es solo observabilidad, no timeout de liberación.

## Contratos preparados, todavía no publicados en Docs

Los parches `contracts/openapi.points-4-9.patch`,
`contracts/asyncapi.points-4-9.patch` y `contracts/docs.points-4-9.patch` se generan
contra el SHA de Docs indicado. Aplicarlos en un checkout de ese repositorio con
`git apply --check --unidiff-zero <ruta-absoluta-del-parche>` y luego
`git apply --unidiff-zero` dentro del
proceso autorizado. No ejecutar esos parches contra Backend.

OpenAPI: tipoProductoId opcional, 422 TIPO_PRODUCTO_INVALIDO en actualizarProducto,
SKU requerido/no nullable y 400 VALIDACION en ambas consultas de variantes.
AsyncAPI: tipa solo los cuatro mensajes de barreras existentes, exige operation_id
UUID y conserva exchanges/routing keys/topología; no incorpora la ampliación
de asociación todavía no ratificada. SPEC-004, FLOW-004, MK-004 y modelo físico
se alinean en los parches. SPEC-010 mantiene su regla funcional.

Los YAML resultantes se analizaron y verificaron: operaciones no afectadas,
mensajes no afectados y topología no cambian. Estos parches no prueban publicación
de contrato, despliegue ni homologación. El código AMQP preexistente conserva su
topología candidata; su reconciliación con la topología física sigue siendo gate
de integración/despliegue y no se resuelve cambiando nombres unilateralmente.

## Pruebas y evidencia

Validación local ejecutada antes del commit: `npm test -- --maxWorkers=2`
797 PASS (Catálogo: 368 PASS); `npm run test:e2e -- --maxWorkers=2`
435 PASS / 95 SKIP (Catálogo: 80 PASS / 42 SKIP). Tipos, lint, formato,
compilación general, tipos explícitos E2E y diff sin errores: PASS. Una primera
ejecución concurrente de la suite unitaria tuvo un timeout de carga de 5 s en
inyección Nest; la suite completa posterior con dos workers pasó sin cambiar
la prueba. Un intento inicial dentro del sandbox falló por EPERM en temporales
de Vite; las pruebas se ejecutaron con acceso normal a temporales.

- Casos unitarios Q-06: elegible, histórico NULL, publicado, estados, variantes,
  versión ausente/obsoleta, atributos retenidos/corregidos, tipo inválido y fallo
  Taxonomy. Verificación de schemaVersion y SKU obligatorio.
- Mensajes: tipos/versión/operación/códigos, IDs opacos y cinco minutos desde la
  publicación confirmada. REJECTED/COMPLETED nunca recuperables manualmente.
- HTTP: entradas inválidas 400, IDs válidos ausentes 404, queries duplicadas,
  estructuras no admitidas, estado/paginación y correlación.
- Suite PostgreSQL ampliada: histórico anterior a migración, transición de
  publicación/rollback, Q-06 con versión real, barreras CLEAR/IN_USE, duplicados,
  finales obsoletos, asociación bloqueada, variante activa con padre borrador y
  carreras de locks en ambos órdenes.
- Docker no está instalado localmente: los casos PostgreSQL/TLS/RabbitMQ se
  omiten explícitamente aquí. Solo una CI posterior exitosa para el nuevo SHA
  podrá acreditarlos. No reutilizar CI 40064061325 como prueba de este cambio.

## Condiciones de cierre de issues

| Issue | Evaluación |
|---|---|
| #43 estructura/config | Su alcance interno ya tiene implementación y pruebas de config/probes; candidato a cierre técnico con evidencia del SHA. No acredita readiness Oracle estable ni despliegue. |
| #44 persistencia | Implementación propia y migraciones aditivas preparadas; requiere ejecución PostgreSQL aislada del nuevo SHA para acreditar el cambio. La migración compartida es un estado separado. |
| #45 negocio | Avances implementados, pero no cierre integral: asociación PRODUCT_TYPE_CHARACTERISTIC y homologación del protocolo siguen pendientes. No afirmar que todas las barreras están operativas. |
| #46 HTTP | Consultas y validaciones implementadas, pero no cierre integral: filtros de precio siguen necesitando identidad/contexto/canales de Pricing y los parches OpenAPI deben incorporarse oficialmente. |

No se cierran issues por decisiones funcionales solamente ni se infiere merge,
integración autenticada, homologación o despliegue de una prueba local.

## Dependencias externas

| Owner | Operación afectada | Condición verificable |
|---|---|---|
| López + Marco | PRODUCT_TYPE_CHARACTERISTIC | Ratificar y publicar correspondencia verificable del ID de asociación (propuesta: tipo_producto_id y caracteristica_id en el mensaje existente), implementar productor y probar ida/vuelta antes de habilitar CLEAR/liberación. |
| López + Marco/BD | Bajas de Taxonomy | Migración versionada de source_version, taxonomy_version de asociación, unicidad de operación activa y timeout de 60 s; ejecución autorizada y prueba conjunta. Catalog no modifica ese schema. |
| Vera + G7 + Poma | Filtrado por precio | Identidad técnica propia autorizada, proveedor real de credenciales, contexto SKU sin recursión y mapeo de canales; pruebas autenticadas reales. La rama Vera consultada sigue en dff8b704cc1f2e1df5f87e17ed11d9c97c8f6e76. |
| Marco/Docs | Contratos y modelo | Incorporar los tres parches sobre la base citada, ejecutar validadores de Docs y publicar el SHA normativo; homologar cambios incompatibles con consumidores. |
| Owner BD + Marco | Catálogo compartido | Aprobar/versionar/aplicar 0002 y 0003 con permisos mediante proceso oficial y smoke en el entorno. Ninguna fue aplicada a Supabase/Oracle por esta tarea. |
| Infra/Marco | Transporte AMQP | Nombres, bindings, red privada y permisos reconciliados y probados para ambos servicios. CI aislada no concede permisos sobre Oracle. |
| Bulk/Arquitectura | Upsert masivo | Homologar payloads existentes; consumidor futuro reutiliza servicios de dominio y barreras. No se crea una vía alternativa ahora. |

Estado global: PARTIAL. Decisiones 4–7/9 cerradas funcionalmente; implementación
propia preparada. Asociación del punto 8, contratos oficiales, integración y
operación compartida conservan las condiciones específicas anteriores.

## Seguimiento de CI y excepción compartida autorizada

La primera CI del bloque, 40386214882 sobre fd5aa768dab9b27a0207be177c0778b2b3f26b7b,
falló en PostgreSQL por tres causas verificadas: comparación DATA-002 de la fila
JSON completa frente a la columna nueva; aserción de concurrencia que suponía
un orden de ganadores; y limpieza de fixture que intentaba DELETE con el rol
runtime, que correctamente carece de ese permiso. La limpieza se realiza ahora
con el owner de la base desechable y exclusivamente para el operation_id de la
prueba. No se amplían permisos runtime ni se cambia la lógica de barreras.

Gabriel autorizó expresamente la excepción de AGENTS.md §3 para modificar una
sola comparación en scripts/seed/mcp/catalog/003_carga_catalogo.sql: excluir
publicado_alguna_vez del JSON que se compara con el manifiesto histórico.
No cambia el valor de la columna ni los datos del seed, y conserva las restantes
comprobaciones. No se ejecuta contra bases compartidas. El parche propuesto
se conserva como evidencia del alcance aprobado. La CI fallida es histórica;
una nueva ejecución debe verificar el commit que incorpora estas correcciones.
