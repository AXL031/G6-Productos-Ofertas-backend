# Azure alternativo: Gateway, Catalog y Taxonomy

La aplicación tiene una única implementación en `apps/`, válida para Oracle y Azure. Este directorio adapta infraestructura; no modifica `ops/oracle/`, los contratos ni la base compartida.

## Artefactos de release

Oracle y Azure deben consumir las imágenes oficiales aprobadas de `ghcr.io/taller-sw-web/g6-productos-ofertas-backend/<servicio>`. Azure despliega `@sha256:<digest>` y verifica `RepoDigests` y `org.opencontainers.image.revision` (etiqueta publicada por el CD oficial). Rechaza tags solos, imágenes del fork y cambios de registro por variable de entorno.

Después de revisión y publicación oficial, preparar `release.psv` con los mismos artefactos aprobados para Oracle:

```text
# Aprobación: enlace verificable a revisión/release.
taxonomy-svc|<SHA oficial de 40 caracteres>|sha256:<digest aprobado de 64 caracteres>
catalog-svc|<SHA oficial de 40 caracteres>|sha256:<digest aprobado de 64 caracteres>
api-gateway|<SHA oficial de 40 caracteres>|sha256:<digest aprobado de 64 caracteres>
```

El ejemplo contiene marcadores inválidos intencionadamente. El script valida el manifiesto completo antes del primer cambio; no verifica por sí mismo una aprobación humana.

```bash
# Solo después de autorización de release y configuración runtime completa:
sudo bash ops/azure/deploy-official-three.sh /ruta/privada/release.psv
```

Imágenes públicas: stdin vacío. Paquetes privados: usuario y token GHCR como dos líneas por stdin desde el mecanismo de secretos del operador, sin argumentos ni logs. El Docker config temporal privado se elimina al terminar.

`build-and-deploy-three.sh` conserva su nombre, pero ahora solo construye imágenes locales bajo `g6-local-development`. Exige HEAD coincidente y checkout limpio. No publica ni despliega y sus imágenes no son releases.

## Aprovisionamiento y costo pendiente

Cuotas y precios requieren evidencia fechada por suscripción; no se infieren del código. No se aprovisionaron recursos durante el trabajo. Antes de crear, comprobar oferta activa, antigüedad, crédito restante, región, SKU, cuotas regionales/de familia, disco, IP y transferencia. Un SKU disponible no demuestra gratuidad; swap no acredita capacidad para tres servicios. El build de release ocurre en CI.

```powershell
pwsh ./ops/azure/provision-azure-vm.ps1 -SubscriptionId '<id>' -Location '<región permitida>' -VmSize '<SKU cotizado>' -AdminSourceCidr '<IP o CIDR de administración>' -DryRun
```

`DryRun` consulta la suscripción exacta, SKU y cuotas sin crear recursos ni cambiar la suscripción predeterminada. No selecciona otro SKU automáticamente. Todos los comandos llevan `--subscription` explícito.

`-AdminSourceCidr` es obligatorio también en `DryRun`: acepta una IP IPv4/IPv6 o CIDR de administración, sin resolver automáticamente tu IP. Las IP individuales se normalizan a `/32` o `/128`; se rechazan origen vacío, comodines, etiquetas de servicio y acceso universal (`/0`). Solo SSH/22 usa ese origen; HTTP/80 y HTTPS/443 conservan acceso público. Repite el mismo parámetro al ejecutar un plan autorizado con `-CostReviewPath`.

Para crear exige además `-CostReviewPath`, JSON con revisión de menos de 24 horas. Campos obligatorios: `subscriptionId`, `location`, `vmSize`, `storageSku=StandardSSD_LRS`, `osDiskSizeGiB=30`, `reviewedAt` (UTC ISO), `reviewedBy`, `quoteUrl`, `offerVerified=true`, `monthlyUsd` y `budgetUsd` numéricos. Cotizar VM + disco + IP + red; total no negativo y dentro del presupuesto positivo aprobado. El archivo registra una revisión; no concede autorización arquitectónica.

Fuentes: [Azure for Students](https://azure.microsoft.com/en-us/free/students/), [discos](https://azure.microsoft.com/en-us/pricing/details/managed-disks/), [estados/facturación](https://learn.microsoft.com/en-us/azure/virtual-machines/states-billing). `az vm deallocate` detiene cómputo, pero discos/red pueden seguir cobrando. No identificar Standard SSD con promociones de otro SKU ni prometer costo cero.

## Host y runtime

Tras autorización de aprovisionamiento, instalar desde el checkout revisado:

```bash
sudo bash ops/azure/bootstrap-vm.sh --domain '<label>.<region>.cloudapp.azure.com' --ca-file /ruta/ca.crt
```

Conserva HTTPS/Caddy, `g6-edge` (Caddy/Gateway), `g6-http` (Gateway/servicios), aliases, puertos de aplicación en loopback y CA PostgreSQL de solo lectura. Bridge permite salida a dependencias; privada no significa `internal: true`. Completar variables JWT, roles y credenciales DB; si se usan mutaciones/filtros monetarios, también las credenciales técnicas de Catalog. Bootstrap no ejecuta migraciones ni seeds.

Default: `G6_SECURITY_MODE=G7_AUTHENTICATED`, listas vacías y flags legacy desactivados. `SIMULATED_AUTH` falla al arrancar mientras no esté homologado. El emisor local existente no se instala ni se publica. Configuración y reversión de las cinco consultas: [revisión de Fase 1](../../apps/api-gateway/PHASE1-REVIEW.md). No activar acceso público antes de revisión y autorización individual.

## Gates, recuperación y evidencia

El ejecutor conserva `flock`, validación de miembros/aliases de `g6-http`, secretos temporales y estado por servicio. Exige Docker healthy y liveness. Catalog y Taxonomy también requieren JSON de readiness con servicio/estado correctos; Gateway usa el bundle de readiness de su Compose oficial.

Ante fallo restaura el digest anterior y verifica salud/readiness. Un primer arranque fallido retira solo el contenedor recién creado. La recuperación es por servicio, no una transacción distribuida de los tres despliegues. Una instancia anterior basada en tags requiere un plan revisado de transición: el ejecutor rechaza actualizarla sin referencia anterior fijada por digest.

```bash
node --test ops/azure/tests/*.test.mjs
pwsh ./ops/azure/tests/provision.test.ps1
sudo bash ops/azure/test-rollback-and-phases.sh
```

Las pruebas Node del ejecutor simulan Docker/HTTP y comprueban intento de nueva imagen, restauración del estado simulado, fallo de readiness, digest/revisión incorrectos y primer despliegue. No acreditan rollback en VM. El smoke de VM es de solo lectura; no construye ni despliega una imagen rota.

Docker/Compose real, pull del registro oficial, TLS público, rollback de VM, CI del SHA y cuota/costo reales requieren evidencia independiente antes de `READY_FOR_DEPLOY`.
