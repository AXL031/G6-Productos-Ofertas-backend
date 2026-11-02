# DATA-004 / #14 — Preparación offline de Inventario

Owner: Taco. Estado: **IMPLEMENTAR_PARCIAL**. Este directorio prepara una propuesta sintética de Inka Athletics y compara su contenido con un snapshot explícito. No contiene ejecutor SQL de escritura automática en Supabase ni credenciales; `ready_for_load` siempre es `false` hasta contar con la autorización formal de release.

## 1. Datos y referencias normativas

- `proposal.json`: dos ubicaciones sintéticas, umbral global 5, override de camisetas 3 y nueve saldos de siete SKU. Cantidades pequeñas para calzado, camisetas y balón, con variantes de stock normal/bajo/cero; sin filas de relleno.
- `catalog-reference.json`: extracto de identidades ratificado formalmente por Gabriel Poma (Catálogo #12) el 2026-11-02 tras inspección en Supabase (`catalog.products`, `catalog.variants`, `catalog.sku_identity`). Se confirman los 7 SKU válidos y vigentes en estado BORRADOR (no publicados comercialmente); los SKU `-BASE` de productos con variantes son no vendibles y quedan estrictamente excluidos de saldos.
- `baseline-empty.json`: simulación sintética vacía para pruebas unitarias sin conexión.
- `baseline-supabase-2026-11-02.json`: snapshot de solo lectura (`READ_ONLY_EXPORT`) obtenido con autorización expresa de Infraestructura (Marco Castilla) sobre el proyecto `slzglmtiyrzygpkiuthf` (PostgreSQL 17, esquema `inventory`). Contiene el estado real: 2 ubicaciones, 14 saldos, 14 operaciones de inicialización y 12 movimientos Kardex.
- `dry-run.mjs`: validador y comparador offline.
- `proposal-load.sql`: propuesta de script SQL transaccional atómico e idempotente para la carga de umbrales no existentes sin sobrescribir saldos existentes ni afectar otros esquemas.

## 2. Reproducción y ejecución offline

Desde la raíz de Backend:

```powershell
# Pruebas unitarias de integridad del preparador
node --test apps/inventory-svc/data/data-f1/dry-run.test.mjs

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

Conforme a las condiciones establecidas por Marco Castilla para la preparación de la carga:

1. **Aislamiento y Destino:** Limita su acción estrictamente a `inventory`. No realiza lecturas ni escrituras en esquemas ajenos (`catalog`, `pricing`, `promotions`, etc.).
2. **No Regresión de Saldos Existentes:** No contiene `UPDATE` ni `DELETE` sobre `stock_balance`. Respeta los 14 saldos existentes en Lurín y Miraflores.
3. **Idempotencia:** Las inserciones de umbrales utilizan `ON CONFLICT (id) DO NOTHING` con UUIDs deterministas UUIDv5.
4. **Atomicidad:** Transacción protegida por `BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED` con validaciones previas y posteriores en bloques `DO $$`. En caso de cualquier discrepancia, la transacción aborta limpiamente (`ROLLBACK`).
5. **Condición de Release:** No se ejecutará en Supabase hasta recibir la segunda autorización escrita de Marco Castilla.

## 5. Plan de Verificación y Recuperación

1. **Verificación Posterior:**
   - Consulta de conteo y claves en `inventory.stock_threshold_override` (debe registrar exactamente 2 filas).
   - Verificación de integridad referencial de ubicaciones (`ALM-LURIN` y `TDA-MIRAFLORES`).
   - Cotejo de no alteración de `inventory.stock_balance` (permanecen los 14 saldos).
2. **Recuperación ante Errores:**
   - La ejecución está condicionada a `ON_ERROR_STOP on`. Si cualquier verificación falla, el bloque produce `ROLLBACK` total.
   - En caso de reversión manual requerida, el script define la eliminación selectiva por clave primaria de los 2 umbrales insertados, sin afectar tablas operativas.

## 6. Estado y Dependencias Externas

- **Poma / Catálogo #12:** Ratificación técnica completada (7 SKUs en BORRADOR; -BASE excluidos). Falta publicación comercial futura de los productos.
- **Marco / Infraestructura:** Primera autorización cumplida (extracción de lectura y dry-run offline). Pendiente segunda autorización formal para la carga de umbrales.
- **Estado del Issue #14:** `IMPLEMENTAR_PARCIAL`.
