# DATA-004 / #14 — Preparación offline de Inventario

Owner: Taco. Estado: **IMPLEMENTAR_PARCIAL**. Este directorio prepara una propuesta sintética de Inka Athletics y compara su contenido con un snapshot explícito. No contiene ejecutor SQL de escritura automática en Supabase ni credenciales; `ready_for_load` siempre es `false` hasta contar con la autorización formal de release.

## 1. Datos y referencias normativas

- `proposal.json`: dos ubicaciones sintéticas, umbral global 5, override de camisetas 3 y nueve saldos de siete SKU. Cantidades pequeñas para calzado, camisetas y balón, con variantes de stock normal/bajo/cero; sin filas de relleno.
- `catalog-reference.json`: extracto de identidades ratificado formalmente por Gabriel Poma (Catálogo #12) el 2026-11-02 tras inspección en Supabase (`catalog.products`, `catalog.variants`, `catalog.sku_identity`). Se confirman los 7 SKU válidos y vigentes en estado BORRADOR (no publicados comercialmente); los SKU `-BASE` de productos con variantes son no vendibles y quedan estrictamente excluidos de saldos.
- `baseline-empty.json`: simulación sintética vacía para pruebas unitarias sin conexión.
- `baseline-supabase-2026-11-02.json`: snapshot de solo lectura (`READ_ONLY_EXPORT`) obtenido con autorización expresa de Infraestructura (Marco Castilla) sobre el proyecto `slzglmtiyrzygpkiuthf` (PostgreSQL 17, esquema `inventory`). Contiene el estado real: 2 ubicaciones, 14 saldos, 14 operaciones de inicialización y 12 movimientos Kardex.
- `dry-run.mjs`: validador y comparador offline.
- `proposal-load.sql`: propuesta de script SQL transaccional atómico e idempotente para la inserción de los 2 umbrales de stock no existentes, protegido con `pg_advisory_xact_lock` contra colisiones concurrentes y sin sobrescribir saldos existentes ni afectar otros esquemas.
- `proposal-rollback.sql`: script de reversión selectiva segura que elimina exclusivamente los 2 umbrales de stock atribuibles a DATA-004 mediante UUID determinista y verificación de payload, preservando cualquier umbral previo o ajeno y validando la integridad inmutable de los 14 saldos y las 2 ubicaciones.
- `proposal-sql.test.mjs`: suite de pruebas unitarias automatizadas que valida la sintaxis, locks consultivos, precondiciones, idempotencia funcional en replay y reversión selectiva con preservación de umbrales previos.
- `apps/inventory-svc/test/inventory.real.integration.spec.ts`: suite E2E en PostgreSQL desechable real (PostgreSQL 17) que ejecuta los archivos SQL directamente contra el esquema real de Inventory, cubriendo primera carga, replay, ejecución concurrente serializada, rollback selectivo y rechazo transaccional.

## 2. Reproducción y ejecución offline

Desde la raíz de Backend:

```powershell
# Pruebas unitarias de integridad del preparador
node --test apps/inventory-svc/data/data-f1/dry-run.test.mjs

# Pruebas unitarias de idempotencia, seguridad y reversión de scripts SQL
node --test apps/inventory-svc/data/data-f1/proposal-sql.test.mjs

# Dry-run contra simulación vacía (38 INSERT propuestos, 0 conflictos)
node apps/inventory-svc/data/data-f1/dry-run.mjs --baseline apps/inventory-svc/data/data-f1/baseline-empty.json --report dist/inventory-data-f1-dry-run.json

# Dry-run contra baseline real de Supabase (detecta saldos existentes y genera diff)
node apps/inventory-svc/data/data-f1/dry-run.mjs --baseline apps/inventory-svc/data/data-f1/baseline-supabase-2026-11-02.json --report dist/inventory-data-f1-dry-run-supabase.json
```

## 3. Resultado del Dry-run contra Baseline Real de Supabase

Al ejecutar el preparador contra el snapshot real de Supabase (`baseline-supabase-2026-11-02.json`), el sistema genera el reporte `dist/inventory-data-f1-dry-run-supabase.json`:

- **Estado:** `CONFLICT` (esperado por diseño; no se sobrescriben saldos existentes).
- **`ready_for_load`:** `false`.
- **Candidato SHA-256:** `6463cda113854e9a7af0813b42927851c76c0073f4248a3c4f7b21c8105e80d9`.
- **Resumen del Diff:**
  - `insert: 2` — Registros nuevos sin colisión: los 2 umbrales de stock (`stock_threshold_override`: global 5 y específico 3 para `ADI-ENT22-AZU-M`).
  - `unchanged: 5` — Registros idénticos ya presentes: las 2 ubicaciones (`ALM-LURIN` y `TDA-MIRAFLORES`), más los saldos coincidentes (p. ej. `ADI-RF3-GRI-39` con saldo 0 en ambas ubicaciones y `NIK-REV7-NEG-41` en Miraflores con 4 unidades).
  - `conflict: 31` — Colisiones controladas: corresponden a los 6 saldos donde la propuesta difiere de los saldos existentes en Supabase (advertidos por Poma y Marco) y sus operaciones/kardex/outbox asociados. El motor preserva los datos existentes y rechaza la sobrescritura destructiva.

## 4. Propuesta SQL Atómica e Idempotente (`proposal-load.sql`)

Conforme a las observaciones de auditoría de Marco Castilla:

1. **Idempotencia por Clave de Negocio Funcional y Protección contra Concurrencia:**
   - La restricción de unicidad no depende únicamente del UUID `id`. Se implementó protección con `WHERE NOT EXISTS` sobre la clave de negocio:
     - Umbral global: valida que no exista una fila con `sku_id IS NULL AND location_id IS NULL` (índice único `ix_threshold_global`).
     - Umbral específico: valida que no exista una fila con `sku_id = 'ADI-ENT22-AZU-M' AND location_id IS NULL` (restricción única `uq_threshold_override`).
   - Para evitar condiciones de carrera donde dos ejecuciones concurrentes evalúen `WHERE NOT EXISTS` en paralelo y colisionen en el índice único, se adquiere un lock transaccional consultivo al inicio de la transacción:
     `SELECT pg_advisory_xact_lock(hashtext('inventory.data-004.thresholds'));`
     Esto serializa limpiamente cualquier ejecución paralela; la segunda espera a que la primera comitee, evalúa `WHERE NOT EXISTS`, detecta la existencia del umbral y completa como `no-op` sin arrojar error.
   - Reejecutar el script (`replay`) produce cero inserciones adicionales y cero conflictos (`no-op`).
2. **Precondiciones Estrictas con Aborto Transaccional (`RAISE EXCEPTION`):**
   - El script no emite avisos pasivos (`WARNING`). Aborta inmediatamente con `RAISE EXCEPTION` y `ROLLBACK` automático si:
     - Las ubicaciones activas autorizadas en `inventory.locations` difieren de 2 (`ALM-LURIN` y `TDA-MIRAFLORES`).
     - La cantidad de saldos en `inventory.stock_balance` difiere de 14.
     - Ya existe un umbral global con valor distinto a 5.
     - Ya existe un umbral para `ADI-ENT22-AZU-M` con valor distinto a 3.
3. **Mecanismo de Ejecución Universal:**
   - Se retiraron meta-comandos propietarios de consola (como `\set ON_ERROR_STOP on`). El script es ANSI/PostgreSQL puro encapsulado en un bloque transaccional `BEGIN; ... COMMIT;`.
   - **Desde psql:** `psql -v ON_ERROR_STOP=1 -f apps/inventory-svc/data/data-f1/proposal-load.sql`
   - **Desde Editor SQL de Supabase:** Copiar y ejecutar el bloque completo directamente en la consola web del proyecto.
4. **Validación de Destino y Reversión Selectiva Segura:**
   - Valida activamente que la base conectada posea el esquema `inventory` y la tabla `stock_threshold_override`, fijando `SET LOCAL search_path = inventory, public;`.
   - Se provee el script de reversión `proposal-rollback.sql` que revierte **exclusivamente** las inserciones atribuibles y verificables a DATA-004 (filtrando por los UUIDs deterministas asignados y verificando su contenido exacto), protegiendo cualquier otro umbral preexistente en la base de datos.

## 5. Plan de Verificación y Recuperación

1. **Verificación Posterior:**
   - Comprueba que el umbral global sea exactamente 5 (`sku_id IS NULL AND location_id IS NULL`).
   - Comprueba que el umbral de `ADI-ENT22-AZU-M` sea exactamente 3 (`location_id IS NULL`).
   - Comprueba que los 14 saldos de `inventory.stock_balance` y las 2 ubicaciones no hayan sufrido ninguna mutación.
2. **Reversión Selectiva Segura (`proposal-rollback.sql`):**
   - Elimina estrictamente por los identificadores deterministas `0a24fa68-450f-5fa1-827d-78fb5f09fe54` y `7b49463c-333e-5e63-b8ad-344c20847250`, validando que su payload coincida. No incluye cláusulas genéricas `OR` que pudieran eliminar registros previos creados por otros procesos.
   - Utiliza también `SELECT pg_advisory_xact_lock(hashtext('inventory.data-004.thresholds'));` para serializar reversiones concurrentes.
   - Verifica antes de confirmar (`COMMIT`) que permanezcan exactamente los 14 saldos y las 2 ubicaciones; si no, aborta con `RAISE EXCEPTION`.
3. **Prueba SQL Real E2E en CI:**
   - Implementada en `apps/inventory-svc/test/inventory.real.integration.spec.ts` para ejecutarse contra PostgreSQL 17 desechable con el esquema real de Inventory.
   - Cubre: (a) primera carga, (b) replay idempotente, (c) ejecución concurrente en paralelo, (d) reversión selectiva comprobando la supervivencia de umbrales previos y de los 14 saldos, y (e) aborto con rollback ante precondición fallida.

## 6. Estado y Dependencias Externas

- **Poma / Catálogo #12:** Ratificación técnica completada (7 SKUs en BORRADOR; -BASE excluidos). Falta publicación comercial futura de los productos.
- **Marco / Infraestructura:** Primera autorización cumplida. Versión corregida del SQL lista para la revisión final de Marco.
- **Estado del Issue #14:** `IMPLEMENTAR_PARCIAL` (no se ejecutará ninguna escritura en Supabase compartido hasta contar con la segunda autorización escrita).
