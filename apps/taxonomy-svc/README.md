# taxonomy-svc

Microservicio de taxonomía (categorías y marcas) del backend G6.

## Variables de entorno

El servicio valida la configuración en el arranque y falla cerrado (`fail-closed`): si falta o es inválida alguna variable requerida, no inicia. Nunca imprimir ni registrar valores reales; las credenciales se enmascaran en los logs.

| Nombre | Descripción | Requerido | Valor por defecto |
|---|---|---|---|
| `NODE_ENV` | Entorno de ejecución. Debe ser uno de `development`, `test`, `production`. | Sí | Ninguno |
| `TAXONOMY_SVC_PORT` | Puerto HTTP del servicio. Entero entre 1 y 65535. | Sí (o `PORT`) | Ninguno |
| `PORT` | Puerto HTTP alternativo; se usa solo si no se define `TAXONOMY_SVC_PORT`. | No | Ninguno |
| `DATABASE_URL` | Fuente opcional de parámetros PostgreSQL. Alternativamente se pueden proporcionar `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` y `PGSSLROOTCERT`. Los valores presentes en la URL tienen precedencia. | No, si se proporcionan los parámetros PG | Ninguno |
| `G6_DATABASE_SCHEMA`, `G6_EXPECTED_ROLE`, `G6_CONNECTION_MODE` | Schema `taxonomy`, rol permitido y modo `direct` o `session`. El schema también puede venir en la URL. | Sí | Ninguno |

El pool requiere todos los parámetros PG indicados, `PGSSLMODE=verify-full` y una CA absoluta legible; la URL puede suministrar los valores correspondientes. El arranque valida además la identidad efectiva antes de escuchar.

## Endpoints operativos

- `GET /health`: liveness estático; responde `200` sin consultar dependencias.
- `GET /health/readiness`: readiness; verifica acceso de lectura real con dos consultas Drizzle ORM independientes (sin concatenar SQL), cada una con `WHERE estado = 'ACTIVO' LIMIT 1`:
  - `taxonomy.categories`: selecciona `id`, `nombre`, `categoria_padre_id`, `orden`, `estado`. `orden` se incluye porque la lectura comercial productiva lo usa en `ORDER BY`.
  - `taxonomy.brands`: selecciona `id`, `nombre`, `descripcion`, `pais_origen_iso`, `logo_url`, `estado`.

  Responde `200` solo si ambas consultas resuelven, o `503` (problem+json, `SERVICIO_NO_DISPONIBLE`) ante cualquier error: conexión fallida, permisos denegados (`42501`) sobre las columnas consultadas —incluidas `categories.orden` y `brands.logo_url`—, o tabla/columna ausente.

## Persistencia

**Alcance parcial del issue #35:** los mapeos Drizzle cubren categorías y marcas de las 12 tablas del modelo físico. Queda pendiente mapear las otras diez tablas y validar la persistencia contra las migraciones oficiales; el fixture aislado de estas pruebas no ejecuta dichas migraciones. Este avance no cierra el issue #35.

- Driver `drizzle-orm` sobre `pg` (`node-postgres`).
- Esquema en `src/persistence/taxonomy.schema.ts`: `taxonomy.categories` y `taxonomy.brands` mapeadas al modelo físico, incluido el enum `taxonomy.estado_entidad` y la columna generada `nombre_normalizado`.
- `DrizzleTaxonomyRepository` implementa `TaxonomyRepository` y `TaxonomyReadinessIndicator`; las lecturas filtran por `estado = 'ACTIVO'`.
- Con `DATABASE_URL` definida el módulo usa el repositorio Drizzle; sin ella usa `UnconfiguredTaxonomyRepository` (responde `503`). Los fallos de conexión se traducen a `503 SERVICIO_NO_DISPONIBLE`; el resto se propaga y el filtro lo sanitiza como `500 ERROR_INTERNO`.
- Las escrituras se agrupan con `enTransaccion` (commit/rollback) y el pool se cierra al apagar la aplicación (`onApplicationShutdown`).

## Pruebas de integración (Postgres aislado)

