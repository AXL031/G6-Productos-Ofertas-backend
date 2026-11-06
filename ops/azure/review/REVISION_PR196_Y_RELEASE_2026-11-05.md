# Actualización de #196 y preparación de release Azure

## PR actualizada, sin merge

| Campo | Evidencia |
|---|---|
| PR | [Backend #196](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/196) |
| HEAD definitivo | `e004612431450aea0e9fd8b70db3b7ee3f6fbc8b` |
| Master incorporado | `a9c19ded7f6ac6e7714cf8d84244a396bdec0559` |
| CI del HEAD | [42152252351](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42152252351), SUCCESS, 18/18 jobs |
| CI de la base | [42151731086](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42151731086), SUCCESS |
| Método | Merges normales de base, sin rebase, force push ni resolución manual |
| Estado requerido | Abierta, draft, sin fusionar; pendiente de nueva comprobación/autorización |

Partiendo del HEAD revisado `44a6b0e...`, se incorporó primero el master solicitado
`5114c256...`, generando `99820594ed12376a25c24020281559eced3856e0`.
Durante esa CI se detectó y reportó el avance posterior #199 en Bulk/Inventory.
Sin conflictos, se incorporó también esa base para no dejar la revisión retrasada
desde el inicio. Los padres del HEAD definitivo son `99820594...` y `a9c19ded...`.

## Contenido Azure idéntico al aprobado

- Árbol `ops/azure/` original y final:
  `a9ebf2a7bac7594bd65afea6e35619798034b10e`.
- Diff binario completo original y final, SHA-256:
  `ae8106d1d2480bbcaa84dbcc0ea3e41e94d16af688a746564a9a48f969d11476`.
- Se comparó base original `15941b6...` → HEAD aprobado `d4d2426...` con
  nueva base `a9c19ded...` → HEAD definitivo `e004612...` mediante
  `git diff --binary --full-index -- ops/azure`.
- Ambos patches son idénticos byte a byte. `git diff --check`: PASS.
- El diff de #196 mantiene exactamente sus 14 archivos de `ops/azure/`.
- `git diff --exit-code a9c19ded... e004612... -- apps ops/oracle`: PASS, vacío.
- Los cambios oficiales de Taxonomy, Combos y Bulk/Inventory proceden del merge
  normal de master. Azure no introduce modificaciones de esos servicios.

La documentación y la plantilla de release de esta entrega solo se añaden a
`cueva`; no se insertan en la rama de #196 ni alteran los 14 archivos auditados.

## Estado de las tres imágenes oficiales

| Servicio | SHA/digest verificado para desplegar |
|---|---|
| api-gateway | PENDIENTE |
| catalog-svc | PENDIENTE |
| taxonomy-svc | PENDIENTE |

El listado oficial de `publish-only-images.yml` no registra ejecuciones en la
consulta de esta entrega. No se disparó ninguna publicación. El preflight anterior
registró 403 por falta de `read:packages` y 401 de GHCR anónimo; no se acredita
inexistencia de imágenes, sino ausencia de tres digests de release verificables
para el operador Azure. Se conserva el registro oficial, sin builds del fork.

Owner: Marco (`mrcastilla8`), único actor autorizado por el workflow oficial.
Condición de desbloqueo: entregar tres imágenes oficiales que incluyan #195,
sus SHA/digests verificados, runs y acceso de pull. Debe usar la punta vigente
de master con CI exacta satisfactoria; `a9c19ded...` es la propuesta observada,
no una autorización de publicación ni un SHA válido si master ya cambió.

## Procedimiento y manifiesto preparados

- [Procedimiento de release y aprovisionamiento](PROCEDIMIENTO_RELEASE_APROVISIONAMIENTO.md):
  comandos para el publicador autorizado, verificación de artefactos, parámetros
  explícitos, gates de costos y pruebas posteriores.
- [release.psv](release.psv): tres filas con SHA/digest pendientes, sin inventarlos.
  Está bloqueado intencionalmente hasta que Marco confirme los artefactos.
- El ejecutor real `deploy-official-three.sh` fue probado contra esta plantilla en
  un contenedor local desechable sin red, sin socket Docker y sin credenciales:
  rechazó el manifiesto antes de cualquier despliegue. PASS.

## Plan de aprovisionamiento conservado

Azure for Students, Chile Central, `Standard_B2als_v2` (2 vCPU x64/4 GiB), Ubuntu
24.04, disco SO Standard SSD LRS 30 GiB, IPv4 pública Standard y SSH /32 aprobado
en el chat. Valores privados fuera de Git. Región y SKU se suministran explícitamente;
no se usan los defaults eastus/B1s ni fallback automático.

Tarifas del preflight: base US$45.408/730 h, US$2.99/48 h o US$4.48/72 h, más
operaciones de disco, transferencia e impuestos. Se renuevan las comprobaciones
antes de crear; saldo omitido por instrucción del usuario. La aprobación de costos
y aprovisionamiento sigue pendiente. No hay VM ni despliegue de esta entrega.

Antes del uso público: Supabase de mínimo privilegio con TLS verify-full, sin
migraciones/seeds; configuración real de rutas G7 protegidas; aprobaciones de cada
lectura; ensayo HTTPS de los cinco GET y negativos. La consulta por slug
`GET /api/v1/productos/por-slug/{slug}?canal=MARKETPLACE` es obligatoria.
No se publica el emisor simulado. Backend #144 permanece abierto.
