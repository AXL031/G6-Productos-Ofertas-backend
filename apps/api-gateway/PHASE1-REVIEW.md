# Fase 1 — entrega para auditoría

## Alcance y base

Rama `cueva`, fork AXL031. Base oficial actualizada:
`15941b6fa3e6f00e595995abca4b328da65ff73f`; merge local de actualización:
`eb148527b97d5076ebd0beeb73a01d3d4a2d5f33`.
El encargo transversal recibido el 05/11/2026 autoriza implementación en Gateway,
Catalog, Taxonomy y preparación Azure; seguimiento normativo Backend #144.
No autoriza merge al Backend principal ni despliegue público. Los cambios de Oracle
incorporados por el merge pertenecen a master; esta implementación no edita `ops/oracle/`.

Fuentes consultadas: Docs `a7778ec1a22811c1213a94ef096ab905911342cc`, OpenAPI
`0.6.0-rc.3` (blob `6ff062c563d381d4bcf7976f223590b400ace4ec`), AsyncAPI
`0.6.0-rc.4`, política progresiva/matriz de seguridad, SPEC-003/008/011,
DEC-F-001/006/011/012 y trazabilidad, acuerdos internos y Marketplace Docs PR #94.
No se alteran contratos, migraciones históricas ni grants.

La matriz documental consultada contiene cero `PUBLICA_APROBADA`. Las cinco filas
siguientes son el alcance preparado y probado para revisión del encargo. No se
declara su publicación, homologación externa ni cambio unilateral de ese registro.

## Cinco candidatas exactas

| Servicio | operationId | Método/ruta |
|---|---|---|
| Taxonomy | listarCategorias | GET /api/v1/categorias |
| Taxonomy | listarMarcas | GET /api/v1/marcas |
| Catalog | listarProductos | GET /api/v1/productos |
| Catalog | obtenerProducto | GET /api/v1/productos/{productoId} |
| Catalog | obtenerProductoPorSlug | GET /api/v1/productos/por-slug/{slug} |

Gateway verifica servicio, método, ruta y operationId exactos. Ampliaciones requieren
contrato y revisión de cada lectura; no basta su verbo/prefijo. Taxonomy solo admite
sus listas comerciales: detalles y consultas administrativas permanecen autenticados.
Catalog conserva padre activo, variantes activas, elegibilidad antes de contar/paginar
y 404 comercial para no elegibles. Fase 1 no activa `catalogDemoRead`, preview,
borradores ni visibilidad administrativa.

Las lecturas no generan comandos, reservas o identidades. La suite compara datos
persistidos e Inbox/Outbox antes/después. Filtros monetarios mantienen su dependencia
real de Pricing e identidad técnica; no fabrican precios ni páginas parciales. Pricing
no forma parte de la nueva prueba conjunta de cinco consultas.

## Configuración para revisión, sin activación remota

Los tres procesos usan `G6_SECURITY_MODE=PUBLIC_READ_ONLY`. Listas por proceso:

```dotenv
# Gateway
GATEWAY_PUBLIC_OPERATION_IDS=listarCategorias,listarMarcas,listarProductos,obtenerProducto,obtenerProductoPorSlug
# Catalog
CATALOG_PUBLIC_OPERATION_IDS=listarProductos,obtenerProducto,obtenerProductoPorSlug
# Taxonomy
TAXONOMY_PUBLIC_OPERATION_IDS=listarCategorias,listarMarcas
```

Las listas son vacías por defecto y cada frontera aplica autorización independiente.
No se hereda `G6_PUBLIC_OPERATION_IDS`. Mantener ausentes/false los flags legacy
`GATEWAY_DEMO_NO_AUTH_ENABLED`, `G6_READ_ONLY_DEMO_ENABLED`,
`ALLOW_DEMO_UNAUTHENTICATED` y `CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED`.
Un selector explícito combinado con bypass heredado falla al arrancar. La
compatibilidad legacy permanece solo para configuraciones antiguas sin selector;
no debe utilizarse para publicar Fase 1.

Rutas no públicas conservan JWT normal, incluidas escrituras autorizadas. Un
Authorization suministrado se valida también en rutas públicas: JWT inválido o
insuficiente no se convierte en acceso anónimo. No se exige IP privada al visitante
público; la comprobación de peer se limita a los bypasses legacy.

Catalog anónimo usa listas comerciales de Taxonomy sin JWT para validar filtros y
enriquecer detalles por ID/slug. No abre detalles privados ni fabrica un principal.
Si falta la aprobación/configuración de Taxonomy, Catalog falla cerrado con 503.
Con JWT mantiene propagación y autorización existentes. Las mutaciones mantienen
su identidad técnica original para consultar maestros.

## Reversión a autenticación normal

1. Cambiar los tres procesos a `G6_SECURITY_MODE=G7_AUTHENTICATED`.
2. Vaciar listas públicas y mantener apagados los flags legacy.
3. Configurar issuer/discovery/JWKS y permisos reales G7; reiniciar/redeployar.
4. Repetir 401 anónimo, positivos JWT y negativos de autorización.

No cambia código. La suite reinicia servidores reales con ambas configuraciones
sobre el mismo PostgreSQL. Usa issuer/JWKS HTTPS y firmas RS256 de fixtures locales:
prueba camino criptográfico y reversión, no integración ni grant G7 auténtico.
`SIMULATED_AUTH` rechaza configuración al arrancar en los tres componentes mientras
su implementación siga pendiente de homologación.

## Reproducción

```bash
npm test -- apps/api-gateway apps/catalog-svc apps/taxonomy-svc
npm run test:e2e -- apps/api-gateway/test/public-read-only.e2e-spec.ts --reporter=verbose
npm run typecheck
npm run lint
npm run build:api-gateway
npm run build:catalog-svc
npm run build:taxonomy-svc
```

La suite conjunta exige Docker y OpenSSL; no se omite silenciosamente. Crea su
propio PostgreSQL 17, TLS verify-full, roles limitados y datos adversariales; retira
solo su contenedor etiquetado y directorio temporal. No lee credenciales DB
compartidas ni admite URLs externas. Sus migraciones/seeds solo afectan a esa base
recién creada. Fixture Taxonomy congelado del blob oficial:
`3db51993e6c06ecfcbc2e93f6757f848a78987f4`.
En Windows se puede indicar `G6_TEST_OPENSSL` y, para Azure, `G6_TEST_BASH`.

Implementación/pruebas locales, CI, homologación, grants, artefactos oficiales y
despliegue se acreditan separadamente. Azure y costos: `ops/azure/README.md`.
