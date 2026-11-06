# Revisión técnica — Fase 1 y preparación Azure

Estado operativo posterior: [Azure desplegado con consultas cerradas](DESPLIEGUE_AZURE_167090a.md)
y [evidencia real no secreta](AZURE_DESPLEGADO_167090a.json). Los tres servicios
y Caddy están en Azure usando el SHA oficial `167090af...`; HTTPS health responde
200. Las cinco consultas sin JWT siguen en 401. G7 real y aceptación pública
están pendientes. Los SHA y pruebas de la revisión inicial que siguen son históricos.

Código revisado: a51eb22f9704ac56eaad21a4b9ebd2c5729abd8e
Commit aplicación: dc9f9bfbb1206aee9d382e649818ad2ec9600547
Base oficial: 15941b6fa3e6f00e595995abca4b328da65ff73f
Rama: cueva. Seguimiento: Backend #144 y encargo transversal recibido el 05/11/2026.

## Orden sugerido

1. [INFORME.md](INFORME.md): alcance, archivos, resultados, límites y dependencias externas.
2. [PHASE1-REVIEW.md](../../../apps/api-gateway/PHASE1-REVIEW.md): contrato, cinco operationIds, configuración, comportamiento esperado y comandos reproducibles.
3. [diff de aplicación](diffs/application-phase1.patch): implementación completa de los tres servicios contra el SHA base, no solo el último commit incremental.
4. [unitarias](evidence/unit-final.txt) y [E2E](evidence/services-e2e-final.txt): resultados, casos condicionales omitidos y diagnóstico. No confundir estas pruebas con CI o integración G7 real.
5. [guía Azure](../README.md) y [diff de Azure](diffs/azure-preparation.patch): adaptación Azure, imágenes oficiales por digest/revisión, readiness y recuperación.
6. [precios de referencia](evidence/azure-chile-retail-prices.json) y el apartado de costos del informe: disponibilidad, cuotas, precio retail y pendientes de saldo/beneficios.

## Puntos de revisión y aceptación

- [ ] Las cinco operaciones coinciden exactamente con contratos, métodos, rutas y operationIds; ampliar exige revisión por operación.
- [ ] Las tres listas públicas están vacías por defecto; G7_AUTHENTICATED es default; las configuraciones contradictorias fallan al arrancar.
- [ ] PUBLIC_READ_ONLY permite solo lecturas configuradas y mantiene JWT normal para las demás rutas y escrituras autenticadas.
- [ ] Authorization inválido/expirado/de issuer o audiencia incorrectos no cae a acceso anónimo; scopes/roles insuficientes se rechazan.
- [ ] Taxonomy solo abre sus listas comerciales: administración, detalles privados e interfaces internas siguen protegidos.
- [ ] Catalog no activa demo, borradores ni preview; aplica elegibilidad antes del conteo/paginación y oculta variantes inactivas y detalles no elegibles.
- [ ] Detalles por ID/slug y filtros llaman a Taxonomy real sin fabricar identidades ni abrir sus rutas privadas; dependencia no autorizada produce 503.
- [ ] La suite conjunta usa PostgreSQL/TLS y servicios HTTP reales y comprueba que las lecturas/rechazos no alteran filas ni Inbox/Outbox.
- [ ] La reversión a G7_AUTHENTICATED solo cambia configuración/reinicio; los JWT de prueba no se presentan como credenciales reales G7.
- [ ] SIMULATED_AUTH queda cerrado mientras no esté homologado.
- [ ] Código y pruebas de aplicación son independientes de ops/azure; no hay cambios de esta implementación en ops/oracle ni configuración global.
- [ ] Azure usa los mismos artefactos oficiales que Oracle, verificados por digest y SHA OCI; el build del fork solo es desarrollo local.
- [ ] Revisar preflight de suscripción, SKU, cuota y costo; no aprovisionar con cotización o saldo pendientes.
- [ ] Distinguir rollback simulado del ejecutor de un rollback real en VM, todavía no ejecutado; revisar ambos casos: primer despliegue y actualización.
- [ ] Emitir aprobación normativa explícita por operación y autorización de release. La entrega no cambia el registro documental PUBLICA_APROBADA.

## Cómo reproducir

Los parches son diffs sin contexto y se aplican con `git apply --unidiff-zero` sobre un checkout del SHA base indicado. No aplicarlos sobre el fork antiguo ni sobre otro master sin revisar diferencias. El checkout resultante permite usar los comandos de [PHASE1-REVIEW.md](../../../apps/api-gateway/PHASE1-REVIEW.md). Usar dependencias de package-lock con npm ci y la versión Node admitida por package.json. Docker y OpenSSL son necesarios para las pruebas reales desechables; no usar la base compartida. En Windows, poner OpenSSL en PATH para las suites existentes o G6_TEST_OPENSSL para la nueva suite.

Comandos generales usados: node ./node_modules/vitest/vitest.mjs run --maxWorkers=2; npm run test:e2e -- apps/api-gateway apps/catalog-svc apps/taxonomy-svc --no-file-parallelism; npm run typecheck; npm run lint; builds de los tres servicios. Azure: node --test ops/azure/tests/*.test.mjs y pwsh ./ops/azure/tests/provision.test.ps1.

## Contenido publicado y acceso

Esta carpeta publica la guía, informe, diffs y logs para revisión en el fork. El código de aplicación revisado es a51eb22f9704ac56eaad21a4b9ebd2c5729abd8e; el commit que añade esta carpeta solo publica documentación y evidencias. No hay PR ni merge al Backend principal ni despliegue público.

Los logs se publican con rutas locales sustituidas por `<workspace>`, conservando los resultados. No se publican sesiones Azure CLI, tokens, runtime.env, claves privadas ni información de restauración de otros proyectos.

## Enlaces directos

- [Código de aplicación](https://github.com/AXL031/G6-Productos-Ofertas-backend/tree/a51eb22f9704ac56eaad21a4b9ebd2c5729abd8e/apps)
- [Comparación completa contra master incorporado](https://github.com/AXL031/G6-Productos-Ofertas-backend/compare/15941b6fa3e6f00e595995abca4b328da65ff73f...a51eb22f9704ac56eaad21a4b9ebd2c5729abd8e)
- [Índice y hashes de evidencias](evidence/index.json)
- [Preflight Azure simulado](evidence/azure-preflight-tests.txt)

- [Pruebas del ejecutor y emisor local](evidence/azure-tests.txt)
