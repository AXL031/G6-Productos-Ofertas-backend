# Preflight Azure — 05/11/2026 (America/Lima)

Estado: **IMPLEMENTAR_PARCIAL / despliegue pendiente**. Se verificaron recursos y
precios mediante consultas de lectura. No se crearon VM ni recursos G6, no se
publicaron imágenes y no se activaron operaciones públicas. Este informe no es
una autorización de gasto ni un `CostReviewPath` ejecutable.

## Código y divergencias oficiales

- Fase 1 integrada por #195: `d0a511a60a528772952c17a86af6ad40ba1cfdd5`.
- Master observado: `5114c2566175bc99a093c3db1068bf9512bb5d48`, descendiente del
  merge de #195. Su [CI oficial](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42147106563)
  terminó satisfactoriamente.
- Después de #195 se integraron #198 (autorización humana de Taxonomy), #197
  (Combos) y #202 (publicación GHCR independiente). También cambió el fixture
  PostgreSQL de pruebas. Se informa la divergencia; no se resolvió ni se sincronizó
  código unilateralmente en `cueva` o en la PR Azure.
- #196 sigue abierta/draft, HEAD `44a6b0e294336144648012df543ec3fa1645d0fd`,
  con la base anterior `d0a511a...`. La integración en master y cualquier nueva
  actualización se tratan separadamente del aprovisionamiento.
- El fork sigue siendo repositorio de trabajo; el runtime de los tres servicios
  procede de código oficial común. Backend #144 permanece abierto.

## Recursos propuestos, todavía sin crear

| Campo | Propuesta/evidencia |
|---|---|
| Suscripción | Azure for Students, Enabled; identificador completo en el plan privado |
| Región | `chilecentral`, permitida por política de la suscripción |
| SKU Linux | `Standard_B2als_v2`, 2 vCPU x64, 4 GiB RAM |
| Restricciones SKU | Ninguna devuelta por Resource SKUs API para esta suscripción/región |
| Cuota regional | 0/6 vCPU usadas; solicita 2 adicionales |
| Cuota familia Basv2 | 0/10 vCPU usadas; solicita 2 adicionales |
| SO | Ubuntu 24.04 LTS |
| Disco SO | 30 GiB `StandardSSD_LRS`, facturado en tramo E4 de 32 GiB, no compartido |
| IP de la VM | IPv4 pública Standard estática con nombre DNS; todavía no asignada |
| Red pública | TCP 80/443 para Caddy/HTTPS; puertos de aplicaciones solo en loopback |
| SSH administrativo | TCP 22 limitado al CIDR /32 confirmado en el chat; valor solo en plan privado |
| Crédito/saldo | No consultado; el usuario pidió continuar sin condicionarlo al saldo |

Disponibilidad de SKU y cuota no garantizan capacidad física al solicitar la VM.
No existe fallback automático a un tamaño más caro.

## Costo base estimado USD

Tarifas de consumo Linux, sin Spot ni Windows, obtenidas de la
[API oficial Retail Prices](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices).
El JSON adjunto conserva queries, URLs, fechas efectivas y medidores. Se reintentaron
secuencialmente dos consultas que inicialmente devolvieron HTTP 429.

| Concepto | Tarifa | Equivalente a 730 h |
|---|---:|---:|
| VM B2als v2 Linux | US$0.0526/h | US$38.398 |
| IP Standard IPv4 estática | US$0.005/h | US$3.650 |
| Disco E4 LRS 32 GiB | US$3.36/mes | US$3.360 |
| **Base** | | **US$45.408/mes** |

Prorrateo orientativo de la misma base: **US$2.99/48 h** o **US$4.48/72 h**.
No son un tope de facturación ni el importe efectivo de la oferta estudiantil.
No se han aplicado beneficios gratuitos ni se presume crédito restante.

