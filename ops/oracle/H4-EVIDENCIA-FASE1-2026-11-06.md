# Evidencia funcional H4 Fase 1 — 2026-11-06

## Identificación

- Rama: `integracion/h4-fase1-completa`
- SHA de código probado: `f5fc79f53a4b64e6e2502b49e37bab57422598a2`
- La evidencia cubre solo las operaciones registradas abajo. Las filas sin evidencia permanecen `NO_EJECUTADA` en `H4-MATRIZ-OPERACIONES-FASE1.csv`.
- Todas las aprobaciones de lectura pública de producción continúan desactivadas por defecto; la lista usada por las pruebas fue efímera y local.

## Lecturas públicas verificadas con handlers reales

| Operación | Escenario ejecutado | Resultado HTTP/contractual | Sensibilidad y efectos | Evidencia |
|---|---|---|---|---|
| `catalog-svc.listarProductos` | Gateway → Catalog → Taxonomy real, PostgreSQL 17 desechable con TLS, `PUBLIC_READ_ONLY` y allowlist explícita solo en el harness | `200`, paginación/filtros comerciales; borradores, inactivos y variantes inactivas excluidos | Respuesta inspeccionada sin campos internos; snapshot de tablas de negocio, Inbox y Outbox idéntico; escritura anónima `401` | `apps/api-gateway/test/public-read-only.e2e-spec.ts`, 9/9 |
| `catalog-svc.obtenerProducto` | Igual; producto vendible identificado por UUID | `200` para activo; `404` para borrador, inactivo o sin variantes activas | Sin campos internos; snapshot sin cambios; lectura privada y escrituras anónimas rechazadas | `apps/api-gateway/test/public-read-only.e2e-spec.ts`, 9/9 |
| `catalog-svc.obtenerProductoPorSlug` | Igual; slug visible y casos de slug inactivo/borrador | `200` visible; `404` no vendible | Sin campos internos; snapshot sin cambios; JWT inválido no obtiene respuesta pública | `apps/api-gateway/test/public-read-only.e2e-spec.ts`, 9/9 |
| `taxonomy-svc.listarCategorias` | Mismo flujo HTTP real y PostgreSQL 17/TLS, tras configurar `PUBLIC_READ_ONLY` en Gateway y Taxonomy | `200`; solo categoría visible sembrada por el fixture | Allowlist de campos comerciales, sin exposición de datos internos; snapshot compartido sin cambios; `POST` anónimo `401` | `apps/api-gateway/test/public-read-only.e2e-spec.ts`, 9/9 |
| `taxonomy-svc.listarMarcas` | Mismo flujo; marca activa | `200`; solo marca activa sembrada por el fixture | No se exponen campos internos; snapshot sin cambios; detalle privado permanece `401` | `apps/api-gateway/test/public-read-only.e2e-spec.ts`, 9/9 |
| `inventory-svc.consultarDisponibilidadComercial` | Handler HTTP real con PostgreSQL 17 TLS y RabbitMQ desechables; `PUBLIC_READ_ONLY` con allowlist de una operación; consulta Marketplace anónima | `200`, `[{sku,status:"DISPONIBLE"}]`; no devuelve cantidades ni ubicaciones | Snapshot de saldo, reservas, operaciones, Kardex, Outbox e Inbox idéntico; `POST /verificar` y disponibilidad detallada anónimos `401` | `apps/inventory-svc/test/inventory.real.integration.spec.ts`, 37/37 |

Comandos ejecutados sobre el código de ese SHA:

```powershell
npx vitest run --config ./vitest.config.e2e.ts apps/api-gateway/test/public-read-only.e2e-spec.ts
$env:INVENTORY_REAL_INTEGRATION='1'
$env:G6_DOCS_ROOT='C:\Users\marec\Desktop\G6-Productos-Ofertas\docs'
npx vitest run apps/inventory-svc/test/inventory.real.integration.spec.ts --reporter=dot
```

Las pruebas Gateway cubren además: listas públicas vacías cierran el acceso; la aprobación del Gateway es independiente; JWT humano RS256 válido funciona al cambiar a G7 por configuración; firma, issuer, expiración, audiencia de servicio, scope, actor y rol incorrectos son rechazados. No hubo cambios de código entre la ejecución de estas pruebas y el SHA registrado.

## Filas aún sin certificación

Solo 6 de 66 operaciones tienen evidencia positiva/negativa completa asociada a este SHA. Las otras 60 siguen `NO_EJECUTADA`; no se marcaron por inferencia, pruebas aisladas de guard ni por la integración de otra operación.

Entre las 14 candidatas iniciales, ocho no se habilitan:

- `taxonomy-svc.obtenerSeoPorSlug` y `resolverSlugAnterior`: falta prueba de sensibilidad/efectos de la proyección SEO; permanecen protegidas.
- `pricing-svc.consultarPrecios` y `obtenerPrecioSku`: falta ejecución de handler PostgreSQL en `PUBLIC_READ_ONLY` con análisis de campos y snapshot; no están en la allowlist.
- `promotions-svc.listarPromociones`: falta evidencia HTTP pública con PostgreSQL del proveedor y dependencias reales; no se convierte una indisponibilidad o fixture local en PASS.
- `combos-svc.obtenerCombo`: la composición requiere tokens técnicos de `modulo-productos` con `catalogo:leer` y `precios:leer`, audiencia `api-productos`, y upstreams Catalog/Pricing saludables. Los grants/credenciales reales de G7 no se simulan ni se inventan.
- `combos-svc.consultarDisponibilidadCombo`: usa la proyección de inventario recibida por eventos y requiere acreditar frescura/contrato de esa proyección antes de hacerla pública; las pruebas de RabbitMQ de la integración de Combos no acreditan por sí solas esa respuesta pública.
- `bulk-svc.descargarPlantillaProductos`: excluida por contrato de lectura pública; conserva frontera administrativa y autenticación.

La fila `consultarDisponibilidadComercial` de Inventory quedó comprobada sin abrir la lectura detallada ni el POST. Estas restricciones no afectan la capacidad de ejecutar `PUBLIC_READ_ONLY` con allowlists más pequeñas y explícitas. El estado de las 60 filas restantes impide declarar certificada toda la matriz de 66; no se reporta GO de despliegue mientras siga siendo criterio obligatorio.

## Autenticación de Fases 2 y 3

- Tokens humanos: RS256/JWKS, issuer seleccionado por `G6_SECURITY_MODE`, `tipo=acceso`, sujeto UUID, expiración y rol/permiso; no se inventa `aud` humano.
- Tokens de servicio entrantes: audiencia `api-productos`, issuer de la fase, `tipo=servicio`, expiración, cliente permitido y scope exacto.
- Para rutas G7 con `introspection: true`, Gateway obtiene token técnico como `modulo-productos`, valida su issuer/RS256/expiración/`tipo=servicio`/sujeto/scope y `aud=api-seguridad`, y valida la respuesta de introspección. Respuesta inactiva o `401` se rechaza; falta de scope/`403` se rechaza; configuración ausente, timeout y respuestas inválidas cierran con `503`.
- Las pruebas contractuales usan servidor local de prueba con claves RSA/JWKS, casos de firma, issuer, audiencia, expiración, actor y permisos incorrectos, y cambios de modo por configuración. No acreditan grants ni credenciales reales de G7.
- La prueba bilateral real de G7 para Fase 3 queda pendiente de Seguridad y Usuarios: registrar y conceder `tokens:introspeccion` a `modulo-productos`, audiencia `api-seguridad`, y proporcionar credencial técnica operativa. Eso no bloquea las lecturas Fase 1 aquí verificadas.
