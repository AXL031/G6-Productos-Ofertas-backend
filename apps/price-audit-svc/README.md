# Price Audit — implementación y evidencia local

> Actualizacion de esta entrega: [resolucion H4 y dependencias por issue](H4-RESOLUCION.md).
> El decoder tipado sustituye P-AUD-02; el contenido inferior conserva su corte historico.

Owner Leonardo Vera; rama `vera`; corte 2026-10-23. Implementación interna y
pruebas locales no acreditan despliegue Oracle, homologación ni grants G7.
El cierre integral de #63/#65/#66 y la integración #68/#69 siguen parciales.

## Fuentes verificadas

Docs oficial `master@1ee0d9e5a788dbe559a376bf96a60c6117af3956`, segunda fuente
local de solo lectura: SPEC/HU/FLOW-014-historial-auditoria-precios;
`contratos/http/{openapi.yaml,catalogo-errores.md,kit-integracion.md}`;
`contratos/eventos/asyncapi.yaml`; `datos/price_audit/physical-model.md` y su
migración; registro DEC-F-001/006/009/012, solo en su alcance aplicable.
Contratos candidatos HTTP 0.6.0-rc.1 y eventos 0.6.0-rc.2, no runtime homologado.

Backend: AGENTS.md; `ops/oracle/GUIA_DEVTEAM.md`, CONTRATO_DESPLIEGUE.md,
MATRIZ_DEPENDENCIAS.md, RABBITMQ_COMPATIBILIDAD.md, CHECKLIST_PREDEPLOY.md y
fichas de ambos servicios. Los informes operativos heredados conservan su corte
histórico; no se convierten en evidencia del código nuevo.

## Configuración

Node compatible con package.json (pruebas: 24.19.0); `npm ci`,
`npm run build:price-audit-svc`, `npm run start:price-audit-svc`.
Se carga `.env` si existe; no registrar sus valores.

| Variable | Comportamiento |
|---|---|
| `NODE_ENV` | development, test o production explícito |
| `PRICE_AUDIT_SVC_PORT` / `PORT` | entero 1–65535; específico tiene prioridad |
| `DATABASE_URL` | schema propio price_audit; sin DDL en arranque |
| `PGSSLMODE`, `PGSSLROOTCERT` | verify-full fuera de loopback no productivo; CA validada; sin desactivar TLS |
| `AUTH_ISSUER`, `AUTH_JWKS_URL` | obligatorios HTTPS; HTTP solo loopback de tests |
| `PRICE_AUDIT_AMQP_URL` | opcional; AMQPS salvo loopback dev/test, heartbeat 5 s; sin parámetros arbitrarios |
| `AUDIT_EXPORT_DIRECTORY` | ruta absoluta privada persistente, habilita CSV; sin ella POST devuelve 503 sin crear job |
| `AUDIT_EXPORT_FONT` | fuente TTF/OTF absoluta legible/licenciada, necesaria para PDF; cubrir caracteres del dataset |
| `AUDIT_HOT_RETENTION_MONTHS` | entero positivo, defecto 24; no activa purga |
| `AUDIT_ARCHIVE_RETENTION_YEARS` | entero positivo, defecto 5; no activa archivador |

Exportaciones requieren volumen privado administrado por despliegue. Un volumen
efímero pierde archivos al reemplazar el contenedor. Réplicas requieren el mismo
volumen con rename atómico o un adapter de storage aprobado; no hay object store
implícito. Archivos nuevos modo 0600, directorio nuevo 0700; el operador mantiene
ACL equivalentes en Windows/directorios existentes. Fuente bajo test/fixtures/font
solo para pruebas, con licencia OFL y procedencia incluidas.

`/health` y `/health/live`: proceso. `/health/ready`: SELECT real de log/Inbox/jobs,
storage configurado y consumidor si se activa AMQP. No exige permisos del
archivador sobre manifests. Readiness no acredita grants ni recorrido comercial.

## HTTP y exportación

Prefijo `/api/v1/auditoria-precios`. JWT humano RS256/JWKS, tipo acceso vigente,
sub UUID, rol GESTOR_COMERCIAL. Sin bypass demo, scopes nuevos ni token de
servicio. Solicitante de exportación desde JWT verificado, nunca desde body.

