# Catalog #46 — consulta física H4 y decisiones pendientes

## Fuentes y alcance

OpenAPI **0.6.0-rc.3**, acuerdo G2–G6 del 2026-11-02, catálogo de errores,
OPEN-09 y SPEC-003/004 en Docs `40b566976fb94d924116dcd01d41b3276c2bc9e3`.
DEC-F-001/011: SKU opaco; simple vendible por sku_base; el padre con variantes
no es unidad física. AsyncAPI 0.6.0-rc.4 no cambia. Se consultaron las guías
Oracle, ficha Catalog, matriz de dependencias y compatibilidad RabbitMQ.

Cambios exclusivamente en Catalog, rama poma, PR #162 junto con integración Bulk.
No cierra #46 ni acredita despliegue, grant G7 o E2E G2. No cambia contratos,
seguridad, activación, elegibilidad comercial, stock, precio ni pedidos.

## Implementación interna — IMPLEMENTAR_AHORA

- H-G2-01: la consulta de lectura repetible acumula todos los SKU vendibles
  existentes con perfil ausente/incompleto/inválido y responde 422
  DATOS_FISICOS_INCOMPLETOS con details.skusAfectados, sin resultados parciales.
  Peso y dimensiones deben ser finitos y positivos; actualizadoEn debe ser fecha
  válida. El filtro publica únicamente ese detalle contractual y la correlación;
  descarta campos internos. Fallos de consulta/transacción/conexión se traducen
  a 503 SERVICIO_NO_DISPONIBLE sin SQL, trazas o credenciales.
- H-G2-02: los SKU simples BORRADOR y las variantes BORRADOR se reconocen como
  existentes, igual que ACTIVO/ACTIVA e INACTIVO/INACTIVA. Un borrador sin perfil
  completo causa 422; uno completo puede devolver 200 con BORRADOR. No se activa
  ni se hace comercialmente elegible por consultar sus medidas.
- H-G2-03: 1–100 SKU únicos; entradas malformadas, vacías, duplicadas o fuera de
  límite producen 422 SKU_INVALIDO; cuerpo no objeto conserva 400 VALIDACION.
  No se recorta, cambia capitalización, convierte a número ni divide el SKU.
  Cada SKU vendible consultable o ausente se clasifica exactamente una vez.
  Se conserva una consulta SQL por lote, sin nuevas llamadas por SKU.

Las dos decisiones siguientes fueron aprobadas explícitamente por Gabriel en
esta sesión el 2026-11-03 y se implementan con sus regresiones. Esa autorización
de implementación no acredita actualización del repositorio normativo, grant G7,
despliegue ni prueba E2E con G2 real. No se modifican contratos compartidos aquí.

## D-G2-01 — variante ACTIVA con padre BORRADOR/INACTIVO

**Decisión aprobada e implementada:** proyección de estado efectivo en esta
consulta. Variante ACTIVA con padre ACTIVO → ACTIVO; con padre INACTIVO →
INACTIVO; con padre BORRADOR → BORRADOR. Variante INACTIVA → INACTIVO y variante
BORRADOR → BORRADOR, cualquiera sea el estado del padre. Producto simple conserva
su estado. No se modifican estados persistidos, activación ni elegibilidad de
otras operaciones. La matriz de nueve combinaciones tiene regresiones.

Así F-01 no interpreta como activa una variante bajo padre no activo. Para F-02,
INACTIVO/BORRADOR sigue siendo información en un 200 con perfil válido: G6 no
rechaza automáticamente esos SKU existentes. Las condiciones del pedido y la
decisión logística siguen siendo de G2. El cambio es semántico aunque conserve
campos y enum; Marco/G2 deben reflejar el acuerdo en su documentación normativa
y comprobar compatibilidad del consumidor antes de acreditar integración externa.

## D-G2-02 — sku_base de producto con variantes

**Decisión aprobada e implementada:** rechazar el lote con 422 SKU_INVALIDO
porque la entrada identifica un agregado existente, pero no una unidad física
vendible consultable por esta operación. Reutiliza código existente y no inventa
perfil. noEncontrados se reserva a identidades ausentes. La validación de base
no física precede a la validación de perfiles del lote, independientemente del
orden de entrada; no hay 200 parcial ni perfil padre inventado. Se prueban base
sola, múltiples bases, lote mixto, ausencia real y coexistencia con perfil incompleto.
La corrección bilateral solicitada conserva el código e incluye en
details.skusAfectados todas las bases no físicas solicitadas, únicas, literales
y en orden de entrada. No incluye SKU ausentes ni perfiles incompletos en ese
detalle. ProblemFilter conserva únicamente esa lista y descarta campos internos;
las validaciones ordinarias conservan su respuesta sin details. La precedencia
bases no físicas → perfiles incompletos se mantiene y queda pendiente de
confirmación por G2. Marco actualizará por separado la documentación normativa
y la traducción pública G2 a DESP_ERROR_PRODUCTO_NO_ELEGIBLE. Las regresiones
HTTP con JWT local y PostgreSQL desechable no acreditan E2E real con G2/G7.

