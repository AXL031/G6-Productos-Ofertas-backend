# BULK-JOINT local v2

Run the disposable integration from the repository root on Windows:

```powershell
$env:PATH = 'C:\Program Files\Git\usr\bin;' + $env:PATH
node apps/bulk-svc/test/support/run-bulk-joint-v2-local.mjs
```

Requirements: Docker Desktop running, Node dependencies installed, and Git for Windows OpenSSL available at the path above (or another `openssl` executable on `PATH`). The Catalog harness generates a one-day localhost certificate with `openssl req -x509`, starts PostgreSQL 17 with TLS verification enabled, and starts RabbitMQ 4.2.9. TLS verification is not disabled.

The runner copies the Catalog E2E spec into a temporary directory beneath `apps/bulk-svc/test`, rewrites only that copy's imports, and injects the Bulk-owned integration case. It reads Catalog sources and fixtures without writing to `apps/catalog-svc`; temporary files and containers are removed after the run.

The Catalog test process hosts the real CatalogBulkService and Catalog AMQP runtime. Separate Bulk peer processes compile and run the real `BulkImportService`, Outbox relay, and result Inbox consumer. The script runs v1 regression and v2 scenarios: successful variant update, missing SKU, foreign SKU, stale variant version, and replay of the original Outbox command. It checks the Catalog result envelope is v1, Catalog Inbox deduplication, Catalog variant and version persistence, and that the ACTUALIZACION snapshot completes with only the required Catalog step; Inventory is not part of the update workflow.

## DATA-002 local and CI timing observation

For the audited PR HEAD, GitHub CI reported `validates the DATA-002 batch in disposable PostgreSQL` as PASS in 2,201 ms on its `ubuntu-latest` runner with Node 24.15.0. The local Windows/Docker Desktop run had previously been reported to time out. In this review, the targeted local Vitest run passed in 24,670 ms with Node 24.3.0. The operating system, runtime version, and observed timings differ; no controlled same-runner comparison is available, so these observations alone do not establish a regression or a pre-existing failure. Keep Catalog sources and test timeouts unchanged; investigate only with new comparable timing evidence.