Adicionales: operaciones de disco (US$0.0028/10 000 operaciones), transferencia
saliente según consumo/franja disponible, impuestos y cualquier recurso fuera
de esta VM. El medidor de montaje compartido E4 no se suma: este disco SO no
será compartido. [Facturación de discos](https://learn.microsoft.com/en-us/azure/virtual-machines/disks-understand-billing).
Los recursos de otros proyectos siguen teniendo sus costos propios.
Desasignar la VM detiene cómputo; conservar disco/IP puede seguir generando cargos.

Como comparación, B2as v2 (2 vCPU/8 GiB) cuesta US$0.105/h solo VM, con base
US$83.66/730 h incluyendo el mismo disco/IP. No se seleccionó ni se autoriza
automáticamente. B2ats v2 ofrece solo 1 GiB y no se propone para los cuatro procesos.

## Capacidad prevista y validación pendiente

Se propone 4 GiB para tres procesos NestJS más Caddy, sin PostgreSQL ni RabbitMQ
locales y sin builds en la VM. Es una hipótesis de dimensionamiento para pruebas
de baja concurrencia, no un benchmark aprobado. Presupuesto orientativo: hasta
1.5 GiB para los tres servicios, 128 MiB para Caddy, 1 GiB para SO/Docker y el
resto como margen. Son objetivos de observación, no límites ya configurados.

Antes de declarar capacidad suficiente: medir `docker stats`, memoria libre,
OOM/restarts, latencias, CPU y créditos de CPU bajo las cinco consultas; verificar
espacio después de descargar las tres imágenes y conservar una versión de rollback.
Si el margen resulta insuficiente se detiene y se presenta otra propuesta, sin
escalar automáticamente. Swap de bootstrap no demuestra capacidad disponible.
La [serie Basv2](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/basv2-series)
usa créditos de CPU: rendimiento sostenido pendiente de medir.

## Artefactos: bloqueo específico de verificación

Registro obligatorio: `ghcr.io/taller-sw-web/g6-productos-ofertas-backend`.

| Servicio | SHA/digest de release verificado |
|---|---|
| api-gateway | Pendiente |
| catalog-svc | Pendiente |
| taxonomy-svc | Pendiente |

La consulta de versiones de GitHub Packages devolvió 403 por falta de
`read:packages`; las consultas anónimas de GHCR devolvieron 401. No se puede
concluir que las imágenes no existan: **no se pudo acreditar una release oficial
accesible que incluya #195 ni obtener los tres digests**. No hay `release.psv` válido.

El CD observado de `58b94a6...` omitió publicación/despliegue. El nuevo flujo
`publish-only-images.yml`, integrado por #202, no registra ejecuciones en la consulta.
No se usaron imágenes del fork ni builds locales como releases.

## Propuesta de publicación controlada sin Oracle

Owner: **Marco (`mrcastilla8`)**. El workflow oficial exige ese actor y
`triggering_actor`; Axel no debe eludir la restricción ni ejecutar suplantando
otra cuenta. No usa SSH/Tailscale ni crea deployments; su único job construye y
publica/verifica un servicio en GHCR con permisos `packages:write`.

Fuente propuesta: `5114c2566175bc99a093c3db1068bf9512bb5d48`, que incluye #195
y tiene CI push/master satisfactoria. Marco debe validar los cambios posteriores
y autorizar ese SHA. Si master avanza, se requiere el nuevo SHA vigente con su CI;
el guard del flujo rechaza publicar un SHA obsoleto, incluso antes del push.

**Comandos propuestos para el operador autorizado; NO ejecutados en este preflight:**

```powershell
$releaseSha = '5114c2566175bc99a093c3db1068bf9512bb5d48'
gh workflow run publish-only-images.yml --repo Taller-SW-Web/G6-Productos-Ofertas-backend --ref master -f service=api-gateway -f sha=$releaseSha
gh workflow run publish-only-images.yml --repo Taller-SW-Web/G6-Productos-Ofertas-backend --ref master -f service=catalog-svc -f sha=$releaseSha
gh workflow run publish-only-images.yml --repo Taller-SW-Web/G6-Productos-Ofertas-backend --ref master -f service=taxonomy-svc -f sha=$releaseSha
```

No sobrescribe tags SHA existentes; verifica digest y etiquetas OCI de revisión
y servicio. Entrega requerida: tres enlaces de runs, SHA exacto, tres digests,
arquitectura Linux/amd64 y permiso de pull del operador Azure. Si las imágenes son
privadas, proporcionar acceso por mecanismo seguro, nunca tokens en el informe.
Solo después se prepara y revisa `release.psv` y se verifica el pull por digest.

## Gates y pruebas para la siguiente etapa

1. Resolver artefactos: owner Marco; condición: tres imágenes oficiales verificadas
   que incluyan #195 y sus digests accesibles desde el operador de Azure.
2. Aprobar costo/capacidad y aprovisionamiento de la propuesta concreta. El saldo
   se omite por instrucción del usuario; la aprobación de gasto sigue pendiente.
3. Configurar secretos de mínimo privilegio de Catalog/Taxonomy, CA Supabase y
   `verify-full`; validar DNS/IPv4/IPv6 y conexión real desde Azure. No migrar ni seedear
   la base compartida. Completar configuración G7 de rutas protegidas sin emisor local.
4. Desplegar solo tras autorización de recursos/artefactos. Docker Compose,
   `g6-edge`, `g6-http`, Caddy HTTPS y apps en loopback. Listas públicas vacías hasta
   aprobación normativa individual. No se requiere desplegar primero en Oracle.
5. Tras cada aprobación individual, probar sin JWT por HTTPS:

   - `GET /api/v1/categorias`
   - `GET /api/v1/marcas`
   - `GET /api/v1/productos?canal=MARKETPLACE`
   - `GET /api/v1/productos/{productoId}?canal=MARKETPLACE`
   - `GET /api/v1/productos/por-slug/{slug}?canal=MARKETPLACE` (**obligatorio**).

   Incluir inactivos, borradores, slug inexistente, escrituras anónimas, rutas
   administrativas y JWT inválidos. Registrar health/readiness, Catalog→Taxonomy,
   PostgreSQL real, recursos, SHA/digests y URL HTTPS. El resultado no existe aún.
6. Preparar ensayo de rollback por servicio con imágenes oficiales; ejecutarlo
   solo con autorización. La simulación y el smoke de solo lectura existentes no
   acreditan recuperación real en VM.

## Evidencia y límites

- `azure-prices-and-image-access-2026-11-05.json`: tarifas y estado de acceso GHCR,
  sin tokens, credenciales, ID completo de suscripción ni IP de administración.
- `azure-sku-capabilities-2026-11-05.json`: tamaños/arquitectura y restricciones
  devueltos por ARM. Inventario de VM de la suscripción: vacío al consultar.
- Comandos ejecutados: account/policies, cuotas, Resource SKUs API, tamaños,
  inventario de VM, Retail Prices, lectura GitHub/CI/workflow y probes GHCR.
- Sin pruebas sobre VM: aún no existe. Sin nuevas pruebas de código: no cambió
  la implementación ni los scripts. La CI de #196 es evidencia independiente.
