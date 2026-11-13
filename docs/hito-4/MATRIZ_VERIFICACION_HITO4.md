# Matriz de verificación H4

Fecha local 2026-11-07. Rama `integracion-hito-4` sobre `b061ef86ec63a06ba626c3f7a66c94cd7fc270db`. Las pruebas locales se ejecutaron antes de publicar la rama. Contratos Docs en `aba8d1ca998cfcd2db1c4fa87654036a5a4c1ac1`.

| Comando o prueba | Resultado | Alcance |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | PASS, 378 paquetes | Instalación del lockfile base, sin cambios de dependencias. |
| `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build:all` | PASS | Una advertencia preexistente del fixture AMQP de Bulk. |
| `npm test -- --maxWorkers=3` | PASS, 2.577 pruebas y 72 omitidas por configuración existente | OpenSSL de Git for Windows. |
| Suites enfocadas de Inventory G7, Bulk, Taxonomy, Promotions y Price Audit | PASS, 75 pruebas | Grants locales, admisión y recuperación Bulk, logo en volumen temporal, identidad de mutación y precisión decimal. |
| `npm run test:e2e -- --maxWorkers=2` con Gateway routing, Inventory HTTP y Price Audit HTTP | PASS, 503 pruebas | RS256 local, controles negativos, transporte, lectura de auditoría con nulos y opt-in de traslados. |
| `probar-catalogo-postgres.ps1` con `CombosBaselineMigration` | PASS, 1 caso de Catálogo y 9 de Combos | PostgreSQL 16.15 TLS descartable. Catálogo reabre y edita borrador. Combos pasa replay concurrente y conflicto 409 con otra intención. |
| Consultas compiladas de Pricing e Inventory contra PostgreSQL 16.15 TLS | PASS | Pricing distingue versión global y Retail y ausencia de definición exacta. Inventory prueba umbral, ubicación, filtro de estado antes de paginar y total de página fuera de rango. |
| `node apps/promotions-svc/test/persistence.isolated.smoke.mjs` con PostgreSQL nativo y `G6_PROMOTIONS_GATEWAY_E2E=true` | PASS | SQL normativo con checksum, CRUD y composición vía Gateway. Proveedores de comercio y emisor RS256 son fixtures explícitos de loopback. |
| `CI=true npm run test:e2e -- --maxWorkers=3` | FAIL, 923 pruebas aprobadas, 266 omitidas y cinco suites fallidas | Docker ausente en fase 1 del Gateway, caída PostgreSQL de Bulk, DATA-002, persistencia de Catálogo y RabbitMQ de Catálogo. |
| `node docs/hito-4/verificar-compatibilidad.mjs` y `git diff --check` | PASS | 135 rutas principales y una condicional de fase 1 conservadas, ocho rutas candidatas y 40 canales AsyncAPI en la referencia. Las referencias JSON de los cinco candidatos fueron verificadas. |

## Evidencia independiente

- [Implementación local](IMPLEMENTACION_BACKEND_DEMO_ADMIN.md) y [comparación contractual](compatibilidad-gateway.json).
- La migración de recibos de Combos se probó únicamente contra PostgreSQL descartable.
- Las pruebas locales usaron claves y proveedores de prueba. G7 real, grants, homologación intermodular, CI remoto y despliegue requieren evidencia independiente. [Dependencias y owners](DEPENDENCIAS_EXTERNAS_Y_OPERATIVAS.md).
