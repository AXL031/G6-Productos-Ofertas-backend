# Bloque 2 — Auditoría y correcciones #45 y #46

Refs #45. Refs #46. Fecha: 2026-10-21. Rama y owner: `poma`, Gabriel Poma.
Este informe añade trazabilidad del bloque actual; los informes anteriores
conservan sus resultados históricos.

## A. Estado Git y fuentes vigentes

HEAD inicial: `ca35bf8980eeb7f38f16e7742dae5430b17c3aea`.
Tras fetch, master sigue en `47e219e376fff1004ec10e9803c16119c811a699` y es
ancestro de poma: 0 detrás / 35 delante al iniciar. No se hizo otro merge.
La CI anterior [39638650606](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39638650606)
está completed/success para ca35bf8. No valida los cambios de este bloque.
PR #125 sigue abierto de poma hacia master; issues #45/#46 abiertos y
asignados a GabrielPGu. Se leyeron ambos cuerpos y sus comentarios; no había
reviews ni comentarios inline nuevos en el PR.

Docs master sigue en `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`:
se reutilizó el contenido vigente consultado en #43/#44, especialmente
SPEC/HU/FLOW-003/004, Arquitectura, Modelo Conceptual, DEC-F/matrices,
OpenAPI 0.6.0-rc.1, AsyncAPI 0.6.0-rc.2, catálogos de errores/eventos,
modelo físico y migración de Catálogo. Se consultaron adicionalmente las
secciones relevantes de MK-003/MK-004; sus preguntas abiertas no son permisos
para modificar contratos. DEC-F-001/002/006/009/011/012 aplicables.
AGENTS y guías Oracle ya consultados siguen vigentes.

## B. Issue #45: reglas y evidencia

| Criterio | Evidencia y clasificación |
| --- | --- |
| Alta BORRADOR / identidad estable | createProduct/createVariant fijan BORRADOR; triggers conservan ID/SKU/modelo; pruebas PG de alta, duplicados y combinaciones. IMPLEMENTADO_Y_VERIFICADO en CI previo; ampliación PG actual pendiente de CI |
| Simple / padre / variante | Intención Pricing solo del producto; INVENTORY del simple o de cada variante; sin saldo ni precio maestro en Catálogo. Nuevos asserts: un intento Pricing y tres de Inventory para tres variantes |
| Perfil kg/cm parcial / completo | Dominio y parser validan cada medida positiva y finita. Cuatro nuevos casos parametrizados cubren peso/largo/ancho/alto, ausente/null, 0, negativo, NaN, ambos infinitos y positivos finitos extremos. IMPLEMENTADO_Y_VERIFICADO local |
| Activar / reactivar | validate comprueba maestros, atributos, imagen, perfil e Inventory COMPLETED; padre exige Pricing COMPLETED y al menos una variante activa válida. No exige padre activo para activar hija |
| Hermanas no activas | Nuevo caso PG combina ACTIVA/COMPLETED, BORRADOR/PENDING e INACTIVA/REJECTED; el padre activa sin cambiar a las hermanas. SIN_COBERTURA_SUFICIENTE corregida; ejecución nueva en CI |
| Edición activa inválida | Validación del estado resultante dentro de la transacción; nuevo PG verifica rollback integral de edición física parcial de variante, incluidas versiones/preparaciones/colecciones. Cobertura previa del producto preservada |
| Desactivar última activa | Cálculo bajo locks del agregado; padre ACTIVO pasa a INACTIVO; otros estados y hermanas se conservan. Suite PG previa y unitarias conservadas |
| Reactivación independiente / transiciones inválidas | state exige flujo correcto y revalida; tests existentes preservan independencia padre/hijo. Nuevo PG rechaza reactivar hija rechazada e incompleta |
| Preparación e idempotencia | PENDING/REJECTED no acreditan activación; COMPLETED terminal; consume valida intento vigente y deduplica Inbox; retry mantiene operación y genera mensaje nuevo bajo lock. Casos previos de carreras/stale/dedupe preservados |
| Lectura de preparación | Datos locales, sin llamadas a Pricing/Inventory; nuevo PG comprueba PENDING y REJECTED con code, sin permiso manual inventado |
| Barreras, Q-06 y políticas pendientes | Fronteras conservadas; condiciones y owners en sección E. BLOQUEADO_POR_DECISION solo para esas operaciones |

No se reprodujo un defecto nuevo de lógica de negocio que requiriese cambiar
las mutaciones en este bloque. Se completó cobertura de límites y escenarios
del servicio real. Las fixtures de maestros de la suite PostgreSQL están
aisladas y explícitas; no prueban integración autenticada con Taxonomy.

