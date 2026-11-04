# CI/CD, versiones y trazabilidad

**Fuentes:** backend `castilla`/`origin/master`, archivos `ops/oracle` y workflows; GitHub API de solo lectura para CI/Deployments y metadata del host. No se ejecutaron workflow, build, deploy, pull ni rollback.

## Git y registro

- Checkout: rama `castilla`, SHA `9fb59128da489f4173e97739c3d27e459087ead2`. Existía `scripts/demo-fallback/` no rastreado y se preservó.
- `origin/master` local y API GitHub: `9205eb455c4965a82ccb9fc4714cf976e4c059b0`.
- `services.psv`: nueve servicios `enabled=true` para selección manual. `auto-release-authorization.psv`: nueve `false`.
- Ejecutable remoto `/usr/local/lib/g6-productos-ofertas/deploy-g6-service`: `ejecutor=4 registro=2`. Checksums SHA-256 del ejecutor, registro, manifiesto y Compose genérico/Gateway coinciden con los archivos de `castilla` inspeccionados.
- Workflow conserva `workflow_dispatch` manual; el camino `workflow_run` condicionado por CI no selecciona servicios con las nueve autorizaciones automáticas desactivadas.

## Imágenes y GitHub Deployments

| Servicio | Imagen/SHA observada | Deployment | CI para SHA de imagen | Conclusión actual |
|---|---|---|---|---|
| Gateway | `9205eb455c4965a82ccb9fc4714cf976e4c059b0` | 7141349417 `success`, 2026-10-17 14:56Z | CI SHA master `success`, run 39038657868 | Desplegado, ahora Docker unhealthy |
| Catalog | `9205eb455c4965a82ccb9fc4714cf976e4c059b0` | 7140790395 `success`, 2026-10-17 14:09Z | CI SHA master `success`, run 39038657868 | Desplegado, readiness 503 |
| Pricing | `2970df90babf2c8caa1849b179b02918fc74a005` | 7140311508 `success`, 2026-10-17 13:25Z | CI SHA 2970… `success`, run 39025392469 | Desplegado; negocio/Gateway pendientes |
| Taxonomy | `97ca576282e93e8b35f4bc33b5cbcb972e63caef` | 7135582341 `success`, 2026-10-17 06:00Z | CI SHA 97ca… `success`, run 39005668737 | Desplegado; GET categorías/readiness comprobados |
| Price Audit, Promotions, Inventory, Combos, Bulk | Sin contenedor | No se consultó deployment por servicio | No aplica a imagen en ejecución | No desplegados |

Las referencias anteriores son deployments de GitHub reportados `success`; no prueban readiness actual, E2E ni rollback. Tags en contenedores coinciden con SHA del historial de deployment. Los marcadores `active-image` coinciden con las imágenes de los cuatro servicios observados; `previous-image` existía para Gateway/Pricing y contenía el mismo SHA activo. No se observó marcador para Catalog/Taxonomy. No hay evidencia de rollback ensayado.

## Estado de procedimiento

El ejecutor v4 y Compose genérico/Gateway instalados coinciden por checksum con `castilla`; `g6-http` existe con los cuatro servicios HTTP desplegados. La matriz de CD automático sigue desactivada. Rollback está configurado en el ejecutor/procedimiento, pero no fue ejecutado ni validado en este corte. No declarar release funcional de nueve servicios hasta cerrar readiness, smoke de lectura, auth y configuración de cada servicio.
