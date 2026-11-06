# Migración Azure Container Apps — corte 2026-11-06

Estado: preparación y pruebas locales; sin entorno ACA creado ni nueva versión desplegada.
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

| Operación | Decisión y evidencia de código |
|---|---|
| consultarDatosFisicos | Incluida. Catalog consulta SKUs y proyecta datos físicos; no modifica productos. |
| resolverCodigoBarras | Incluida. Catalog resuelve código mediante consulta al repositorio. |
| resolverSlugCategoriaCreacion | Incluida. Taxonomy propone un slug leyendo SEO e historial; no reserva ni crea categoría. |
| evaluarPromociones | Incluida. Evaluación y consultas HTTP a dependencias; no consume cupón ni publica comandos de consumo. |
| validarCupon | Incluida. Valida condiciones; no ejecuta consumo/redención. |
| verificarCantidadComercial | Incluida. Inventory calcula disponibilidad no vinculante; no reserva ni mueve stock. |
| prevalidarImportacionPrecios | Excluida del corte. No existe handler multipart productivo. No se inventa un resultado positivo. |

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

## Condiciones concretas antes de crear recursos

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
  ya programado para 06/11 a las 13:00 Lima no se cancela por esta preparación.

Fuentes de plataforma: [comunicación interna](https://learn.microsoft.com/en-us/azure/container-apps/connect-apps),
[escalado](https://learn.microsoft.com/en-us/azure/container-apps/scale-app),
[probes](https://learn.microsoft.com/en-us/azure/container-apps/health-probes),
[facturación](https://learn.microsoft.com/en-us/azure/container-apps/billing),
[volúmenes](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts).
