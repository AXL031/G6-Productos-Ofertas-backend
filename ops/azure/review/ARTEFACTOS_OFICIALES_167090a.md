# Artefactos oficiales disponibles — SHA 167090af

Fuente común: Backend oficial, SHA
`167090af6d4ae93adbde54b6741dd994d91bf70b`, con #195 y #196 integradas y
[CI push/master satisfactoria, 18/18](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42154976533).
No se construyeron releases desde `cueva`.

## Publicaciones verificadas

| Servicio | Workflow oficial exitoso | Digest de manifiesto |
|---|---|---|
| api-gateway | [42156222356](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42156222356) | `sha256:de3d0f11ed5fbeb76c42745d17e5e5926805783bb20f74cdd1e3d0c7c1a12ca0` |
| taxonomy-svc | [42156702566](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42156702566) | `sha256:1ccf97dbb238f870330266f7ae4d7a5a5ddf16b5927a1f7f2f3d9f25ce5caa94` |
| catalog-svc | [42157500573](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42157500573) | `sha256:16c9d940be74e1b67ef010099ca8b563eb765eba2e27aa3ea5672bb9d7e89e20` |

Registro: `ghcr.io/taller-sw-web/g6-productos-ofertas-backend/<servicio>`.
Se verificaron evento workflow_dispatch/master, actor `mrcastilla8`, SHA exacto,
job y paso de verificación exitosos. Los digests se extrajeron programáticamente
de las líneas reales `SHA: digest: ... size: ...` y se cotejaron con el
`PUBLISHED_DIGEST` del paso final. Los workflows acreditan verificación de digest
y etiquetas OCI; esta sesión no ha repetido el pull autenticado del operador.

## Manifiesto privado preparado

Se generó una copia privada `release.psv` fuera del repositorio, con las tres
filas reales, en orden Taxonomy → Catalog → Gateway, y el SHA común anterior.
La estructura y la correspondencia con los workflows fueron validadas.
No se ejecutó el manifiesto ni el ejecutor de despliegue.

La [plantilla pública](release.psv) conserva valores pendientes para no confundir
la documentación con la copia operativa privada. Completar el manifiesto no
concede aprobación de release, recursos ni operaciones públicas.

## Bloqueo específico: acceso del operador

`docker manifest inspect --verbose` por digest devolvió **unauthorized** para los
tres servicios usando la configuración local existente. No demuestra inexistencia
de imágenes ni permite distinguir por sí solo entre credencial ausente/inválida,
scope insuficiente o ACL del paquete.

Para paquetes privados, confirmar el permiso de lectura del usuario operador y
un mecanismo de autenticación GHCR con `read:packages`, según la
[documentación oficial de permisos](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages).
La credencial se configura por un mecanismo seguro; no se solicita en el chat,
no se incluye en Git ni en los argumentos de comandos de despliegue.
No se cambiaron scopes, permisos, visibilidad de paquetes ni credenciales aquí.

Owner: Marco para confirmar acceso de los tres paquetes y Axel para configurar la
autenticación local/operativa autorizada. Condición de desbloqueo: leer los tres
manifiestos por digest y comprobar pull, RepoDigests, revisión OCI y Linux/amd64.
La descarga **desde Azure** sigue NO EJECUTADA: no hay VM autorizada ni creada.

## Preparación restante

- [Checklist de despliegue](CHECKLIST_DESPLIEGUE_AZURE.md).
- [Plan HTTPS de Marketplace](PLAN_PRUEBAS_HTTPS_MARKETPLACE.md).
- [Procedimiento y parámetros explícitos](PROCEDIMIENTO_RELEASE_APROVISIONAMIENTO.md).

Costo/aprovisionamiento y publicación individual de las cinco operaciones siguen
pendientes. No se aprovisionó, desplegó ni activó PUBLIC_READ_ONLY. Emisor
simulado exclusivamente local. Backend #144 permanece abierto.
