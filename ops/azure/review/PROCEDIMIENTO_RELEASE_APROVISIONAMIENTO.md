# Procedimiento preparado — Azure Fase 1

Estado: **preparación**, sin autorización de aprovisionamiento, despliegue o
activación pública. Backend #144 abierto. La PR #196 se integró mediante
`167090af6d4ae93adbde54b6741dd994d91bf70b`; su CI posterior pasó 18/18 jobs.
No es necesario un despliegue Oracle para ejecutar posteriormente este plan.

## Separar código oficial y repositorio de trabajo

`cueva` conserva infraestructura, evidencias y pruebas propias del fork; no se
construye desde ella una release oficial de Gateway, Catalog o Taxonomy. Existen
cambios oficiales posteriores a #195, incluida la corrección humana de Taxonomy
en #198 y los cambios de Combos en #197. Este procedimiento no los reimplementa.

La rama de #196 incorpora mediante merges normales el master oficial observado
`a9c19ded7f6ac6e7714cf8d84244a396bdec0559`, incluido el avance de #199 reportado
durante la actualización inicial a `5114c256...`. Su diff conserva exactamente los
14 archivos aprobados, sin cambios en `apps/` ni `ops/oracle/`. Los documentos y
la plantilla de este directorio se publican solo en `cueva`, fuera de esa PR.

Estado posterior: #196 ya está integrada en master. El árbol del merge
`167090af...` coincide exactamente con el HEAD aprobado `e0046124...`; el nuevo
SHA candidato para la publicación oficial es el merge, sujeto a aprobación de
Marco y a que siga siendo master vigente con CI push/master exitosa.

## 1. Publicación controlada: owner Marco

Usar exclusivamente el workflow oficial
[`publish-only-images.yml`](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/5114c2566175bc99a093c3db1068bf9512bb5d48/.github/workflows/publish-only-images.yml).
El guard restringe `actor` y `triggering_actor` a `mrcastilla8`; no se crea otro
publicador ni se modifica la restricción. No ejecutar estos comandos con la
cuenta de Axel para intentar eludirla. Solo se propone su ejecución autorizada.

Marco debe confirmar el SHA vigente y la CI exitosa exacta antes de ejecutar:

```powershell
$releaseSha = '167090af6d4ae93adbde54b6741dd994d91bf70b' # Propuesta; revalidar master y CI
gh workflow run publish-only-images.yml --repo Taller-SW-Web/G6-Productos-Ofertas-backend --ref master -f service=api-gateway -f sha=$releaseSha
gh workflow run publish-only-images.yml --repo Taller-SW-Web/G6-Productos-Ofertas-backend --ref master -f service=catalog-svc -f sha=$releaseSha
gh workflow run publish-only-images.yml --repo Taller-SW-Web/G6-Productos-Ofertas-backend --ref master -f service=taxonomy-svc -f sha=$releaseSha
```

El flujo publica/verifica imágenes oficiales con digest y etiquetas OCI; no
incluye SSH, Tailscale ni un job de despliegue Oracle. No sobrescribe tags SHA
existentes y comprueba otra vez la vigencia del SHA antes de publicar.

Entrega requerida por servicio: enlace al run exitoso, SHA oficial, referencia
`ghcr.io/taller-sw-web/g6-productos-ofertas-backend/<servicio>@sha256:<digest>`,
etiquetas `org.opencontainers.image.revision` y `title`, Linux/amd64 y acceso de
pull del operador Azure. Las credenciales privadas se entregan por mecanismo
seguro, no en Git, argumentos o logs.

## 2. Completar el manifiesto

La plantilla [release.psv](release.psv) contiene tres filas pendientes y se
rechaza por el ejecutor real antes del primer despliegue. No contiene digests
inventados ni se presenta como manifiesto válido.

Una vez entregadas y verificadas las tres imágenes, copiarla a una ruta privada
fuera de Git y sustituir los seis valores pendientes con la evidencia oficial.
Conservar orden Taxonomy → Catalog → Gateway. Registrar la aprobación de release,
verificar el pull por digest y confirmar que su SHA incluye #195 y las
correcciones oficiales seleccionadas. No construir en la VM ni desde `cueva`.

Estado acreditado en el preflight previo: GitHub Packages 403 por falta de
`read:packages`, GHCR anónimo 401; no hay tres digests verificados. Estos errores
no demuestran inexistencia de paquetes. La revisión actual de runs de publicación
se registra en el informe de actualización; no se ejecutó el publicador aquí.

## 3. Plan de recursos explícito, sin ejecución todavía