| operationId | Método/ruta relativa | Implementación |
|---|---|---|
| listarAuditoriaPrecios | GET / | filtros publicados, página base 1, tamaño 20/máx. 200, timestamp/id descendente |
| obtenerAuditoriaPrecio | GET /{auditId} | detalle o 404 contractual |
| crearExportacionAuditoriaPrecios | POST /exportaciones | 202 QUEUED solo con worker compatible; conteo antes de INSERT |
| obtenerExportacionAuditoriaPrecios | GET /exportaciones/{exportId} | estado persistido, sin rutas privadas |
| descargarExportacionAuditoriaPrecios | GET /exportaciones/{exportId}/archivo | solo COMPLETED y archivo real, MIME/disposición contractual y mismo rol |

CSV hasta 100 000 filas, PDF hasta 500, límites inclusivos. Exceso al admitir:
422 LIMITE_EXPORTACION_AUDITORIA_EXCEDIDO sin job. Worker revalida bajo una
instantánea repeatable-read; exceso posterior/fallo termina FAILED_GENERAL,
nunca truncado ni COMPLETED ficticio. Límite técnico adicional de 32 MiB de
datos/archivo protege memoria y produce FAILED_GENERAL. Lock/skip-locked evita
procesar dos veces el mismo job simultáneamente; QUEUED/PROCESSING se recuperan
al reiniciar. Temporal + rename preceden al commit COMPLETED; archivo huérfano
tras rollback no es descargable por HTTP.

CSV escapa separadores/comillas y neutraliza fórmulas en texto; conserva
variaciones negativas numéricas. PDFKit genera PDF real con fuente explícita,
ajuste de texto y paginación. Cero no se sustituye por null; null anterior se
presenta “Sin precio anterior”, null nuevo “Sin oferta”, variación null “No
aplicable”. No se inventa moneda (P-AUD-01). download_url es null: se usa la ruta
de descarga autenticada, no una URI privada ni URL relativa inventada.

## Persistencia y eventos

Drizzle mapea las cuatro tablas normativas, PK/FK/checks/índices. Runtime no puede
actualizar/borrar/truncar bitácora ni leer schemas ajenos. No hay CRUD de asientos.
Inbox y todos los asientos se confirman juntos; duplicado concurrente no duplica
filas. Sin migraciones históricas alteradas ni SQL sobre Supabase compartido.

Consumidor comprueba po.auditoria-precios.q, prefetch 20, ACK manual tras commit.
No declara recursos ni modifica ACL del broker. Fallo técnico: NACK/requeue y
reconexión 250 ms–5 s. Mensaje incompatible: retenido, pausa y readiness 503;
requiere corrección/disposición y reinicio. Sin DLQ/descarte automático inventado.

P-AUD-02: GenericData no publica decoder/cálculo/precisión aprobados de variación.
AUDIT_PRICE_CHANGE_DECODER no tiene implementación productiva por defecto.
Activar AMQP sin ella falla cerrado; HTTP/DB/exportación independientes funcionan
sin AMQP. Tests inyectan decoder de fixture, sin acreditar evento comercial real.
UUID de message/correlation es exigencia del modelo físico, más estricta que el
string genérico de AsyncAPI; el emisor debe acordarlo.

P-AUD-03: se valida precondición de manifiesto recuperable/verificado; no hay
purga/scheduler/archivo frío sin formato y storage aprobados. P-AUD-04: roles y
grants compartidos se verifican aparte, no se ejecutan desde este servicio.

## Trazabilidad de issues

