# Migración Azure Container Apps — corte 2026-11-06

Estado al retomar: nueve imágenes oficiales publicadas y verificadas; entorno ACA en aprovisionamiento. Las pruebas HTTPS siguen pendientes.
Rama de trabajo `cueva`, fuente oficial incorporada mediante merge normal
`4f0acd5156b775a06d2b9502b86e1c176d957aec`, desde integración oficial
`bff05f8f856031807786cf10a501c5a45af07928`.

## Excepción temporal de lecturas

El usuario comunicó autorización del líder técnico para las 66 candidatas,
incluidas lecturas administrativas e internas con datos académicos sintéticos.
Se implementa su excepción expresa; este registro no afirma una decisión normativa
publicada ni una homologación externa. No se modifica `ops/oracle/`.

`phase1-operations.json` conserva las 66 candidatas y su estado. Se seleccionan
59 GET y seis POST; la selección permanece vacía por defecto en runtime.
`phase1-selection.env.example` contiene los IDs exactos por componente, para
incorporar a configuraciones privadas. No sustituye los archivos completos de runtime.
Cambiar a SIMULATED_AUTH/G7_AUTHENTICATED requiere retirar las listas públicas.
Las escrituras conservan JWT. Un Authorization recibido se valida, nunca se
convierte en acceso anónimo por fallar. No se fabrica actor desde IP ni cabeceras.
La visibilidad comercial de Catalog conserva sus filtros: abrir acceso no publica borradores.

### Auditoría de los siete POST

| Operación                     | Decisión y evidencia de código                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| consultarDatosFisicos         | Incluida. Catalog consulta SKUs y proyecta datos físicos; no modifica productos.                       |
| resolverCodigoBarras          | Incluida. Catalog resuelve código mediante consulta al repositorio.                                    |
| resolverSlugCategoriaCreacion | Incluida. Taxonomy propone un slug leyendo SEO e historial; no reserva ni crea categoría.              |
| evaluarPromociones            | Incluida. Evaluación y consultas HTTP a dependencias; no consume cupón ni publica comandos de consumo. |
| validarCupon                  | Incluida. Valida condiciones; no ejecuta consumo/redención.                                            |
| verificarCantidadComercial    | Incluida. Inventory calcula disponibilidad no vinculante; no reserva ni mueve stock.                   |
| prevalidarImportacionPrecios  | Excluida del corte. No existe handler multipart productivo. No se inventa un resultado positivo.       |

La auditoría anterior es estática. Las pruebas HTTP de transporte no demuestran
ausencia de cambios en las bases de todos los servicios: falta certificación funcional
por operación con fixtures y snapshots aislados. GET de archivos requiere un archivo
real ya existente; no se crean trabajos o imports para simular que la descarga funciona.
Se agregó el GET contractual de reporte CSV de Pricing usando resultados persistidos
de `PricingReads.imported`, sin exponer URI privada ni generar un trabajo.

## Seguridad de fases 2 y 3

Se conservan los verificadores existentes de los nueve componentes. Se completa
JWKS remoto en Bulk e Inventory, aislamiento de issuer simulado, selección de
credenciales M2M simuladas en Combos y validaciones temporales adicionales.
Las claves, scopes, audiencia de servicio y clientes autorizados siguen siendo
requisitos por operación. Los tokens humanos no requieren una audiencia inventada.
Gateway conserva introspección G7 para las rutas contractualmente sensibles,
con `tokens:introspeccion`, audiencia `api-seguridad`, timeout y cierre ante fallos.

`../demo-jwt-issuer.mjs` es exclusivamente local. Sus firmas verifican mecanismos,
no acceso al G7 real. No se desplegará el emisor en Azure. G7 real requiere que su
owner entregue issuer/JWKS y grants verificables; no se declara homologado.

## Preflight ACA y costo

Suscripción Azure for Students `fef42188-accd-4470-ae88-78f583eb4906`, Chile Central.
Microsoft.App está registrado; consulta regional informa 0/1 Managed Environments.
Esto no prueba disponibilidad efectiva ni cuota Consumption por entorno.
Las ocho conexiones PostgreSQL pasaron verificación TLS y lectura de metadatos;
no equivalen a readiness de las ocho aplicaciones ni certificación completa de privilegios.
No se ejecutaron migraciones ni seeds en la base compartida.

