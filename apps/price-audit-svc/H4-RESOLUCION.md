# Price Audit — resolución local de #63, #65, #66, #68 y #69

Corte: 2026-11-02, rama `vera`, base backend
`9f7be5e38be7b643acb956d8b3499459c146755b`, cambios locales sin commit.
Este informe sustituye las referencias a P-AUD-02 pendiente del README histórico.
No se han comentado ni cerrado issues, ni publicado cambios.

## Fuentes y alcance

Docs `40b566976fb94d924116dcd01d41b3276c2bc9e3`: SPEC-014,
DEC-G6-INT-06, registro/matriz DEC-F (001, 006, 009, 012 aplicables), matriz
intermodular, modelo físico Price Audit; OpenAPI 0.6.0-rc.3 y AsyncAPI
0.6.0-rc.4. También se consultaron AGENTS y las seis guías Oracle obligatorias.
Se conserva HTTP/auth existentes, sin modificar Gateway, Pricing o frontend.

La autorización del usuario permite **preparar** la migración, sin aplicarla a
Supabase. Solo las bases Docker desechables reciben DDL durante las pruebas.
No hay consulta ni escritura en BD compartida, ni credenciales reales utilizadas.

## Implementación interna

- Decoder productivo conectado al módulo: payload cerrado, actor nullable,
  identidad PRODUCTO/SKU, canal global null, metadatos y transiciones válidas.
- Porcentaje decimal exacto con BigInt, escala 2 y HALF_UP simétrico. No usa
  float para calcular ni comparar los importes. No se acepta MODIFICACION sin
  cambio efectivo. Timestamp del asiento = occurred_at, no valid_from.
- Un evento produce un asiento de su objetivo; moneda, price_version,
  valid_from y actor originales permanecen además en el payload Inbox.
- Migración nueva `migrations/0002_typed_price_change.sql`, sin tocar el SQL
  histórico: target_type con backfill SKU para asientos previos, SKU/canal
  nullable y checks. Se amplía numeric(12,2) a numeric para preservar los
  decimal-string de AsyncAPI sin redondeo silencioso. Contempla porcentaje
  indefinido ante precio anterior cero, conservando registros históricos.
- Inbox/bitácora siguen en la misma transacción, ACK después del commit;
  duplicados, rollback, reconexión y retención del mensaje incompatible probados.
  No hay declaración automática de topología ni cambios de ACL del broker.
- CSV/PDF conservan target_type; null no se reemplaza por SKU o canal ficticio.
- Readiness exige la columna de la nueva migración. No se ejecuta DDL al arrancar.

## Discrepancia HTTP aislada

SPEC-014 y DEC-G6-INT-06 requieren consultar PRODUCTO/sku=null y canal global;
RegistroAuditoriaPrecio en OpenAPI rc.3 todavía tipa sku/canal_origen como string.
No se modifica el contrato compartido. `wireAudit` responde 503 contractual si
algún registro tiene SKU o canal null, también en listas que lo incluyan; no
oculta filas, inventa valores ni publica DTOs incompatibles. La captura y la
exportación son independientes. Esto limita temporalmente esas lecturas.

## Estado por issue y dependencias

| Issue | Clasificación | Estado interno y condición pendiente |
|---|---|---|
| #63 | IMPLEMENTAR_PARCIAL | Decoder, cálculo e invariantes implementados. Archivo frío P-AUD-03 sigue sin formato/storage/proceso aprobados; no hay purga de originales. |
| #65 | IMPLEMENTAR_AHORA | Exportaciones existentes verificadas; no se añaden POST/PUT/PATCH/DELETE de asientos. Consumo tipado conectado; aplicación compartida de migración y rollout siguen separados. |
| #66 | IMPLEMENTAR_PARCIAL | Decoder real y broker/SQL desechables verificados. Owner Marco/infra: habilitar flujo compartido solo con ACL/red/topología y corte coordinado de productores/consumidores acreditados (#29/#110). |
| #68 | BLOQUEADO_ESPECÍFICO | Owner Gateway/Marco + frontend (#21/Frontend #45) + G7: ruta, interacción visible sin mock y autenticación real con SHAs verificables. No hay autorización para editar esos componentes en esta tarea. |
| #69 | IMPLEMENTAR_PARCIAL | AMQP tipado → Inbox/log → HTTP probado localmente; productor de la prueba es fixture explícita, no Pricing real. Owner Vera/Pricing: factory/emisión post-commit vigente y prueba conjunta. Gateway/UI/G7 y Oracle siguen pendientes. |