Suscripción: Azure for Students. Región `chilecentral`. SKU `Standard_B2als_v2`
(2 vCPU x64, 4 GiB RAM); Ubuntu 24.04, disco SO Standard SSD LRS 30 GiB (E4 de
32 GiB facturables), IPv4 pública Standard estática y nombre DNS disponible.
La IP administrativa /32 fue aceptada en el chat y permanece en el plan privado.
No se publica la IP ni el ID completo de suscripción en este documento.

Según las tarifas observadas en [el preflight](PREFLIGHT_2026-11-05.md), la base
es US$45.408/730 h, US$2.99/48 h o US$4.48/72 h, más operaciones de disco,
transferencia e impuestos. Saldo omitido por instrucción del usuario; autorización
de consumo pendiente. SKU/cuotas y revisión de costos deben renovarse antes de
crear. No prometer gratuidad ni capacidad garantizada; no hay fallback de SKU.

**Comando preparado solo para comprobaciones de lectura:**

```powershell
$subscriptionId = '<ID de tu suscripción Azure for Students>'
$adminCidr = '<IP/CIDR de administración aprobado>'
$sshPublicKeyPath = "$env:USERPROFILE\.ssh\g6_cueva.pub"
$dnsLabel = '<nombre DNS disponible y aprobado>'
pwsh ./ops/azure/provision-azure-vm.ps1 `
  -SubscriptionId $subscriptionId `
  -ResourceGroupName 'rg-g6-productos-azure' `
  -VmName 'vm-g6-backend' `
  -Location 'chilecentral' `
  -VmSize 'Standard_B2als_v2' `
  -AdminUsername 'azureuser' `
  -AdminSourceCidr $adminCidr `
  -SshPublicKeyPath $sshPublicKeyPath `
  -DnsLabel $dnsLabel `
  -DryRun
```

Nunca omitir región/SKU: los defaults históricos del script son eastus/B1s.
`DryRun` no autoriza gasto. Solo tras aprobación expresa, preparar un
`CostReviewPath` privado con revisión de menos de 24 horas y los mismos parámetros;
entonces se revisará la ejecución real. No se entrega un JSON de costos aprobado
ni se ejecuta la creación como parte de este procedimiento.

La propuesta de 4 GiB es para pruebas de baja concurrencia: medir consumo de los
tres procesos, Caddy, SO/Docker y margen real, así como créditos CPU, OOM y
reinicios. Swap no demuestra capacidad. No escalar automáticamente.

## 4. Preparación runtime y despliegue autorizado posterior

Después de autorizar recursos y artefactos: Docker Compose, Caddy HTTPS,
`g6-edge`, `g6-http`, aliases correctos, puertos de apps en loopback y CA de
Supabase montada de solo lectura. Roles de mínimo privilegio y PostgreSQL
`verify-full`; comprobar conectividad real desde Azure. No ejecutar migraciones,
seeds ni cambios sobre la base compartida.

Completar configuración G7 para mantener protegidas las operaciones privadas.
El emisor simulado sigue exclusivamente local; no se despliega. Listas públicas
vacías hasta aprobación normativa individual. No inferir grants u homologación
G7 del éxito de lecturas públicas.

## 5. Ensayo obligatorio tras las autorizaciones individuales

Probar por HTTPS real de Azure sin JWT cada operación aprobada:

| Operación | Caso obligatorio |
|---|---|
| `GET /api/v1/categorias` | Listado comercial real |
| `GET /api/v1/marcas` | Listado comercial real |
| `GET /api/v1/productos?canal=MARKETPLACE` | Elegibilidad y paginación comercial |
| `GET /api/v1/productos/{productoId}?canal=MARKETPLACE` | Producto activo elegible real |
| `GET /api/v1/productos/por-slug/{slug}?canal=MARKETPLACE` | **Obligatoria**, mismo producto accesible por slug |

Elegir datos existentes y autorizados, sin sembrar la base compartida. Registrar
status/body sin secretos. Negativos: producto inactivo, borrador, slug inexistente,
escritura anónima, rutas administrativas contractuales y JWT inválido. Comprobar
que ninguna operación adicional se abrió y que no hubo escrituras de negocio.

Evidencias finales: URL HTTPS, SHA y tres digests, health/readiness, cinco
respuestas, negativos, PostgreSQL real, Catalog→Taxonomy, `docker stats`, CPU,
memoria y estado/restarts. La evidencia de CI no acredita estos resultados remotos.

Rollback: preparar por servicio la imagen oficial previa fijada por digest.
Solicitar autorización del ensayo y documentar restauración y readiness. El
primer despliegue no tiene versión previa: retirar un contenedor fallido no
demuestra recuperación. Las pruebas simuladas existentes no equivalen al ensayo
real en Azure.