Propuesta inicial: mismo entorno Consumption, Gateway con entrada pública HTTPS,
ocho servicios con ingress interno. Caddy como sidecar del Gateway si se conservan
sus límites y filtros actuales. No se trasladan literalmente redes Docker `g6-edge`
y `g6-http`: se reproduce su aislamiento con ingress público/interno de ACA.
TLS PostgreSQL conserva CA y verificación del hostname. Variables y credenciales
van en secretos runtime por servicio, fuera de Git.

Presupuesto preliminar: 9 procesos Node más Caddy, cada uno 0.25 vCPU/0.5 GiB:
2.5 vCPU y 5 GiB en total. Los nueve procesos deben probarse con carga antes de
aceptar ese dimensionamiento. A precios retail consultados para Chile Central:
CPU activa 0.000034 USD/vCPU-s, inactiva 0.000004; memoria 0.000004 USD/GiB-s;
0.40 USD/millón de solicitudes. 730 horas totalmente activas: 275.94 USD/mes de
cómputo; totalmente inactivas con mínimo uno: 78.84 USD/mes, antes de franquicias.
No incluye logs, almacenamiento, red ni impuestos; el saldo estudiantil no se verificó.
Escalar a cero reduce cómputo, pero hay que definir trabajadores AMQP, Outbox,
polling y almacenamiento antes de prometer suspensión automática de todos.

## Condiciones del preflight original (corte histórico)

1. Integrar/revisar este nuevo código y obtener CI del SHA final. La CI verde del
   SHA oficial anterior no certifica los nuevos cambios.
2. Publicador oficial: publicar los nueve artefactos del mismo SHA aprobado. En el
   preflight las nueve etiquetas `bff05f8...` devolvieron 404. El workflow oficial
   publish-only actual solo admite tres servicios/master y la cuenta autorizada;
   no se sustituye por imágenes del fork ni se elude ese control.
3. Completar copia privada de `release.psv.example`: SHA, tres/nueve digests reales,
   URLs de workflows, labels OCI, plataforma Linux/amd64 y lectura GHCR comprobada.
   Para migrar todos, se necesitan los nueve digests.
4. Confirmar cuota y configuración/costo efectivo de ACA. Crear entorno y apps solo
   cuando los artefactos y runtime sean desplegables; no crear recursos vacíos de prueba.
5. RabbitMQ y Storage de Bulk permanecen diferidos por instrucción del usuario.
   Su ausencia bloquea las operaciones/trabajadores dependientes; no toda lectura HTTP.
   Promotions permite modo HTTP de Fase 1 sin broker solo con probes/coupon runtime
   deshabilitados explícitamente. Bulk readiness depende de AMQP y puede devolver 503.
6. Price Audit necesita un volumen persistente para archivos si se usa su exportador.
   Promotions no publica una ruta HTTP de readiness; Gateway tiene verificador CLI.
   ACA no ejecuta probes exec: no usar liveness como prueba de disponibilidad funcional.
7. Revisar configuración de cada worker y límites de pool. Inicialmente máximo una
   réplica por servicio, hasta comprobar concurrencia, conexiones y jobs duplicados.

## Pruebas de aceptación y cambio de tráfico

- Arranque/health y readiness con sus dependencias reales, logs sin secretos,
  PostgreSQL TLS y comunicaciones Catalog→Taxonomy, Pricing→Catalog y demás llamadas.
- Ejecutar las 65 seleccionadas con parámetros y fixtures reales, seis POST incluidos.
  Registrar por operación respuesta, efecto observado, SHA y digest. Ausencia de datos
  o archivos se registra como pendiente/404 contractual, no como positivo inventado.
- Marketplace: cinco GET comerciales, obligatorio producto por slug y producto real
  publicado. Inactivos, borradores y slug inexistente deben conservar su visibilidad.
- JWT inválido, escrituras anónimas, token de otro issuer, rol/scope/client/aud incorrectos,
  expirados, alterados y caída de JWKS/introspección. En Fase 3 ninguna selección anónima.
