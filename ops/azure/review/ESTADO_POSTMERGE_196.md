# Estado posterior al merge de #196

- PR integrada: [Backend #196](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/196).
- HEAD aprobado: `e004612431450aea0e9fd8b70db3b7ee3f6fbc8b`.
- Merge/master observado: `167090af6d4ae93adbde54b6741dd994d91bf70b`.
- Padres del merge: `a9c19ded7f6ac6e7714cf8d84244a396bdec0559` y el HEAD aprobado.
- Árbol del HEAD aprobado y del merge idéntico:
  `b466b68e6b4742abbbe4c38241489bee735bf89f`.
- [CI posterior 42154976533](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42154976533):
  **SUCCESS, 18/18 jobs exitosos**, evento push, SHA exacto del merge.
- [CD posterior 42155586253](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42155586253):
  preparación satisfactoria; publicación/despliegue omitidos. No acredita release
  ni servicios funcionando en Oracle o Azure.

## Artefactos oficiales pendientes

El flujo `publish-only-images.yml` no registra ejecuciones en esta consulta.
No se disparó desde esta sesión. Marco (`mrcastilla8`) es el operador autorizado
por el guard vigente. La propuesta de fuente se actualizó al merge `167090af...`;
se requiere revalidar master y CI exacta al publicar.

| Servicio | Digest verificado para el manifiesto |
|---|---|
| api-gateway | Pendiente |
| catalog-svc | Pendiente |
| taxonomy-svc | Pendiente |

La falta de acceso a GHCR no permite afirmar que los paquetes no existan.
Marco debe entregar los tres runs/publicaciones, SHA, digests y acceso de pull.
Después se comprobarán el manifiesto, las etiquetas OCI y la descarga por digest;
la descarga desde la VM Azure solo puede acreditarse cuando se autorice y exista.

La [plantilla release.psv](release.psv) sigue bloqueada con SHA/digests pendientes;
solo su comentario de fuente candidata cambió. No contiene valores inventados.
El [procedimiento](PROCEDIMIENTO_RELEASE_APROVISIONAMIENTO.md) contiene los tres
comandos propuestos para publicar sin desplegar Oracle y los parámetros explícitos
de la VM. No se ejecutaron esos comandos de publicación.

## Próxima etapa y autorizaciones

Se conserva Chile Central, Standard_B2als_v2, 2 vCPU/4 GiB, disco Standard SSD LRS
30 GiB e IP pública Standard. Renovar costo/cuotas antes de crear; costo y
aprovisionamiento no están autorizados. No se crearon recursos en esta entrega.

Mantener configuración autenticada y listas públicas vacías hasta aprobación
individual. El ensayo obligatorio de Marketplace incluye los cinco GET, en
particular `/api/v1/productos/por-slug/{slug}?canal=MARKETPLACE`, positivos reales
y negativos de inactivos, borradores, JWT inválido y rutas administrativas.
Sin migraciones/seeds compartidos; emisor simulado exclusivamente local.
Backend #144 permanece abierto.

Esta actualización solo documenta la transición a publicación/preparación de
Azure en el fork. No corrige #196 ni modifica aplicaciones o scripts aprobados.
