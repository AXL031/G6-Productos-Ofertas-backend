# Cambios de Docs preparados para los puntos 4–9

Base exacta: `G6-Productos-Ofertas-docs@e6a8ec28dad2d0eba8dc2f273ec9cc6891376df6`.
Los tres parches son cambios revisables para el repositorio de documentación,
no nuevos contratos paralelos usados por el runtime de Backend.

En un checkout de Docs de esa base, verificar y aplicar individualmente:

```powershell
git apply --check --unidiff-zero <ruta-absoluta>/openapi.points-4-9.patch
git apply --unidiff-zero <ruta-absoluta>/openapi.points-4-9.patch
git apply --check --unidiff-zero <ruta-absoluta>/asyncapi.points-4-9.patch
git apply --unidiff-zero <ruta-absoluta>/asyncapi.points-4-9.patch
git apply --check --unidiff-zero <ruta-absoluta>/docs.points-4-9.patch
git apply --unidiff-zero <ruta-absoluta>/docs.points-4-9.patch
```

Después ejecutar los validadores propios de Docs y revisar el diff. No se aplican
en Backend, no modifican migraciones históricas y no se publicaron en Docs por
esta tarea. Se verificó que los YAML resultantes se analizan, contienen las
propiedades/respuestas aprobadas y preservan otras operaciones/mensajes y
topología. El patch documental incluye SPEC-004, FLOW-004, MK-004 y modelo físico.

La correspondencia inversa de PRODUCT_TYPE_CHARACTERISTIC permanece pendiente.
No se incluyen tipo_producto_id/caracteristica_id como campos requeridos del
mensaje: siguen siendo una propuesta por ratificar por López y Marco.