- Tomar métricas CPU/memoria, conexiones y cold starts antes de elegir minReplicas=0.
- Rollback por revisión anterior y digests oficiales; detener cambio de tráfico si falla
  readiness. No describir ensayos simulados como recuperación real de Azure.
- Validar nueva URL HTTPS de ACA antes de comunicarla o retirar la VM. El apagado de VM
  para 06/11 a las 13:00 Lima fue revocado; requiere confirmación de migración completa.

Fuentes de plataforma: [comunicación interna](https://learn.microsoft.com/en-us/azure/container-apps/connect-apps),
[escalado](https://learn.microsoft.com/en-us/azure/container-apps/scale-app),
[probes](https://learn.microsoft.com/en-us/azure/container-apps/health-probes),
[facturación](https://learn.microsoft.com/en-us/azure/container-apps/billing),
[volúmenes](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts).

## Release oficial y ejecución ACA

La aplicación común quedó integrada mediante Backend #211 en
`3f685dbcb616daad3414039059396823a0a0a9a2`, con CI posterior 19/19 satisfactoria.
Backend #210 habilitó el publicador oficial para AXL031 y los nueve componentes.
`official-release-3f685dbcb6.json` registra los nueve workflows satisfactorios,
los digests obtenidos de GHCR, hashes de manifiestos/configs, labels de origen,
revisión/servicio y plataforma linux/amd64. Son imágenes del Backend oficial.

`render-deployment.mjs` transforma el manifiesto de nueve filas y los archivos
privados de runtime en plantilla ARM y parámetros seguros. No publica imágenes,
no crea recursos por sí solo y no imprime credenciales. La opción
`--enable-public-reads` es obligatoria para activar exactamente las 65 seleccionadas.
No admite SIMULATED_AUTH en cloud. G7 debe configurarse y validarse con sus parsers
reales antes de cambiar a G7_AUTHENTICATED; el generador no homologa G7.

Ejecutar desde una carpeta privada fuera de Git, con G6_GHCR_PULL_TOKEN cargado
sin imprimirlo:

```powershell
node ops/azure/container-apps/render-deployment.mjs `
  --release <release.psv-privado> --runtime <directorio-runtime-privado> `
  --ca <CA-Supabase> --registry-user AXL031 `
  --caddy-image caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9 `
  --out <directorio-privado> --enable-public-reads
node --test ops/azure/container-apps/render-deployment.test.mjs
```

La plantilla fija Chile Central, environmentMode WorkloadProfiles explícito
(API 2026-07-01), solamente el perfil Consumption, cero a una réplica por app,
Gateway público con Caddy sidecar y ocho ingress internos HTTPS. PostgreSQL
conserva verify-full y CA montada por Secret volume. La configuración y las
credenciales se pasan mediante secureObject/secureString y secretos por app.
No hay migraciones, seeds, publicador alternativo ni emisor simulado desplegado.

El primer intento creó un entorno Express y Azure rechazó los Secret volumes.
Se corrigió la selección explícita y la plantilla revisada pasó la validación
Azure. Express no admite sidecars ni esos volúmenes; esta aplicación necesita
WorkloadProfiles con Consumption. El cambio de modo se procesa como operación
asíncrona; esperar Succeeded antes de desplegar. No sustituirlo por Dedicated.

Después del render, ejecutar validate y what-if con ResourceIdOnly, revisar que
solo afecten al grupo rg-g6-aca-chile y desplegar en modo Incremental. No imprimir
los parámetros privados ni el contenido de los secretos. Las probes de transporte
no certifican readiness de negocio: comprobar cada dependencia por separado.
RabbitMQ y Bulk Storage siguen diferidos. Price Audit no habilita un exportador
sin almacenamiento persistente. No presentar sus descargas como disponibles.

La VM anterior permanece encendida por instrucción del usuario: el apagado de
06/11 a las 13:00 fue revocado. Apagarla únicamente tras confirmarse la migración.

Fuentes: [limitaciones Express](https://learn.microsoft.com/en-us/azure/container-apps/express-overview),
[modo del entorno](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/2026-07-01/managedenvironments),
[restauración del entorno](https://learn.microsoft.com/es-es/azure/container-apps/faq).
