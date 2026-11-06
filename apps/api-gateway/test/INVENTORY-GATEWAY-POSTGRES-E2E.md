# Gateway → Inventory → PostgreSQL E2E

This opt-in suite starts the current compiled Inventory application, a real HTTP Gateway module with the production `GatewayIdentity`, and an isolated PostgreSQL 17 container. It applies the official Inventory base and incremental migrations plus the current lifecycle migration, then inserts only test-owned location, route, and stock fixtures. RabbitMQ is not needed for these read-only operations.

## Run locally

Use a repository-supported Node version (`^22.22.3 || >=24.15.0`) and ensure Docker is running. From the backend root:

```powershell
npm.cmd run build:api-gateway
npm.cmd run build:inventory-svc
$env:G6_INVENTORY_GATEWAY_POSTGRES_E2E = '1'
node_modules/.bin/vitest run --config ./vitest.config.e2e.ts --exclude 'node_modules/**' apps/api-gateway/test/inventory-postgres.gateway.e2e-spec.ts --maxWorkers=1
```

The harness reuses `Phase1Postgres`, labels its container, binds only to loopback, verifies PostgreSQL 17, and cleans up only that owned container and its temporary certificate directory. Set `G6_DOCS_ROOT` only when the sibling `../docs` checkout is elsewhere.

## Authentication and coverage

The suite creates one local RSA-2048 keypair. The same signed JWT is verified by the real Gateway `SignedIdentityVerifier` through a local JWKS endpoint and Inventory's real `InventoryAuthGuard` using the matching public PEM. It uses `iss=https://isolated.test/issuer`, `aud=api-productos`, service tokens, actual per-route client allowlists, and `inventario:disponibilidad:leer`. It does not claim G7 credentials or homologation.

Gateway demo no-auth and read-only demo flags are false; the security mode is `G7_AUTHENTICATED`; Inventory demo no-auth is false. The test does not override `GatewayIdentity`, `InventoryAuthGuard`, provider HTTP, or the database provider.

It covers authenticated GET for `modulo-productos` on MARKETPLACE; authenticated commercial POST for `modulo-marketplace`; the three nonbinding results; modulo-productos POST rejection; absent, malformed and invalid-signature JWTs; wrong client and scope; channel/client mismatches; 400 and 422 Problem Details; correlation headers; an actual PostgreSQL permission error with sanitized internal response; and a real unavailable Inventory HTTP upstream. It snapshots the test balances and counts of reservations, operations, and Kardex around valid POST checks. The snapshot is unchanged.

The suite does not claim a real 429: no actual rate-limit condition is configured or triggered.

## Finding for Inventory owner Taco

With PostgreSQL stopped while Inventory remains running, direct Inventory HTTP and the Gateway-routed GET both returned **500 `ERROR_INTERNO`**, not the expected **503 `SERVICIO_NO_DISPONIBLE`**. The response was sanitized. The test restarts the isolated database and Inventory process before cleanup.

Reproduction is the opt-in test `caracteriza la respuesta real de Inventory ante caída PostgreSQL y recupera el servicio`. It uses the real `inventory-svc` compiled from the tested checkout, not a provider stub. A separate test confirms Gateway returns 503 when the Inventory HTTP process itself is stopped.

The handling gap is in Inventory, outside this PR's authorized code scope: [`ProblemDetailsFilter`](../../inventory-svc/src/errors/problem-details.filter.ts) checks only the top-level exception's `code` against the PostgreSQL unavailable-code set. The production Drizzle version wraps the PostgreSQL error in `DrizzleQueryError.cause`; the wrapper has no top-level PostgreSQL code, so the filter classifies the real database outage as `ERROR_INTERNO`. Owner: Taco. A fix should preserve sanitization while recognizing the wrapped connection failure and return the contractual 503; rerun this E2E after the Inventory change.

This is local integration evidence only. It does not establish G7 provisioning/homologation, CI status for this commit, Oracle deployment, or production readiness.
