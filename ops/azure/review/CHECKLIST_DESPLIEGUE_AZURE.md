# Checklist de despliegue Azure

Una marca pendiente representa un gate real. Este documento no autoriza acciones
ni acredita un entorno desplegado.

## 1. Fuente y artefactos

- [x] #195 y #196 integradas; SHA oficial candidato `167090af6d4ae93adbde54b6741dd994d91bf70b`.
- [x] CI oficial del SHA: 18/18 jobs exitosos.
- [x] Publicaciones oficiales de Gateway, Taxonomy y Catalog satisfactorias.
- [x] Tres digests y verificaciones OCI acreditados por sus workflows;
      [evidencia](ARTEFACTOS_OFICIALES_167090a.md).
- [x] Copia privada de `release.psv` generada y cotejada con los workflows.
- [ ] Revisar/aprobar el conjunto de artefactos y el manifiesto privado.
- [ ] Resolver autenticación y permiso read de los tres paquetes para el operador.
- [ ] Lectura/pull por digest desde el operador: actualmente unauthorized.
- [ ] Confirmar RepoDigests, revisión OCI, servicio y Linux/amd64 de cada imagen.
- [ ] Confirmar que no se sustituyeron imágenes oficiales por builds del fork.

## 2. Autorización de recursos, antes de crear

- [ ] Aprobación expresa de costo y aprovisionamiento.
- [ ] Revalidar suscripción Azure for Students y región permitida Chile Central.
- [ ] Revalidar SKU explícito `Standard_B2als_v2`, 2 vCPU x64 y 4 GiB, restricciones
      y cuotas regionales/de familia; no fallback automático.
- [ ] Renovar cotización VM + disco Standard SSD LRS 30 GiB + IP Standard + red.
      Referencia histórica: base US$2.99/48 h o US$45.408/730 h, más extras.
- [ ] Preparar revisión privada `CostReviewPath` vigente (menos de 24 horas),
      coherente con el plan y presupuesto aprobado. Saldo omitido por instrucción
      del usuario, sin presumir gratuidad ni crédito restante.
- [ ] Revalidar CIDR administrativo /32 aceptado, clave pública y etiqueta DNS.
- [ ] Revisar comando con `-Location chilecentral -VmSize Standard_B2als_v2`
      explícitos; defaults históricos eastus/B1s no aplican.
- [ ] Solo entonces aprobar la ejecución de aprovisionamiento.

## 3. Host y dependencias, después de autorizar la VM

- [ ] Docker Engine/Compose, Caddy HTTPS, DNS y certificado público válidos.
- [ ] SSH/22 limitado al CIDR aprobado; 80/443 para usuarios desde cualquier red;
      aplicaciones 3000–3008 sin exposición pública directa.
- [ ] Redes `g6-edge` y `g6-http`, aliases y puertos loopback correctos.
- [ ] CA de Supabase de solo lectura, roles mínimos, `verify-full`, DNS y
      conectividad real al endpoint autorizado desde Azure.
- [ ] Completar secretos/runtime sin mostrarlos en evidencias ni Git.
- [ ] Verificar rol efectivo y conexión TLS de Catalog y Taxonomy; no usar
      superusuario. No ejecutar migraciones ni seeds compartidos.
- [ ] Configuración de autenticación y JWT para rutas protegidas; sin emisor
      simulado remoto. No inferir homologación o grants G7.
- [ ] Listas públicas vacías y bypasses heredados desactivados al inicio.
- [ ] Descargar las tres imágenes por digest desde Azure; ese resultado debe
      registrarse separadamente de cualquier prueba local de descarga.

## 4. Despliegue autorizado y capacidad

- [ ] Autorización de despliegue y manifiesto final revisado.
- [ ] Ejecutar en orden Taxonomy → Catalog → Gateway con imágenes oficiales.
- [ ] Docker healthy y health/readiness correctos para cada componente.
- [ ] Caddy accesible por HTTPS real, sin revelar endpoints administrativos.
- [ ] Medir memoria, CPU/créditos, espacio, OOM, reinicios y estado de contenedores;
      confirmar margen real de los 4 GiB. Swap no prueba capacidad suficiente.
- [ ] Comprobar PostgreSQL y comunicación HTTP Catalog → Taxonomy reales.
- [ ] Registrar SHA, digests, configuración no secreta y evidencias por ejecución.

## 5. Activación y evidencia final

- [ ] Aprobación normativa individual de cada operación, con enlace/owner/fecha.
- [ ] Configurar únicamente el subconjunto aprobado en las listas de cada servicio.
- [ ] Ejecutar los cinco GET y negativos del [plan HTTPS](PLAN_PRUEBAS_HTTPS_MARKETPLACE.md),
      incluida la consulta positiva por slug con producto real.
- [ ] Probar acceso desde una conexión externa: la restricción SSH no limita HTTPS.
- [ ] Registrar respuestas, negativas, correlación existente, DB, recursos y URL.
- [ ] Revisar y autorizar por separado el ensayo de rollback; documentar resultado
      real. La simulación existente no lo sustituye.
- [ ] Mantener #144 abierto mientras falten las validaciones restantes.

Estado actual: recursos, pull de operador/Azure, despliegue y activación pendientes.
