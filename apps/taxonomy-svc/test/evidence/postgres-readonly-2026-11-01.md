# Trazabilidad — postgres-readonly-2026-11-01.json

| Campo | Valor |
|---|---|
| Servicio / owner | `taxonomy-svc` / López |
| Issue | #22 |
| `operationId` cubiertos | `listarCategorias`, `listarMarcas` |
| SHA ejecutado (`git rev-parse HEAD`) | `cbf76d48a888c70048d6214e3f89a5aafd10da9d` |
| Inicio del reporte (UTC) | 2026-11-01T20:48:37.323Z |
| Equivalente local | 2026-11-01 15:48:37 -05:00 |
| Node.js | v24.22.0 |
| npm | 11.19.1 |
| vitest | 4.1.11 |
| Sistema operativo | Windows |
| Base de datos | Supabase `slzglmtiyrzygpkiuthf`, Session Pooler, schema `taxonomy` |
| Identidad | `taxonomy_dev_login` (sin privilegios de superusuario) |
| TLS | `PGSSLMODE=verify-full` con CA raíz local |
| Escrituras | Ninguna; solo `SELECT` |
| Resultado | 2/2 PASS (`success: true`) |

El JSON se generó con el siguiente comando, ejecutado sobre un árbol limpio en el SHA indicado. La única modificación posterior fue sanear la ruta absoluta local del campo `testResults[].name` a `apps/taxonomy-svc/test/postgres.readonly.e2e-spec.ts`.

```powershell
$env:G6_READONLY_INTEGRATION = 'taxonomy'
node --env-file=apps/taxonomy-svc/.env.local ./node_modules/vitest/vitest.mjs run --config ./vitest.config.e2e.ts apps/taxonomy-svc/test/postgres.readonly.e2e-spec.ts --reporter=json --outputFile=apps/taxonomy-svc/test/evidence/postgres-readonly-2026-11-01.json
```

No se registran credenciales, cadenas de conexión ni rutas privadas. Esta evidencia acredita una ejecución local contra PostgreSQL; no acredita despliegue, autorización G7 ni E2E.
