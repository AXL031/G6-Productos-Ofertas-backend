# Reglas y consultas Promotions — #72/#73

Seguimiento actual del 02/11/2026: [PR #159 y composición conectada a HTTP](REVISION-PR159-Y-COMPOSICION-H4.md).
Los cortes del 23/10 que siguen conservan su evidencia histórica; el gate de
acumulación fue reemplazado por la composición interna aprobada y probada.

Owner: Axel Cueva. Rama única: `cueva`. Corte: 23/10/2026, America/Lima.
**Estado: IMPLEMENTAR_PARCIAL.** No se declaran completados los issues ni una
integración comercial operativa por disponer de handlers y pruebas aisladas.

Continuación pasos 2/3: el cliente HTTP saliente tipado ya está implementado,
aislado y sin registro productivo. No faltan DTOs HTTP por GenericData; faltan
identidad/delegación autorizadas y las fronteras específicas de resolución SKU y
recomendaciones. Ver [ADAPTADORES-COMERCIALES.md](ADAPTADORES-COMERCIALES.md) para
operaciones, pruebas y límites actuales. GenericData sigue aplicando a los eventos.

## Fuentes consultadas

Docs G6 `51a5ce6e76bb0c61d93ef47416e46797bf5b9846`: OpenAPI 0.6.0-rc.1,
Arquitectura, SPEC/HU-005/006/007, WF-006, modelos lógico/físico de Promotions,
DEC-F-007/008/009/012 y matrices de trazabilidad/intermodular. AsyncAPI vigente
rc.3 conserva payloads GenericData para las proyecciones. La etapa #72/#73 no
modificó bindings/dispatcher; su actualización posterior se documenta en EVENTOS-AMQP.md.

Identidad: contrato oficial G7 `Modulo-de-Seguridad/specs/contrato-api/openapi.yaml`
consultado el 22/10/2026. Firma RS256, issuer exacto, expiración y claims del
perfil; el usuario no requiere una audiencia inventada. G6 usa el rol
GESTOR_COMERCIAL, no permisos internos de G7. Cada servicio requiere audiencia,
scope y allowlist de su operación OpenAPI.

## #72: implementación interna

- Descuentos positivos/porcentaje hasta 100, fechas válidas, prioridad positiva,
  canales explícitos sin duplicados, alcance producto/SKU separado y no vacío.
  La actividad de referencias requiere datos autoritativos suministrados al dominio.
- Capacidad de cambiar modalidad derivada de estado inactivo, ausencia de primera
  activación, cupones e historia; el request no concede ese permiso.
- Código de cupón normalizado con trim y mayúsculas ASCII, unicidad excluyendo
  la propia fila, límites/mínimo positivos y motivos de rechazo contractuales.
- Evaluación de alternativas exclusivas con decimal exacto: alcance deduplicado,
  porcentaje o monto fijo una vez, descuento limitado al subtotal elegible,
  comparación con oferta de Pricing y combinación con esa oferta solo permitida.
- Empates: no usar cupón, menor prioridad y después identificador estable.
- Recomendaciones: origen/candidatos activos, criterio UPSELL controlado,
  justificación hasta 500 caracteres, prioridad/orden, filtrado y deduplicación.
- El núcleo de consumo/restauración, locks, recibos, replay y Outbox existentes
  permanece como única implementación de esos efectos. No se consume al consultar.

Los validadores de configuración son funciones de dominio. La etapa #74 posterior
implementa las doce escrituras administrativas y su orquestación, documentadas en
[ESCRITURAS-HTTP.md](ESCRITURAS-HTTP.md), con verificación de referencias protegida.
La adaptación física y el dispatcher posteriores de #75 se describen en
[EVENTOS-AMQP.md](EVENTOS-AMQP.md); no activan las fuentes comerciales de esta etapa.

## #73: superficie HTTP

Todas las rutas conservan sus DTOs, parámetros y códigos de OpenAPI. No se
agregan mutaciones ni endpoints para consumir/restaurar cupones.

| operationId | Ruta | Estado de aplicación |
| --- | --- | --- |
| listarPromociones | GET /api/v1/promociones | PostgreSQL real; canal, vigentes y estado. |
| listarPromocionesAdmin | GET /api/v1/promociones/administracion | PostgreSQL real; página/tamaño/estado/modalidad. |
| obtenerPromocionAdmin | GET /api/v1/promociones/{promocionId} | Agregado propio y capacidad calculada. |
| listarCupones | GET /api/v1/cupones | Página/tamaño/estado y usos no restituidos. |
| obtenerCuponAdmin | GET /api/v1/cupones/{cuponId} | Maestro, usos y disponibilidad derivada; sin límite devuelve null. |
| listarReglasRecomendacion | GET /api/v1/recomendaciones/reglas | Página/tamaño/estado/tipo, items ordenados. |
| obtenerReglaRecomendacion | GET /api/v1/recomendaciones/reglas/{reglaId} | Detalle propio; ausencia contractual 404. |
| evaluarPromociones | POST /api/v1/promociones/evaluar | Handler y cálculo interno; fuente comercial bloqueada por defecto. |
| validarCupon | POST /api/v1/cupones/validar | Handler y validación sin consumo; fuente comercial bloqueada por defecto. |
| obtenerRecomendaciones | GET /api/v1/recomendaciones | Handler/ranking; enriquecimiento bloqueado. Sin reglas activas propias devuelve lista vacía real. |

Los siete handlers de maestros pueden operar con PostgreSQL e identidad G7
configurados. Las tres consultas comerciales no se anuncian operativas en
producción: el provider `COMMERCIAL_CONTEXT` está explícitamente bloqueado.
Las pruebas que lo sustituyen por hechos sintéticos se identifican como tales.

`AUTH_ISSUER` y `AUTH_JWKS_URL` deben configurarse juntas y con HTTPS. Omitir
ambas no afecta `/health`; las rutas protegidas rechazan tokens sin configuración
de confianza. No hay claves embebidas, bypass de firma ni tokens de otro módulo.
El JWKS se cachea, tiene timeout/límite de bytes y conserva claves conocidas ante
una caída de G7 conforme a su contrato. Una clave desconocida no se acepta.

Las lecturas usan REPEATABLE READ READ ONLY: conteo, página, hijos y capacidad se
derivan del mismo snapshot. Las relaciones se cargan por lote; no se hacen joins
cross-schema ni llamadas externas con la transacción abierta. El reloj de negocio
es inyectable. Los errores son Problem Details sin diagnósticos SQL ni secretos.
Un cupón no aplicable usa 200 y código de rechazo; 404 queda para detalles
administrativos ausentes. JSON malformado y validación usan 400 VALIDACION.

## Fronteras pendientes específicas

| Owner | Operación | Condición verificable de desbloqueo |
| --- | --- | --- |
| Catálogo/Pricing + integración G6/G7 | evaluarPromociones / validarCupon | Adaptador autenticado de elegibilidad y precios SKU/canal/instante, con identidad autorizada; o payloads/versiones y procedencia de proyección acordados y probados. GenericData por sí solo no permite adivinar campos, vigencia o elegibilidad. |
| Promotions/arquitectura G6 | Evaluación con varias promociones que permiten acumularse | Revisar y adoptar la [propuesta v1 de composición](PROPUESTA-COMBINACION.md), ya implementada en src con redondeo y límites técnicos, sin conexión al HTTP. Homologar escala, límites operativos y representación/snapshot con los consumidores. El caso afectado sigue protegido; las alternativas exclusivas siguen implementadas. |
| Catálogo/Pricing/Inventario + arquitectura G6 | Recomendaciones enriquecidas | Adaptador autenticado para producto simple; para múltiples SKU, resolver D-REC-01/02 sin escoger/agregar variantes por inferencia. availability es obligatoria: no se inventa un estado ni un precio. |
| G7/owner de entorno | Integración autenticada desplegada de cualquier consulta | Issuer/JWKS y grants reales por consumidor, configuración de entorno y prueba autenticada. JWT sintético de prueba no acredita grant G7. |

No se reutiliza el token del canal imponiéndole scopes adicionales de Catálogo o
Pricing. El puerto pendiente no usa arrays, precios o stock simulados en producción.
Los límites/idempotencia definitivos de consumo siguen revalidándose al consumir;
una validación positiva no reserva el último uso.

## Continuación #72/#73 — paso 4

La propuesta v1 ya cuenta con motor interno compilado y presupuesto de búsqueda,
más proyección monetaria exacta con escala explícita, redondeo total mitad hacia
arriba y reparto por mayor resto/desempate canónico. Conserva las 26 regresiones
originales y añade conservación monetaria en cestas pequeñas y agotamiento de
presupuesto. Su salida no se conecta a DTOs: la semántica singular de promotion_id,
la composición, el snapshot y las escalas deben homologarse. El gate de acumulación
de `evaluateBasket` y el provider comercial bloqueado permanecen activos.

Las tres llamadas del puerto comercial tienen límite de 2,5 s por llamada y señal
AbortSignal hacia el adaptador. Timeout, excepción síncrona o fallo de transporte
se traducen a dependencia no disponible (HTTP 503 sanitizado). No hay reintento
implícito ni lista vacía que esconda una caída. En recomendaciones los dos pasos
secuenciales tienen cada uno ese límite; no se promete 2,5 s para toda la solicitud.
Los adaptadores futuros deben cerrar el transporte al abortar. El wrapper se
aplica también al sustituir el provider en pruebas; no abre conexiones por defecto.

La revisión de OpenAPI rc.1 confirma el bloqueo de identidad concreto: listarProductos,
obtenerProducto, obtenerPrecioSku y consultar disponibilidad comercial autorizan
solo modulo-marketplace, modulo-chatbot y modulo-retail. Promotions no figura en
esas allowlists. El endpoint de datos físicos está reservado a modulo-despacho.
No se suplantan esas identidades ni se reenvía el token del consumidor.

| Owner | Operación afectada | Desbloqueo verificable |
| --- | --- | --- |
| Marco/contratos G6 + Poma/Catálogo, Vera/Pricing, Taco/Inventario + G7 | Fuentes reales para evaluar/validar/recomendar | Homologar operación/payload tipado y allowlist para identidad propia de Promotions; emitir grants/audiencia/scopes reales y probar transporte autenticado para SKU/canal/instante. GenericData no acredita esa forma. |
| Arquitectura G6 + Catálogo/Inventario/Pricing | Recomendaciones de producto con varios SKU | Resolución registrada D-REC-01/02 para disponibilidad/precio de variantes y prueba contractual; no agregar variantes por inferencia. |
| Marco/G6 + Pricing/Ventas y consumidores | Publicar composición/resultado monetario | Aceptación verificable de propuesta v1, escala y límites; semántica de identidad y snapshot homologada/versionada donde sea necesaria. |

Implementación interna: avance anterior. Pruebas locales: registrar por comando y
SHA en el reporte. Integración autenticada compartida, homologación y despliegue:
NO EJECUTADOS. Estas fronteras no bloquean las siete consultas propias ni las
invariantes internas. La evidencia sintética HTTP sirve para el comportamiento
interno, nunca para afirmar que existen grants comerciales reales.

## Pruebas reproducibles

```powershell
npm test -- apps/promotions-svc --maxWorkers=1
npm run test:e2e -- apps/promotions-svc --maxWorkers=1
npm run build:all
# Docker; definir G6_TEST_OPENSSL o G6_TEST_PYTHON según PERSISTENCE.md
node apps/promotions-svc/test/persistence.isolated.smoke.mjs
node apps/promotions-svc/test/coupons.isolated.smoke.mjs
```

El smoke de persistencia existente ahora añade consultas HTTP con PostgreSQL/TLS
real, login restringido y JWT firmados. Prueba los siete handlers de maestros,
DTOs/filtros/paginación/detalles, 400/401/403/404/503, los gates de producción y
fallo del pool. Otra fase usa datos comerciales sintéticos explícitos para probar
los handlers evaluar/validar/recomendar y comparar conteos antes/después: cero
usos, recibos, Inbox u Outbox nuevos tras consultas/reintentos. No simula PostgreSQL
ni acredita fuentes comerciales reales. Ese smoke ya se ejecuta en el job de CI
de persistencia; no fue necesario modificar `.github/`.

La metadata HTTP se genera desde OpenAPI oficial con hash del YAML. Para
regenerarla, convertir ese YAML a JSON fuera de las dependencias del proyecto y
ejecutar `node apps/promotions-svc/test/generate-http-contract.mjs <archivo.json>`;
el YAML debe estar junto al JSON con el mismo nombre. La aplicación no descarga
contratos al arrancar. El metadata interno conserva las condiciones JSON Schema,
incluida la obligatoriedad de code cuando valid=false.

## Dimensiones de evidencia

Implementación interna: alcance anterior, con fronteras parciales explícitas.
Pruebas locales/CI: se registran por SHA y comando; no inferirlas del documento.
Integración autenticada compartida, homologación y despliegue: NO EJECUTADOS.
DATA/restore: sin carga persistente. Consumidor/pump: deshabilitados. Issues abiertos.
