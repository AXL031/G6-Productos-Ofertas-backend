# Entrega para auditoría — Fase 1 y Azure

RAMA Y ISSUE: cueva | Backend #144 y encargo transversal recibido el 05/11/2026.
BASE OFICIAL: 15941b6fa3e6f00e595995abca4b328da65ff73f.
BASE ACTUALIZADA EN FORK: eb148527b97d5076ebd0beeb73a01d3d4a2d5f33.
COMMIT APLICACIÓN: dc9f9bfbb1206aee9d382e649818ad2ec9600547
COMMIT FINAL: a51eb22f9704ac56eaad21a4b9ebd2c5729abd8e

CAMBIOS REALIZADOS: cinco lecturas públicas explícitas y vacías por defecto; JWT normal para las demás rutas y para Authorization suministrado; elegibilidad comercial sin demo; Taxonomy administrativa cerrada; SIMULATED_AUTH no homologado rechazado; reversión por configuración. Aplicación y pruebas independientes de Azure. Azure requiere imágenes oficiales por digest/revisión, readiness y preflight de costo/cuota, con rollback por servicio.

COMANDOS EJECUTADOS:
- node ./node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=dot: PASS, 2236 pruebas; 66 omitidas y 2 suites condicionales omitidas.
- npm run test:e2e -- apps/api-gateway apps/catalog-svc apps/taxonomy-svc --no-file-parallelism --reporter=dot, con OpenSSL en PATH: PASS, 907 pruebas; 86 omitidas y 5 suites condicionales omitidas.
- La nueva suite conjunta: PASS, 9 escenarios con HTTP real de los tres componentes, PostgreSQL 17 desechable, TLS verify-full y JWT RS256/JWKS HTTPS locales. No se sustituyeron guards, repositorios ni Taxonomy en esta suite. Snapshots de filas/Inbox/Outbox sin cambios.
- node --test ops/azure/tests/*.test.mjs: PASS, 10 pruebas; Docker/HTTP del ejecutor son simulados. No se afirma recuperación real de VM.
- pwsh ./ops/azure/tests/provision.test.ps1: PASS, 9 escenarios offline con CLI simulado; no crea recursos.
- node ./node_modules/typescript/bin/tsc --build --noEmit: PASS.
- npm run lint: PASS.
- Prettier --check de todos los TS modificados/nuevos: PASS.
- node ./node_modules/@nestjs/cli/bin/nest.js build api-gateway/catalog-svc/taxonomy-svc (tres invocaciones): PASS.
- Parseo PowerShell, bash -n de scripts Azure y git diff --check 15941b6 HEAD: PASS.

Incidencias corregidas del entorno: Vitest EPERM bajo sandbox se resolvió ejecutando fuera de él; timeout de Bulk bajo paralelismo alto pasó aislado y en la ejecución general final; OpenSSL ausente de PATH se resolvió sin cambios de pruebas de otro owner. No quedan fallos obligatorios locales conocidos.

ERRORES PENDIENTES: ninguno de los controles locales ejecutados. CI del SHA final, Docker oficial y release remoto NO EJECUTADOS.
DEPENDENCIAS EXTERNAS:
- Marco/Arquitectura | publicar las cinco candidatas/activar Fase 1 | revisión técnica, aprobación normativa por operación y autorización individual de release. La matriz Docs consultada sigue con cero PUBLICA_APROBADA; esta entrega no la modifica.
- CI/operador | artefactos compartidos Oracle/Azure | revisión/PR oficial, CI del SHA y manifiesto aprobado de digests oficiales.
- G7/operador | integración autenticada real | issuer/JWKS, clientes/grants/credenciales y prueba bilateral. Los tokens locales de prueba no son G7.
- Titular Azure | gasto neto antes de aprovisionar | saldo y cantidades gratuitas verificados en su oferta/Sponsorships más revisión de costo. Chile Central/B2ats_v2 tiene disponibilidad y cuota verificadas; precio retail de referencia en azure-operational-review.md.

CAMBIOS FUERA DEL ALCANCE: ninguno de código respecto al encargo ampliado. No se editaron ops/oracle, .github ni configuraciones globales respecto al master incorporado. La pausa de otros servicios Azure y downgrade de ACR fueron autorizados posteriormente por el usuario y se documentan fuera del repositorio, con restauración disponible.
ESTADO FINAL: implementación/pruebas locales PASS; preparación de release y despliegue PARTIAL por gates externos. La publicación de los commits en el fork fue solicitada posteriormente por el usuario. Sin PR, merge principal ni despliegue público.

## Archivos de la entrega respecto al master actualizado
- apps/api-gateway/PHASE1-REVIEW.md
- apps/api-gateway/src/routing/gateway-identity.ts
- apps/api-gateway/src/routing/gateway-public-reads.spec.ts
- apps/api-gateway/src/routing/gateway-public-reads.ts
- apps/api-gateway/src/routing/gateway-read-demo.spec.ts
- apps/api-gateway/src/routing/gateway-settings.ts
- apps/api-gateway/test/fixtures/phase1-taxonomy-0001.sql
- apps/api-gateway/test/public-read-only.e2e-spec.ts
- apps/api-gateway/test/support/phase1-postgres.ts
- apps/catalog-svc/src/catalog-auth.ts
- apps/catalog-svc/src/catalog-public-reads.spec.ts
- apps/catalog-svc/src/catalog-read-demo.spec.ts
- apps/catalog-svc/src/catalog-read-demo.ts
- apps/catalog-svc/test/support/jwt-fixture.ts
- apps/taxonomy-svc/src/taxonomy-auth.ts
- apps/taxonomy-svc/src/taxonomy-public-reads.spec.ts
- apps/taxonomy-svc/src/taxonomy-svc.module.ts
- apps/taxonomy-svc/src/taxonomy.controller.spec.ts
- ops/azure/Caddyfile
- ops/azure/README.md
- ops/azure/bootstrap-vm.sh
- ops/azure/build-and-deploy-three.sh
- ops/azure/demo-jwt-issuer.d.ts
- ops/azure/demo-jwt-issuer.mjs
- ops/azure/deploy-g6-service.sh
- ops/azure/deploy-official-three.sh
- ops/azure/docker-compose.caddy.yml
- ops/azure/provision-azure-vm.ps1
- ops/azure/test-rollback-and-phases.sh
- ops/azure/tests/demo-jwt-issuer.test.mjs
- ops/azure/tests/deploy.test.mjs
- ops/azure/tests/provision.test.ps1

## Evidencias de revisión

Los logs, diffs separados y hashes están en esta carpeta. El código funcional permanece en el SHA a51eb22. CI, homologación y autorización de release siguen pendientes.

## Azure: verificación previa, no autorización de aprovisionamiento

Suscripción estudiantil Enabled con límite de gasto activado. En la consulta del 05/11/2026, Standard_B2ats_v2 estaba disponible sin restricciones en Chile Central; cuotas: 0/6 vCPU regionales usadas y 0/10 en standardBasv2Family. VM de 2 vCPU y 1 GiB RAM: aún requiere prueba de capacidad de las tres imágenes y Caddy.

Precio retail Linux 0.0132 USD/h, SSD E4 LRS 3.36 USD/mes e IPv4 Standard 0.005 USD/h. A 730 horas: base 16.646 USD/mes, sin IO, transferencia ni otros medidores aplicables. El JSON publica la respuesta de precios de referencia. No acredita el saldo ni la aplicación efectiva de beneficios estudiantiles; ambos deben verificarse antes de crear recursos. No se publicó un CostReviewPath aprobado ni se aprovisionó una VM.