## Lectura Bulk sku_variante → variant_id — BLOQUEADO_ESPECÍFICO

El DTO PricingCatalogContext tiene cinco campos y additionalProperties:false;
añadir variantId no es una extensión compatible con ese schema. Tampoco acredita
autorización para Bulk: no figura como consumidor de obtenerContextoSku.
listarVariantesProducto sí devuelve variant_id, sku y catalog_version bajo un
producto, pero hoy exige userBearer; Bulk no puede reutilizar JWT del usuario.

**Propuesta preferida a Marco:** autorizar explícitamente lectura técnica de la
operación existente listarVariantesProducto para la identidad propia G6, con
scope/allowlist y perímetro aprobados. Bulk ya recibe producto_id en actualización;
puede recorrer páginas, buscar SKU exacto y obtener variant_id y versión, sin
modificar el DTO de contexto usado por Pricing. Catalog vuelve a comprobar padre,
SKU y versiones del comando dentro de su transacción; la lectura no elimina el
control optimista. Hay que aprobar previamente el cambio de seguridad y su
exposición; no se implementa aquí. No se inventa scope ni se amplía catalogo:leer.

Alternativa: versionar y homologar el contexto técnico con identidad de variante
y consumidor Bulk, incluyendo adaptación del schema cerrado y pruebas Pricing.
Es mayor acoplamiento; requiere aprobación documental antes de tocar código.
Hasta esa aprobación **no existe una lectura contractual autorizada suficiente**
para la resolución automática del archivo de variantes. El handler recibe IDs
resueltos conforme AsyncAPI; no requiere reescritura. Marco/Bulk implementa su
adaptador después del acuerdo, sin SQL entre schemas.

## Pruebas y límites de evidencia

- Unitarias de repositorio con resultados SQL de fixture: estados simples y
  variantes, perfil inválido/ausente, fecha ausente/inválida, medidas no finitas,
  rechazo atómico, 100 SKU, clasificación completa, errores técnicos. Estas
  fixtures cubren también valores históricos que las restricciones SQL actuales
  impiden insertar; no son pruebas de PostgreSQL real.
- Servicio y HTTP Nest: límites, duplicados, entradas inválidas, estados,
  conservación de SKU, 422/código/details exactos y 503 sanitizado. Repositorio
  sustituido explícitamente; no acreditan persistencia.
- Gateway/Catalog con JWT RS256 y JWKS locales: identidad modulo-despacho,
  audiencia api-productos, scope productos:fisicos:leer; negativos de ausencia,
  expiración, audiencia, scope y cliente. El caso permitido sin DB llega a 503.
  Es criptografía real con emisor de fixture, **no grant ni autenticación G7 real**.
- PostgreSQL 17/TLS desechable: nuevo OPEN-09 usa mutaciones/repositorios reales
  para producto simple y variante en los tres estados, lote mixto de 100 SKU y
  422 con ambos perfiles incompletos. Taxonomy/preparaciones son fixtures.
  Docker ausente localmente; ejecución efectiva y CI por SHA se registran en PR.
- OPEN-09-PROVIDER: JWT RS256/JWKS locales → HTTP real de Catalog → servicio y
  repositorio reales → PostgreSQL 17/TLS. No se sustituyen guards, casos de uso
  ni repositorio. Verifica 200 con 100 SKU íntegros, tres estados simples y nueve
  combinaciones padre/variante; 422 SKU_INVALIDO por base no física, duplicados
  y límites; 422 DATOS_FISICOS_INCOMPLETOS con ambos SKU afectados; negativos
  401/403. Provoca un 503 real revocando SELECT únicamente al rol de fixture en
  la base desechable, restaura permisos en finally y verifica recuperación 200.
  Comprueba estados/versiones persistidos sin cambios. Los maestros y resultados
  de preparación del dataset son fixtures explícitas, no servicios externos.

Pruebas conjuntas G2↔G6 y autorización real: G7 debe conceder credenciales/grant
modulo-despacho, aud api-productos, productos:fisicos:leer; G2 y Poma deben probar
cliente/proveedor por SHA. Son verificaciones independientes de homologación.
No se amplía demo ni se habilita RabbitMQ compartido. Los N+1 anteriores siguen
como pendientes de rendimiento fuera de este cambio.