| Issue | Resultado y pendiente |
|---|---|
| #61 | Configuración cerrada, bootstrap seguro, probes y build probados. CI del SHA en PR; sin deploy atribuido. |
| #62 | Schema propio, ACL append-only, dedupe y rollback SQL probados contra migración normativa intacta. |
| #63 | Invariantes monetarias/null, límites y protección de originales probados; mapping/variación y archivo frío pendientes P-AUD-02/03. |
| #64 | Lecturas/descargas contractuales con DB aislada y JWT, filtros, paginación, vacío, validación, 401/403/404. |
| #65 | ABIERTO / IMPLEMENTADO_PARCIAL. Persistencia transaccional, pruebas aisladas y exportaciones CSV/PDF implementadas. Falta consumir cambios reales de Pricing mediante decoder productivo aprobado, sujeto a P-AUD-02; AUDIT_PRICE_CHANGE_DECODER permanece null. Las fixtures no acreditan consumo productivo. PR #139 solo referencia este issue, sin cierre automático. |
| #66 | Inbox/ACK/dedupe/reconexión con broker real y decoder de fixture; mapping productivo y homologación pendientes. |
| #67 | Timeouts DB/JWKS/AMQP, readiness y logs sanitizados probados; sin diagnóstico productivo atribuido. |
| #68 | Provider preparado; falta React→Gateway con Frontend #45 / Backend #21. No se modificó frontend ni Gateway. |
| #69 | Broker→Inbox/log→HTTP y exportación probados por segmentos; falta evento homologado y recorrido con Gateway/UI/identidad reales. |

| Owner responsable | Frontera | Condición verificable |
|---|---|---|
| Vera + Marco + consumidores | P-PRI-02/P-AUD-02 | mapping compatible y precisión/metadatos publicados antes de conectar factory/decoder productivos |
| Marco / coordinación G5 | AMQP #29/#110 | nombres/routing/ACL/red y retry/DLX aprobados, conexión productiva verificada |
| Vera + Marco | archivo frío P-AUD-03 | formato/storage/recuperabilidad y procedimiento aprobados antes de borrar originales |
| Marco / administración DB | P-AUD-04 | roles mínimos reales verificados; sin grants/migraciones compartidos en esta entrega |
| Marco/Gateway + Vera/frontend + G7 | #68/#69 | composición/rutas comunes, token/grant real y prueba visible con SHAs y sin fallback mock |
| Marco / release | Oracle #111 | aprobación y evidencia por digest/SHA; pruebas locales no autorizan deploy |

## Pruebas reproducibles

Node 24.19.0, Docker Desktop, instancias por suite en puertos aleatorios loopback.
No reciben DATABASE_URL externa ni escriben Supabase.
Fixture SQL SHA-256: 7d890955717025572da03d258168d81e9b7fa38c797f1b697527f0d4cab89afc.
PostgreSQL: postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea.
RabbitMQ: rabbitmq:4.2-alpine@sha256:63bf2b61c7ddd5ab746d1d964f33beb1b4a2c06df79505d55251aae5f8077884.

```powershell
npm test
$env:PRICING_TEST_POSTGRES='1'
$env:PRICING_TEST_AMQP='1'
$env:PRICE_AUDIT_TEST_POSTGRES='1'
$env:PRICE_AUDIT_TEST_AMQP='1'
npm run test:e2e
npm run typecheck
npm run lint
npm run format:check
npm run build:pricing-svc
npm run build:price-audit-svc
```

Resultados locales: 662 unitarias PASS; E2E general repetida 432 PASS, 37 omitidas
de otras suites no activadas, cero fallos finales. Primera corrida general tuvo
ECONNRESET en multipart/auth Gateway, sin tocarlo: repetición aislada pasó 298 y
repetición general pasó. Exportación tuvo inicialmente referencia de fila SQL
incorrecta: identificador corregido, diagnóstico temporal retirado y pruebas de
archivo/recuperación/límites PASS. No se ocultaron fallos.
Typecheck general, verificación estricta adicional de fuentes/tests Vera, lint,
formato global, build de las nueve apps y builds propios PASS. actionlint 1.7.12
PASS. Imágenes Docker genéricas de ambos servicios construidas; smoke de Price
Audit en Node 24.15.0: liveness 200/readiness 503 con DB inaccesible PASS.
La suite documental heredada de master no pudo ejecutarse localmente por PyYAML
ausente; su job existente de CI instala la versión fijada. CI final por SHA en PR.
PDF corto/multipágina generados, validez confirmada con Poppler, primera página
inspeccionada visualmente. No es revisión de UI React.

CI activa las integraciones con cuatro flags explícitos. Sin ellos test:e2e las
omite; eso no equivale a ejecutarlas. Dependencias compartidas autorizadas:
amqplib (tipos incluidos), PDFKit y @types/pdfkit. No se añadió @types/amqplib
redundante. Instalación avisó 14 vulnerabilidades del árbol y peer TS5/TS6;
sin audit fix ni saneamiento general atribuido a este cambio.