## C. Issue #46: ocho operationIds

Todas las rutas usan el prefijo `/api/v1`. Se verificaron método, DTO,
parámetros, identidad y ausencia de mutaciones desde las consultas.

| operationId | Método / ruta | Identidad y respuesta / límite |
| --- | --- | --- |
| listarProductos | GET /productos | userBearer o servicio catalogo:leer de clientes publicados; página comercial, estado administrativo restringido; D-CAT-05/06 y precio pendientes |
| obtenerProducto | GET /productos/{productoId} | Mismo guard comercial; consulta ID opaco, canal y DTO ProductoDetalleComercial; 404 cuando no existe/no es elegible con política disponible |
| consultarDatosFisicos | POST /productos/datos-fisicos/consulta | Servicio modulo-despacho, productos:fisicos:leer; 1–100 SKU opacos, 200 productos/noEncontrados; kg/cm, sin saldos/precios |
| obtenerProductoPorSlug | GET /productos/por-slug/{slug} | Guard comercial, slug preservado, canal y marca vía Taxonomy; SKU distinto de variant_id; 404 con política disponible |
| obtenerPreparacionProducto | GET /productos/{productoId}/preparacion | Usuario GESTOR_COMERCIAL; DTO ProductoPreparacion local, 404 producto ausente; sin inventar operation_id no publicado en este DTO |
| listarVariantesProducto | GET /productos/{productoId}/variantes | Usuario GESTOR_COMERCIAL; filtro BORRADOR/ACTIVA/INACTIVA, pagina y tamanio máximo 200, items/meta y padre verificado |
| obtenerVariante | GET /productos/{productoId}/variantes/{variantId} | Usuario GESTOR_COMERCIAL; relación padre/hija comprobada, DTO Variante; 404 VARIANTE_NO_ENCONTRADA |
| resolverCodigoBarras | POST /productos/codigos-barras/resolver | Servicio modulo-retail, catalogo:leer; texto opaco/ceros preservados; entrada inválida 400 y frontera válida 503 hasta D-CAT-01..04 |

Listado comercial: filtros y total se aplican en SQL antes de LIMIT/OFFSET,
orden por nombre + ID estable, snapshot repeatable-read/read-only y valores
parametrizados. El modo administrativo requiere identidad habilitada; los
modos demo conservan sus excepciones previas y no acreditan elegibilidad.
PrecioMin/Max fallan cerrados mientras falte la frontera aprobada de Pricing.
La falta de dependencia conserva 503; no se convierte en lista vacía o 404.

