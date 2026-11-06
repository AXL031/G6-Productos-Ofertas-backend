# Azure desplegado — consultas públicas desactivadas

URL base real:
**https://g6-po-axl031-167090a.chilecentral.cloudapp.azure.com**.
[Health público](https://g6-po-axl031-167090a.chilecentral.cloudapp.azure.com/health):
HTTP 200 con certificado público válido. HTTP redirige a HTTPS con 308.

Se ejecutó el aprovisionamiento y despliegue tras la autorización expresa del
usuario en el chat. No se recibió autorización individual para abrir las cinco
consultas: permanecen cerradas. No se desplegó un emisor JWT simulado.

## Aplicación y topología

SHA oficial común: `167090af6d4ae93adbde54b6741dd994d91bf70b`.
El kit de operación se obtuvo mediante `git archive` del commit oficial exacto;
no se construyeron imágenes desde `cueva` ni en la VM.

| Servicio | Digest oficial activo | Estado |
|---|---|---|
| Taxonomy | `sha256:1ccf97dbb238f870330266f7ae4d7a5a5ddf16b5927a1f7f2f3d9f25ce5caa94` | running, healthy, 0 reinicios |
| Catalog | `sha256:16c9d940be74e1b67ef010099ca8b563eb765eba2e27aa3ea5672bb9d7e89e20` | running, healthy, 0 reinicios |
| Gateway | `sha256:de3d0f11ed5fbeb76c42745d17e5e5926805783bb20f74cdd1e3d0c7c1a12ca0` | running, healthy, 0 reinicios |

Se verificó acceso GHCR autenticado y pull por digest primero desde el operador y
después desde Azure. Se cotejaron RepoDigests, revisión OCI, nombre y Linux/amd64.
Credenciales GHCR transmitidas por stdin sobre SSH, con Docker config temporal
privado eliminado por el ejecutor; no se publicaron tokens.

Caddy: `caddy:2.11.6-alpine`, digest observado
`sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9`.
`g6-edge` contiene solo Caddy/Gateway; `g6-http` contiene los tres servicios.
Los puertos 3000, 3001 y 3006 están en loopback y resultaron inaccesibles desde
la conexión externa; NSG permite 80/443 y restringe SSH/22 al CIDR autorizado.
La identidad SSH del host se obtuvo por el canal autenticado de Azure antes de
transferir runtime. La clave privada original cifrada no se expuso; se instaló
una clave de operación dedicada, privada y fuera de Git, para el mismo usuario.

VM `Standard_B2als_v2`, Chile Central, 2 vCPU x64/4 GiB, Ubuntu 24.04,
disco Standard SSD LRS 30 GiB e IP Standard estática. El registro inicial de
Microsoft.Network requirió espera. Se sustituyó únicamente la consulta global de
SKU que quedó esperando por una consulta ARM real filtrada por región en un
adaptador operativo privado; el script oficial conservó sus gates de restricciones,
cuotas, suscripción explícita, costos y origen SSH. No se editaron scripts aprobados.

## Health, readiness y persistencia reales

- `/health` de los tres servicios: 200, `status=ok`.
- Taxonomy y Catalog `/health/ready`: 200, `status=ready`.
- Bundle Gateway: `status=ready`, Catalog/Taxonomy `ready`, cobertura **partial**;
  los demás seis servicios no se desplegaron ni se declaran listos.
- Conexión real desde cada contenedor a Supabase con roles limitados
  `taxonomy_dev_login` y `catalog_dev_login`, modo session, CA oficial,
  hostname/SNI validado y `rejectUnauthorized=true`/`verify-full`.
- Pruebas SQL auxiliares en transacciones READ ONLY: rol efectivo, metadatos TLS
  y lectura mínima de las tablas de readiness. Sin migraciones ni seeds compartidos.
- La CA se obtuvo del enlace HTTPS que usa el código oficial del panel Supabase;
  huella SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.
- `pg_stat_ssl` reportó `false` para el enlace **interno pooler→PostgreSQL**.
  Esto se registra por separado: no invalida el TLS validado cliente→pooler ni
  acredita cifrado extremo a extremo de ese tramo interno del proveedor.
- Una solicitud desde el contenedor Catalog a readiness HTTP de Taxonomy devolvió
  200. Prueba la conectividad de red/HTTP; el enriquecimiento comercial de un
  producto por ID/slug sigue pendiente de activación pública o G7 real.

## Resultado HTTPS y límite de autenticación

Los tres runtime usan `G6_SECURITY_MODE=G7_AUTHENTICATED`, listas públicas vacías
y flags legacy desactivados. El usuario proporcionó PostgreSQL pero no las URLs
reales issuer/discovery/JWKS de G7. No se fabricó esa configuración.

| Caso HTTPS externo | Resultado real |
|---|---|
| GET `/health` | 200 |
| GET `/api/v1/categorias` sin JWT | 401 |
| GET `/api/v1/marcas` sin JWT | 401 |
| GET `/api/v1/productos?canal=MARKETPLACE` sin JWT | 401 |
| GET `/api/v1/productos/{id}?canal=MARKETPLACE` sin JWT | 401 |
| GET `/api/v1/productos/por-slug/{slug}?canal=MARKETPLACE` sin JWT | 401 |
| POST `/api/v1/productos` anónimo | 401; no mutación aceptada |
| GET detalle privado de categoría anónimo | 401 |
| Authorization con JWT inválido suministrado | **503**, autenticación G7 sin configurar; no fallback anónimo |

Los ID/slug del ensayo anterior solo prueban la frontera de autenticación: no se
declaran consultas positivas de productos reales ni pruebas de visibilidad.
El 503 con JWT es cierre por falta de configuración, **no** un rechazo JWT 401
homologado. No hay integración autenticada G7 funcional acreditada.

Pendiente: aprobación normativa individual de las cinco lecturas y configuración
exacta de sus listas. Después ejecutar el
[plan HTTPS](PLAN_PRUEBAS_HTTPS_MARKETPLACE.md) con producto real activo por ID y
**slug**, inactivos/borradores, inexistentes y negativos de autorización. No se
hicieron esas pruebas comerciales antes de recibir la autorización.

## Recursos y costo

Captura de baja actividad, no benchmark bajo carga: Gateway 31.81 MiB,
Catalog 40.2 MiB, Taxonomy 40.37 MiB y Caddy 12.88 MiB, CPU 0% en esa muestra.
Host: 3906 MiB totales, 3107 MiB disponibles; swap 0/2047 MiB; disco raíz 5.2/29 GiB.
No hubo reinicios en la captura. La capacidad bajo carga y créditos CPU siguen
pendientes de medir; esta captura no demuestra capacidad para concurrencia elevada.

Costo base del plan autorizado: US$45.408/730 h, más operaciones de disco,
transferencia e impuestos; referencia de tarifa, no gasto efectivo facturado.
La VM está encendida y genera consumo. El saldo fue omitido por instrucción del
usuario, sin asumir beneficios gratuitos ni crédito restante.

## Rollback y evidencia

El ejecutor conserva la recuperación por servicio y el manifiesto privado fijo.
Es el primer despliegue: no existe versión oficial anterior propia de esta VM
que restaurar. No se inyectaron fallos ni se acredita un ensayo real de rollback.
Para ensayarlo se requiere revisar una versión anterior aprobada y autorizar el
ensayo; no presentar el smoke de solo lectura ni la simulación como recuperación.

Evidencia no secreta:
[AZURE_DESPLEGADO_167090a.json](AZURE_DESPLEGADO_167090a.json), con respuestas HTTP,
TLS, imágenes activas, estado, recursos y límites. Los runtime, contraseñas,
manifiesto operativo y claves están fuera de Git. Runtime remoto `0640 root:root`;
se eliminaron las copias temporales de secretos subidas al directorio de operación.

Estado: **despliegue operativo y saludable; aceptación pública/G7 parcial**.
Backend #144 permanece abierto.
