# H4: integración local Gateway–Taxonomy–PostgreSQL

## Alcance

Prueba HTTP local y reproducible de `cliente HTTP → api-gateway → taxonomy-svc → PostgreSQL 17 desechable` para `GET /api/v1/tipos-producto` (`listarTiposProducto`). No usa upstream HTTP simulado, fixtures de respuesta ni repositorio en memoria. No modifica el código ni la configuración de Taxonomy.

El Gateway arranca su `ApiGatewayModule` real con el parser de configuración real, ligado explícitamente a loopback para que el puerto de prueba no se publique en la red. Taxonomy arranca mediante `iniciarTaxonomySvc()` y su `TaxonomySvcModule.forRuntime()`, con `Database`, guard JWT y persistencia reales.

## Arquitectura

```text
Cliente HTTP local
  └─ HTTP 127.0.0.1 → ApiGatewayModule real
       ├─ verifica RS256 con issuer/JWKS HTTPS local
       └─ HTTP privado de prueba 127.0.0.1 → taxonomy-svc real
            ├─ verifica issuer/discovery/JWKS y firma RS256
            └─ PostgreSQL 17 efímero, TLS verify-full, schema taxonomy
```

El issuer, la CA, los certificados, la clave privada, el token, la contraseña PostgreSQL, el contenedor y el directorio temporal se generan para cada ejecución. El token local solo prueba la verificación criptográfica de ambas implementaciones; no representa un token ni un grant de G7.

## Requisitos y ejecución

Versiones observadas durante la ejecución local: Node `24.15.0`, npm `11.4.2`, Docker Engine `29.9.2`; imágenes `postgres:17-alpine` y `alpine:3.22` (esta última genera certificados efímeros con OpenSSL). El runner valida la versión de Node declarada en `package.json`.

Con dependencias instaladas y Docker activo, desde la raíz del backend:

```powershell
npm exec --yes --package=node@24.15.0 -- node apps/api-gateway/test/run-taxonomy-postgres-gateway.mjs
```

La suite usa una configuración Vitest dedicada para que el `npm run test:e2e` general no intente iniciarla sin el PostgreSQL efímero que prepara este runner.

El runner levanta PostgreSQL 17 con puerto publicado solo en `127.0.0.1`, certificado TLS con SAN para loopback y un identificador de instancia aleatorio. La prueba acredita en vivo la identidad del contenedor antes de ejecutar el DDL existente de `apps/taxonomy-svc/test/ddl-taxonomy-prueba.ts`; aplica además la migración local `0005_configurable_list_values.sql` y carga tres tipos deterministas (`ACTIVO`, `INACTIVO`, `PENDING_DEACTIVATION`).

Taxonomy conecta con `PGSSLMODE=verify-full`, CA explícita y rol `taxonomy_app`. El emisor local se sirve por HTTPS; los procesos de prueba confían únicamente en la CA efímera mediante `NODE_EXTRA_CA_CERTS`. Se fijan explícitamente `GATEWAY_DEMO_NO_AUTH_ENABLED=false`, `G6_READ_ONLY_DEMO_ENABLED=false` y `ALLOW_DEMO_UNAUTHENTICATED=false`.

El runner espera la salida de Vitest y, pase o falle, comprueba las etiquetas aleatorias del contenedor antes de eliminarlo. El `finally` elimina también el directorio temporal verificado. La suite cierra el Gateway, Taxonomy, el issuer HTTPS y sus pools. No ejecuta `docker rm` contra recursos que no acrediten pertenecer al harness.

## Variables usadas

El runner establece internamente, sin requerir secretos del usuario:

- `TAXONOMY_TEST_DATABASE_URL`, `TAXONOMY_TEST_HARNESS_ID` y `TAXONOMY_TEST_DB_ACK` para la acreditación existente.
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE=verify-full`, `PGSSLROOTCERT`, `G6_DATABASE_SCHEMA`, `G6_EXPECTED_ROLE` y `G6_CONNECTION_MODE` para Taxonomy.
- `AUTH_ISSUER`, `AUTH_JWKS_URL`, `SECURITY_ISSUER`, `SECURITY_DISCOVERY_URL` y `SECURITY_JWKS_URL` apuntan únicamente al issuer HTTPS local.
- `GATEWAY_TAXONOMY_SVC_URL` apunta al proceso local de Taxonomy.

La evidencia no contiene valores de esas variables, tokens, claves privadas ni URLs con credenciales.

## Matriz y evidencia

La ejecución local registrada en el SHA histórico indicado abajo completó **10/10 pruebas PASS, 0 FAIL y 0 SKIP** con cliente HTTP, Gateway, Taxonomy y PostgreSQL real. El runner informa la versión exacta de PostgreSQL y confirma la limpieza al terminar.

| Caso                                                              | Resultado observado                                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| JWT humano RS256 válido, UUID, audiencia y rol `GESTOR_COMERCIAL` | `200`; incluye filas que una consulta directa verifica en PostgreSQL                                      |
| Bearer válido propagado Gateway → Taxonomy                        | Observado en `undici:request:create`; el `200` también demuestra aceptación por el guard real de Taxonomy |
| Sin `Authorization`                                               | `401` en Gateway; no hay petición al upstream                                                             |
| Firma inválida                                                    | `401` en Gateway y `401` en solicitud directa al guard real de Taxonomy                                   |
| Issuer incorrecto                                                 | `401` en Gateway; no hay petición al upstream                                                             |
| Audiencia incorrecta                                              | Gateway reenvía la identidad y Taxonomy responde `401`                                                    |
| Usuario sin `GESTOR_COMERCIAL`                                    | `403` en Gateway antes del upstream                                                                       |
| Página inválida o tamaño 201                                      | `400` validado por Taxonomy                                                                               |
| Lista vacía                                                       | `200` con `items: []` y metadatos coherentes; conteo confirmado directamente en PostgreSQL                |
| Paginación                                                        | `200`, segunda página coherente y orden determinista basado en las filas PostgreSQL                       |
| `X-Correlation-Id`                                                | El Gateway devuelve y propaga el UUID observado en la petición upstream                                   |
| Tabla temporalmente indisponible                                  | `503` genérico sin SQL, nombre de tabla, credencial ni JWT                                                |
| Taxonomy detenida                                                 | `503` desde Gateway sin error de socket ni credenciales filtrados                                         |

El JSON completo de Vitest se crea dentro del directorio temporal y se elimina al terminar; la salida conservada muestra SHA, versiones de runtime, conteos, fase del fallo y estado de cleanup, sin secretos. Cada caso reinicia sus filas deterministas y la suite es secuencial; el caso que cierra Taxonomy queda al final para que no afecte casos posteriores.

**Evidencia histórica:** `d0ae90296a4454a49105e65e3f8552284cbbaced` (`castilla`): 10/10 PASS, 0 FAIL, 0 SKIP con PostgreSQL `17.11` y cleanup confirmado. Esta evidencia no acredita el HEAD posterior `d756d0a88ece298095d72461ad24b63db27dc0f1`; la nueva ejecución se registrará junto al SHA exacto en el PR. Una prueba local no acredita CI, despliegue ni homologación.

## Contratos y discrepancias

Contrato contrastado: OpenAPI de `Taller-SW-Web/G6-Productos-Ofertas-docs` en `origin/master` SHA `80f208978c2c703e2b2d62064112365e7b9e1677`, versión `0.6.0-rc.3`. La operación `GET /tipos-producto` declara los esquemas `userBearer` y `serviceBearer`, `$ref` al parámetro `Tamanio` (máximo `200`) y esquema `TipoProductoAdmin.estado` basado en `EstadoEntidad` (`ACTIVO`, `INACTIVO`). El Gateway actualmente declara solo `userBearer`, por lo que existe una discrepancia contractual en el esquema de seguridad de la operación. El código de Taxonomy también admite y devuelve `PENDING_DEACTIVATION`; la prueba lo observa en PostgreSQL y HTTP. No se cambió OpenAPI.

Taxonomy marca el GET con `AllowTaxonomyServiceRead()` y su guard admite la identidad de servicio `modulo-productos` con `catalogo:leer`; el Gateway solo declara `userBearer` aunque OpenAPI también documenta `serviceBearer`. El harness prueba la ruta humana ya autorizada; no amplía la allowlist ni habilita service bearer en Gateway.

La discrepancia “OpenAPI máximo 100 frente a backend 200” **no aplica a esta operación** en el contrato actual: `/tipos-producto` referencia `Tamanio`, cuyo máximo es 200, coincidente con el controlador. La prueba confirma que `tamanio=101` funciona y `tamanio=201` produce `400`. El máximo 100 presente en otros endpoints no se extrapola a este.

## Límites y siguiente paso

- El issuer y JWT son efímeros y locales; no prueban identidad, grants ni homologación de G7.
- No se desplegó en Oracle; los resultados pertenecen a la ejecución local del SHA indicado.
- No ejecuta el navegador de Frontend PR #67. El siguiente paso es conectar el cliente de esa PR al Gateway y validar el recorrido de navegador con la identidad y el entorno autorizados para esa integración.
- El harness no modifica las rutas, roles, DTOs, contratos ni reglas de negocio de Gateway o Taxonomy.