Dependencias adicionales:

- Marco/owner contractual: alinear RegistroAuditoriaPrecio para target_type,
  sku y canal nullable; después habilitar la proyección HTTP pendiente y probarla.
- Marco/administración BD: revisar/incorporar la migración al ledger canónico y
  aprobar su aplicación en entorno concreto; no ejecutar manualmente ni al boot.
- Vera + Marco: aprobar storage/formato/recuperación de archivo frío P-AUD-03
  antes de implementar retiro de originales. Este cambio no concede permisos.
- Marco/release #111: autorización individual, SHA/digest, imagen, TLS/red,
  readiness, smoke y recuperación. No se declara READY_FOR_DEPLOY.

## Evidencia local

Resultados y comandos de esta entrega se registran a continuación. JWT/JWKS
son fixtures criptográficas locales; PostgreSQL 16 y RabbitMQ 4.2 son Docker
descartables en loopback. Las pruebas propias DB no acreditan TLS de Supabase,
grants G7, homologación, CI ni despliegue.

- `npm test -- apps/price-audit-svc`: PASS, 100 pruebas antes de dos casos
  adicionales de dominio, incluidos decoder y porcentaje; suite propia final
  en `npm test`: 102 PASS.
- `npm test`: PASS, 1881 pruebas y 56 omitidas; incluye 102 de Price Audit.
- `npm run test:e2e -- apps/price-audit-svc`, con
  PRICE_AUDIT_TEST_POSTGRES=1 y PRICE_AUDIT_TEST_AMQP=1: PASS, 21 pruebas finales,
  incluidas HTTP inmutable/readiness de migración y decoder productivo sin override.
- `npm run typecheck`, `npm run lint`, `npm run build:price-audit-svc`: PASS.
- tsc estricto explícito de todas las fuentes y tests de Price Audit: PASS.
- `npm run format:check` y `git diff --check`: PASS.
- Prettier sobre el directorio completo detectó formato previo de README.md;
  el chequeo de TypeScript global pasa. No se reformatea documentación histórica.
- E2E general: 920 PASS, 210 omitidas, una suite FAIL de Catalog por OpenSSL
  ausente en PATH. Revalidación de esa suite con OpenSSL instalado de Git: PASS,
  4 pruebas. Repetición general con PATH corregido: FAIL, 1004 PASS / 125 omitidas /
  1 FAIL: `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts:883`,
  `validates the DATA-002 batch in disposable PostgreSQL`,
  `Error: Test timed out in 5000ms.` No se modifica Catalog.
  Owner Gabriel Poma: reproducir/corregir ese timeout y repetir su gate general.
- Sin npm ci, CI por nuevo SHA, build de imagen ni deploy en esta entrega.

## Archivos del cambio

Todas las rutas están bajo `apps/price-audit-svc/`:

- `src/domain/audit.ts`, `src/domain/audit.spec.ts`.
- `src/messaging/price-change-decoder.ts`, `src/messaging/price-change-decoder.spec.ts`.
- `src/messaging/audit-consumer.ts`, `src/messaging/audit-consumer.spec.ts`.
- `src/price-audit-svc.module.ts`.
- `src/persistence/audit.schema.ts`, `src/persistence/audit.database.ts`.
- `src/http/audit.controller.ts`, `src/exports/audit-file-worker.ts`.
- `migrations/0002_typed_price_change.sql`.
- `test/isolated-postgres.ts`, `test/consumer.amqp.e2e-spec.ts`,
  `test/provider.postgres.e2e-spec.ts`.
- `H4-RESOLUCION.md` y enlace desde `README.md`.

Estado integral: PARTIAL. Desarrollo interno, integración aislada, autenticación
externa, homologación y despliegue se mantienen como estados independientes.
