# DATA-002 — Catálogo Inka Athletics

Este PR reúne el issue #44 (persistencia Drizzle de `catalog-svc`) y DATA-002 (#12) (lote de catálogo Inka Athletics). Los artefactos de DATA-002 se integraron de nuevo al tip de `poma`; el lote queda preparado para reauditoría y validación aislada, pero **no se ejecuta en Supabase compartido**.

## Contenido y seguridad

- 15 productos propuestos: 12 con variantes y 3 simples; 45 variantes y 48 SKU vendibles. La presentación bloqueada por Taxonomía se mantiene fuera del SQL.
- 90 atributos de variante y 6 de productos simples usan JSONB no nulo `{"valor_id":"UUID"}`. Los 45 `identifying_key` son objetos por característica, con forma `{"<caracteristica_id>":{"valor_id":"<UUID>"}}`, igual a `catalog.fn_assert_product()`.
- La carga no modifica/elimina filas ni inserta manualmente `sku_identity`; se apoya en triggers oficiales y aborta ante contenido existente divergente.
- `001_preflight_readonly.sql` revisa referencias Taxonomía activas y relaciones tipo/característica. Bloquea con `DATA002_PREFLIGHT_BLOCKED` si detecta referencias faltantes/inactivas o relaciones no activas. `003_carga_catalogo.sql` repite la guardia dentro de la transacción antes de insertar.
- Once referencias no aparecen en el manifiesto local de Taxonomía; su estado real se mantiene **NO VERIFICADO** hasta un preflight de solo lectura autorizado contra el destino.
- `004_postcheck_readonly.sql` es una sola consulta SQL de solo lectura compatible con SQL/MCP; devuelve cada comprobación como `PASS` o `FAIL`, sin comandos propios de psql.

## Evidencia de imágenes

`005_matriz_productos_imagenes.csv` tiene 15 columnas sin duplicados y relaciona modelo, presentación, objeto Storage y URL pública con la fuente comercial, los SKU/tallas y la cantidad de filas de imagen asociadas al lote. La evidencia anterior registró 18 objetos: 17 asociados y 1 bloqueado por Taxonomía; las 17 URLs asociadas fueron cargadas e inspeccionadas visualmente en la verificación previa del 2026-10-16. Esta revisión no vuelve a consultar Storage compartido.

## Validación

`006_reporte_evidencia.md` contiene hashes SHA-256 actuales, resultados del PostgreSQL descartable y el límite de la validación de referencias activas. El lote completo se prueba localmente con primera ejecución, reejecución idéntica y conflicto de contenido. No correr el SQL contra Supabase compartido durante la auditoría.