`scripts/ci/run-taxonomy-integration.mjs` aprovisiona y elimina su propio contenedor `postgres:17-alpine`, publica el puerto solo en loopback y genera la URL/credenciales internamente. Rechaza `TAXONOMY_TEST_DATABASE_URL` recibida desde el entorno. PostgreSQL se inicia con un identificador aleatorio de sesión que el preflight coteja mediante `current_setting()` antes de permitir cualquier DDL; un testigo insertado en una URL recibida no se considera acreditación. No apuntar pruebas destructivas a Supabase ni a bases compartidas.

```sh
node scripts/ci/run-taxonomy-integration.mjs
```

La suite crea esquema, roles y datos de prueba únicamente en el contenedor gestionado por el runner, verifica permisos efectivos (positivos y negativos), transacciones (commit/rollback), readiness y el camino `503`, y elimina contenedor y esquema al finalizar.

## Prueba de solo lectura contra PostgreSQL real

`test/postgres.readonly.e2e-spec.ts` ejecuta el handler HTTP real con el provider PostgreSQL/Drizzle instalado y comprueba, sin escribir, que la proyección de `GET /api/v1/categorias` y `GET /api/v1/marcas` coincide con los conteos de filas `ACTIVO` y solo expone campos contractuales, y que `GET /api/v1/categorias?estado=INACTIVO` responde `400 VALIDACION` con ese provider.

La prueba solo se ejecuta con `G6_READONLY_INTEGRATION=taxonomy` y requiere las variables `PG*`/`G6_*` de `apps/taxonomy-svc/.env.local` (ignorado por git; nunca se commitea) con `PGSSLMODE=verify-full`, el certificado raíz en `PGSSLROOTCERT` y la identidad `taxonomy_dev_login`. Solo hace `SELECT`; no apuntar pruebas destructivas a Supabase ni a bases compartidas.

El archivo `.env.local` se carga con `node --env-file` (Node interpreta correctamente las comillas del archivo) y la corrida debe declarar explícitamente `G6_READONLY_INTEGRATION=taxonomy`, generar el reporte JSON y fijar su ruta de salida. Sin esas tres piezas, vitest omite la suite y no produce evidencia.

PowerShell (Windows):

```powershell
$env:G6_READONLY_INTEGRATION = 'taxonomy'
node --env-file=apps/taxonomy-svc/.env.local ./node_modules/vitest/vitest.mjs run --config ./vitest.config.e2e.ts apps/taxonomy-svc/test/postgres.readonly.e2e-spec.ts --reporter=json --outputFile=apps/taxonomy-svc/test/evidence/postgres-readonly-AAAA-MM-DD.json
```

`sh` (Linux/macOS/Git Bash):

```sh
G6_READONLY_INTEGRATION=taxonomy node --env-file=apps/taxonomy-svc/.env.local ./node_modules/vitest/vitest.mjs run --config ./vitest.config.e2e.ts apps/taxonomy-svc/test/postgres.readonly.e2e-spec.ts --reporter=json --outputFile=apps/taxonomy-svc/test/evidence/postgres-readonly-AAAA-MM-DD.json
```

La corrida debe reportar `3 passed` y escribir el JSON. Incluye el arranque real con entorno explícito y comprueba los probes con la conexión disponible y después de cerrar el pool. La trazabilidad de la ejecución (SHA, fecha, versiones y comando) se registra en el sidecar `test/evidence/postgres-readonly-AAAA-MM-DD.md`. Esta prueba no acredita autorización G7, despliegue ni E2E desplegado.

## Verificación de configuración y probes (#34)

Pruebas enfocadas de configuración fail-closed, redacción de secretos y separación liveness/readiness:

```sh
npm test -- apps/taxonomy-svc/src/config/environment.spec.ts apps/taxonomy-svc/src/bootstrap.spec.ts apps/taxonomy-svc/src/logging/sanitized-logger.spec.ts apps/taxonomy-svc/src/database.spec.ts
npm run test:e2e -- apps/taxonomy-svc/test/readiness.e2e-spec.ts apps/taxonomy-svc/test/app.e2e-spec.ts
npm run build:taxonomy-svc
```

El arranque real exige las variables privadas descritas arriba y verifica la identidad PostgreSQL antes de escuchar. Registra la evidencia de cada ejecución local con SHA, fecha, versiones, comandos y resultados; esta no acredita despliegue Oracle, homologación externa ni E2E desplegado.