Defecto reproducido y corregido: CatalogTokenVerifier delegaba la decodificación
base64url a Buffer, que acepta caracteres ajenos al formato. Un JWT generado
con firma válida seguido de `~` o `=` todavía verificaba en la prueba directa.
Ahora exige tres segmentos no vacíos con alfabeto base64url antes de decodificar.
Se agregan cuatro casos de firma y una regresión HTTP: JWT con `~` devuelve
401 TOKEN_INVALIDO. La reproducción requería una firma válida; no demuestra
capacidad para fabricar firmas o alterar claims. Fuente técnica:
[RFC 7515 §§2 y 5.2](https://www.rfc-editor.org/rfc/rfc7515.html#section-5.2).
Roles, scopes, audiences, issuer, JWKS y excepciones demo conservan su política.

Cobertura nueva: las ocho operaciones prueban ausencia/token inválido 401 e
identidad prohibida 403 antes de ejecutar casos de uso; Problem Details conserva
correlationId. Cinco casos HTTP rechazan parámetros duplicados/desconocidos en
listados; otro comprueba 503 sanitizado sin mutaciones. Los casos positivos,
vacíos, 404, 422 y límites previos siguen presentes.

Discrepancia contractual conservada: listarVariantesProducto y obtenerVariante
no enumeran 400 en sus responses, aunque la validación existente de paginación
o correlación puede producir VALIDACION. No se altera OpenAPI ni se elimina
validación para ocultarlo; requiere alineación documental de arquitectura/integración.

La suite opt-in de elegibilidad esperaba 503 en rutas sin Bearer, incompatible
con el guard actual. Se corrige a 401 TOKEN_INVALIDO, conservando el assert
503 del adapter cuando falta la tabla. Los modos demo se deshabilitan
explícitamente en ese test. Esa suite sigue NO EJECUTADA sin entorno opt-in;
los 401 y 503 correspondientes tienen pruebas HTTP/provider locales separadas.
No se declara integración externa a partir de fixtures.

## D. Validación e integridad

Windows, Node 24.16.0, npm 11.13.0. Los tests de sockets se ejecutan fuera del
sandbox con autorización de herramienta. El primer test de regresión JWT
reprodujo dos fallos (firma con `~` y con `=`); tras corregirlo, la suite
enfocada auth/security/domain pasó 44 pruebas. HTTP enfocado: 40 PASS.

| Comando | Resultado local |
| --- | --- |
| npm test -- --no-file-parallelism apps/catalog-svc | PASS: 322, 33 archivos |
| npm run test:e2e -- --no-file-parallelism apps/catalog-svc | 67 PASS / 34 SKIP, 6 archivos PASS / 5 SKIP |
| npm run build:catalog-svc | PASS |
| npm run typecheck | PASS |
| npm run lint | PASS |
| npm run format:check | PASS |
| npm run build:all | PASS |
| npm test -- --no-file-parallelism | PASS: 712, 69 archivos |
| npm run test:e2e -- --no-file-parallelism | 420 PASS / 87 SKIP, 19 archivos PASS / 9 SKIP |
| git diff --check | PASS |
| tsc explícito de los tres E2E modificados | PASS |

El tsc explícito usa --ignoreConfig, --noEmit, NodeNext, ES2023, decorators,
emitDecoratorMetadata, esModuleInterop, skipLibCheck y vitest/globals.
Docker no está instalado: PostgreSQL/TLS/RabbitMQ locales SKIP.
Los dos nuevos escenarios PG hacen crecer esa suite de 16 a 18 casos.
Uno verifica borrador simple parcial/activación; el otro mezcla estados de
hijas, rollback y lecturas reales (paginación/filtros, preparación, físico,
parentesco y snapshots/Outbox sin efectos de consultas).
La ejecución real de esos casos se debe comprobar por SHA en CI.

Se preservan #43/#44 y los avances #47–#51. Solo cambia código productivo de
validación JWT en catalog-svc. Sin cambios de Gateway/frontend/otras apps,
dependencias, contratos, migraciones, grants o escrituras cross-schema.
Las semillas locales y el certificado preexistentes quedan fuera de commits.

## E. Bloqueos específicos y estado recomendado

| Owner | Operación / estado | Desbloqueo verificable |
| --- | --- | --- |
| Marco/Arquitectura + poma + Pricing | D-CAT-05/06: listado/ID/slug ordinarios y filtros de precio | Política de elegibilidad y persistencia/defaults versionados, frontera Pricing aprobada; existencia de sku_channel_eligibility no acredita esa decisión |
| Marco/Arquitectura + Retail + poma | D-CAT-01..04: resolución barcode | Asociación persistente, unicidad/cardinalidad y errores aprobados; sin asociación inventada |
| Marco/Arquitectura + Taxonomy/lopez | Q-06: corrección de tipo y protocolo de barreras | Operación/campo e invariantes alineados con SPEC-010 y contrato vigente; GenericData tipado/versionado |
| Arquitectura + Pricing/vera + Inventory/taco | REJECTED recuperable | Política por código/operación publicada que corrige la causa; mientras tanto manual_retry_allowed=false |
| Operación G6 + poma | PENDING vencido | Umbral operativo aprobado y configurado en CATALOG_PREPARATION_TIMEOUT_MS; sin default arbitrario |
| Owner producto + poma | Alta con SKU omitido | Decisión expresa de generación; instrucción actual del usuario conserva SKU explícito |
| Arquitectura/Marco + poma + integración | Respuestas 400 de consultas de variantes | Alinear responses OpenAPI con los errores de validación existentes, preservando contrato versionado |
| Infra/CI + poma | Nuevos escenarios PostgreSQL | Ejecutar y verificar logs del SHA publicado, sin contar omisiones como PASS |

Estado recomendado: #45 IMPLEMENTAR_PARCIAL por las fronteras normativas;
#46 IMPLEMENTAR_PARCIAL por elegibilidad/barcode/precio. Criterios internos
verificados se distinguen de contratos pendientes, integración autenticada,
homologación y despliegue. No se declara READY_FOR_DEPLOY.

## F. Publicación y siguiente bloque

Commits propios y SHA final: git log del bloque y sección
«Bloque 2 — Auditoría y correcciones #45 y #46» del PR #125.
Esa sección registra resultados generales y URL/jobs de CI por SHA una vez
consultados. Push normal en poma; mantener PR e issues abiertos, sin merge.

Para #47/#48 conservar locks y rollback, versión del agregado, terminalidad de
COMPLETED, operación estable e intentos causales, ACK tras commit/confirm y
dedupe por contenido. Las nuevas regresiones JWT afectan a todas las rutas
protegidas; deben seguir ejecutándose al revisar mutaciones/mensajería.
No se implementan esos issues ni se cambia topología o infraestructura externa
en este bloque.
