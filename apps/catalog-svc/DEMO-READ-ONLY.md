# Demo interna de lectura G6 — preparación de publicación

Alcance aprobado por el usuario el 2026-10-17: frontend propio de G6, sin login/JWT,
solo categorías, productos, imágenes, detalle y precio base real en PEN.
No incluye interfaces de Marketplace, venta, stock, mutaciones ni preparación AMQP.
Esta aprobación permite los cambios específicos de Gateway y la composición frontend
además de Catálogo. No autoriza merge ni despliegue. Se conservan los seeds/certificados
locales preexistentes fuera de los commits y no se escribe en Supabase.

## Comportamiento

- `G6_READ_ONLY_DEMO_ENABLED=false` por defecto. Con `true`, Gateway admite sin JWT
  exclusivamente los GET con operationId `listarProductos`, `obtenerProducto`,
  `obtenerProductoPorSlug`, `listarCategorias`, `listarMarcas`, `obtenerPrecioBaseProducto`.
  Rechaza el resto con 403 antes del proxy, incluso si está activo el modo demo antiguo.
  No reenvía Authorization ni fabrica identidades. Fuera del modo nuevo se conserva
  la seguridad anterior.
- Catálogo permite las tres lecturas de producto decoradas, rechaza escrituras con
  403 y conserva protegidas las otras lecturas administrativas. No depende de issuer/JWKS.
- Es una consulta interna de los registros, incluidos borradores. No activa productos,
  no acredita elegibilidad de canal y no resuelve D-CAT por inferencia. Conserva
  DTO y parámetros publicados. `canal=MARKETPLACE` se mantiene únicamente como
  parámetro de compatibilidad del GET existente, sin interfaz ni integración Marketplace.
- La lista aplica filtros, COUNT y paginación en SQL, en una transacción de solo lectura.
  La página agrupa imágenes y atributos para evitar los viajes por fila que produjeron
  una respuesta de unos 5,9 s; la comprobación posterior contra Supabase midió 784 ms.
- Las imágenes del padre se priorizan; en su ausencia se muestran fotos asociadas a
  sus variantes. Se descartan los placeholders históricos `placehold.co` en la demo.
- Pricing conserva su ownership. El frontend consulta `GET /precios/productos/{id}`;
  no inventa importes ni usa precio inicial/mock como fallback. Un error se muestra.
- El healthcheck CLI de Catálogo admite el modo interno, manteniendo
  `eligibility=not_evaluated_demo`: no afirma elegibilidad comercial comprobada.

## Fuentes

OpenAPI `0.6.0-rc.1`, blob `f64bfe9a097b2a0f74c2600988305443d92f640e`;
SPEC/HU/FLOW-003 y SPEC-004; DEC-F-001/-002/-006/-011/-012. Issues backend
#50/#51/#107/#109 y frontend #5. La autorización nueva es una excepción temporal
de acceso de lectura y presentación interna respecto del contrato autenticado;
no cambia OpenAPI ni atribuye homologación externa. Precio base usa `PrecioProducto`;
las categorías y los datos de producto mantienen sus esquemas existentes.

## Evidencia existente y faltantes

`test/evidence/demo-read-local.json` registra HTTP real Catálogo -> Supabase existente,
identidad/TLS del runtime, 20 productos, validación 400, escritura 403 e imágenes HEAD.
Chromium también renderizó 20 productos y 15 fotos reales sin errores JavaScript:
frontend nuevo local -> Gateway/Catálogo reales locales -> Supabase. Los errores de
la ruta Pricing pública pendiente se conservaron visibles (el Gateway local devolvió
500 al recibir el cuerpo de texto 503 de Caddy, que no es un Problem del contrato).
No se presentó esta comprobación parcial como recorrido Vercel/Oracle completado.
La consulta SQL de solo lectura mediante Supabase MCP confirmó 20 precios globales
vigentes, positivos y en PEN; esto NO acredita un endpoint Pricing desplegado.

Hay 15 fotografías reales accesibles. Faltan fotos acreditadas de adidas Entrada 22,
adidas Runfalcon 3.0, Nike Pitch, Nike Revolution 7 y Puma Ultra Play. Cuatro tenían
placeholders, que no se presentan como fotografías. No se sustituyen por otra edición.

Antes de publicar, las comprobaciones públicas devolvieron: Vercel 200 (versión anterior),
`/api/v1/categorias` 200 con ocho categorías; productos, marcas y precio base 503 con
el texto fijo de Caddy indicando que Gateway está pendiente. El detalle local de Catálogo
falla en la frontera de marcas de Taxonomy. Playwright contra la Vercel actual falla
porque la vista nueva aún no está publicada; no es evidencia de la versión nueva.

## Liberación concreta pendiente de aprobación final

1. Revisar los commits de `poma` en backend PR #125 y frontend PR #40. No hacer merge
   ni publicar sin la autorización final solicitada.
2. Preparar Gateway/Catálogo/Taxonomy/Pricing en la red privada `g6-http` con sus
   roles propios, TLS y CA ya provisionados; no reutilizar el rol de Catálogo en otros schemas.
3. Gateway: `G6_READ_ONLY_DEMO_ENABLED=true`; no necesita el flag amplio antiguo.
   Configurar los tres upstreams privados `http://catalog-svc:3001`,
   `http://taxonomy-svc:3006`, `http://pricing-svc:3002` y sus readiness reales.
4. Catálogo: `G6_READ_ONLY_DEMO_ENABLED=true`,
   `CATALOG_TAXONOMY_URL=http://taxonomy-svc:3006`, runtime PostgreSQL propio existente.
5. Pricing: conservar el mecanismo implementado por su owner:
   `GATEWAY_DEMO_NO_AUTH_ENABLED=true` y `PRICING_DEMO_PRODUCTION_CONFIRMED=true`,
   runtime PostgreSQL propio existente. No es un permiso para mutaciones públicas:
   Gateway del modo nuevo solo permite los seis GET y los puertos siguen privados.
6. Caddy: enrutar `/api/v1/*` al alias privado `g6-api-gateway:3000`, según el registro
   de despliegue. Verificar la conectividad de Gateway a `g6-http`; no apuntar a una
   IP de contenedor ni publicar los puertos de los microservicios.
7. Vercel: `VITE_DATA_MODE=api`, `VITE_G6_READ_DEMO=true`. El rewrite `/api/v1/:path*`
   precede a la SPA y proxyfica al dominio Oracle conocido. El navegador usa el mismo
   origen, sin cookies/Authorization y sin acceso directo a Supabase ni CORS abierto.
8. Ejecutar el Playwright real del frontend con `G6_DEMO_BASE_URL` apuntando a la
   Vercel aprobada: Chromium, un worker, sin interceptar HTTP, sin vídeo/traza de éxito.
   Registrar SHA de ambos runtimes y versión/configuración efectiva.

## Dependencias concretas

| Owner | Operación | Condición verificable |
|---|---|---|
| Infra/Marco | Productos, marcas, precio y detalle públicos | Aprobar/publicar runtimes, upstreams y rutas Caddy; GET reales 200 por Gateway |
| Administrador Vercel del proyecto G6 | Consultar/publicar versión frontend | Restaurar acceso del conector al proyecto; actualmente GET configuración devuelve 403; aprobar publicación final |
| Owner de datos Inka Athletics/G6 | Imágenes de cinco productos históricos | Proporcionar foto acreditada del modelo/edición y aprobar su asociación; no ejecutar los seeds de perfiles para resolver esta demo |

Implementación, provider tests, consulta Supabase local, prueba pública, homologación
y despliegue son evidencias distintas. La implementación no se declara desplegada.
