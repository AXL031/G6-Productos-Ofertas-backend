# Ejecución del primer incremento Service Bus H5

> Corte histórico local, anterior a la prueba cloud. La continuación solicitada por Axel desplegó infraestructura y validó Azure real; ver [informe actualizado](EJECUCION_AZURE_SERVICE_BUS.md). Los hashes y resultados de este corte conservan su fecha y no describen la corrección binaria posterior.

Fecha: **2026-11-16**. Estado: **IMPLEMENTAR_PARCIAL**. Rama `cueva`; HEAD base `8bf6b6ecf3e60730c945fe707769f95ffa450a8e`, con cambios locales sin commit. No hay SHA publicado que represente este diff ni CI de estos cambios.

## Autorización y alcance ejecutado

Axel autorizó expresamente la excepción de ownership y de Issue para ejecutar el piloto Pricing/Price Audit y SB-01 en este checkout: «Sí, autorizo esa excepción para ejecutar el piloto». Se usa el [Issue local](ISSUE_PILOTO_SERVICE_BUS.md) hasta recuperar acceso para publicarlo. Esto no modifica permanentemente `AGENTS.md`, no atribuye aprobación a otros owners y no autoriza producción o datos compartidos.

Se implementó el primer incremento interno del [plan](PLAN_IMPLEMENTACION_SERVICE_BUS.md), limitado a SDK, ruta piloto, persistencia, adapters, lifecycle/readiness y preparación declarativa. P3–P6 y la frontera externa PX no se ejecutaron por esta excepción.

## Implementación

| Parte | Resultado local | Archivos principales |
|---|---|---|
| Dependencias | SDK fijados `@azure/service-bus@7.10.0`, `@azure/identity@4.14.1`; sin cambio de versión de paquetes preexistentes | `package.json`, `package-lock.json` |
| Pricing | Outbox + entrega en la transacción de cambios efectivos; claim con lease/token; envío después del commit; confirmación por destino e ID estable | [Writer/store](../../apps/pricing-svc/src/messaging/service-bus-deliveries.ts), [relay/runtime](../../apps/pricing-svc/src/messaging/service-bus-relay.ts) |
| Persistencia | Migración aditiva candidata, solo aplicada a fixtures PostgreSQL descartables | [DDL](../../apps/pricing-svc/migrations-candidate/h5/0001_outbox_delivery.sql) |
| Audit | SDK Peek-Lock, contrato del dominio, Inbox/auditoría antes de settlement, DLQ/abandon, recuperación sin duplicar suscripciones y drenaje de handlers | [Consumer/runtime](../../apps/price-audit-svc/src/messaging/service-bus-consumer.ts), [decoder común interno](../../apps/price-audit-svc/src/messaging/audit-envelope.ts) |
| Integridad de reintentos | Comparación JSONB del contenido original al deduplicar, conforme DEC-F-009; conflicto no modifica el asiento previo | [Repositorio Audit](../../apps/price-audit-svc/src/persistence/audit.repository.ts) |
| Composición | Providers registrados en los módulos Nest de Pricing/Audit; readiness contempla el worker; nuevos mensajes de log incluidos en allowlists cerradas | Módulos, config, health y SafeLogger de ambos servicios |
| Aislamiento | Default H4 conservado; H5 opt-in con flag explícito, solo desarrollo/test, sin mezclar AMQP por proceso ni fallback | Parsers `service-bus-config.ts` de ambos servicios |
| Infra | Bicep Basic, una cola, SAS apagado y Sender/Receiver por cola; validación de identidades distintas; manifiesto de ruta | [Bicep](../../ops/azure/service-bus/main.bicep), [preflight](../../ops/azure/service-bus/validate-pilot.mjs), [ruta](../../ops/azure/service-bus/pilot-route.json) |
| Operación | Configuración, comandos de prueba, límites y procedimiento de recuperación/rollback | [Runbook](../../ops/azure/service-bus/README.md) |

Los hooks de los productores generan entregas solo para hechos nuevos del piloto; no se hace backfill histórico ni se modifica `pricing.outbox.published_at`. El broker double existe exclusivamente en tests, nunca en el runtime productivo. No se añadieron endpoints, schemas de negocio, scopes ni campos al envelope contractual.

## Evidencia de validación

| Comando / comprobación | Resultado real | Alcance/límite |
|---|---|---|
| `npm test -- apps/pricing-svc apps/price-audit-svc --maxWorkers=1` | PASS: 519 pruebas | Regresión enfocada antes del caso adicional de lifecycle |
| `npm test -- apps/pricing-svc/src/messaging/service-bus.spec.ts apps/price-audit-svc/src/messaging/service-bus.spec.ts --maxWorkers=1` | PASS: 21 pruebas | Incluye recuperación idle, suscripción única y drenaje; SDK/SQL boundaries con dobles explícitos |
| Piloto SQL aislado, ejecución inicial | PASS: 7 pruebas | Dos PostgreSQL reales descartables; broker double identificado |
| `G6_SERVICE_BUS_POSTGRES_TESTS=1 PRICE_AUDIT_TEST_POSTGRES=1 npm run test:e2e -- apps/price-audit-svc/test/provider.postgres.e2e-spec.ts ops/azure/service-bus/pilot.postgres.e2e-spec.ts --maxWorkers=1` | PASS: 22 pruebas | 8 casos finales del piloto y 14 de regresión Audit HTTP/SQL; incluye conflicto de identidad/contenido |
| E2E enfocadas de Pricing/Audit/ops, con flag SQL | PASS: 25; 135 omitidas | Omisiones según flags de suites; no evidencia Azure |
| `node --test ops/azure/service-bus/validate-pilot.test.mjs` | PASS: 5 pruebas | Validación pura; no grants ni aprovisionamiento |
| Bicep CLI 0.49.2 `build ... --outfile <temporal>` | PASS | Template compilado localmente; no what-if ni despliegue |
| `npm run typecheck` | PASS | Verificación de tipos del monorepo |
| `npm run lint` | PASS | Cuatro advertencias preexistentes en Bulk/Promotions; ninguna advertencia nueva |
| `npm run format:check` | PASS | Código TS de aplicaciones; los tests nuevos en ops también se formatearon |
| `npm run build:pricing-svc`, `npm run build:price-audit-svc` | PASS | Artefactos locales de los dos servicios |
| `npm run test:e2e -- --maxWorkers=1`, con flag SQL, última corrida | PASS: 1.053; 259 omitidas | 39 suites pasaron, 19 omitidas; suites opt-in según entorno. Azure real no ejecutado |
| `npm test -- --maxWorkers=1`, OpenSSL nativo en PATH | PASS: 2.621; 73 omitidas | 222 suites pasaron, 2 omitidas; incluye el caso adicional de lifecycle |
| `git diff --check` y enlaces locales | PASS | Diff sin errores de whitespace; 7 Markdown y 28 enlaces locales comprobados antes del cierre |
| `G6_SERVICE_BUS_AZURE_TESTS=1 ...pilot.azure.e2e-spec.ts` | NO EJECUTADO | Requiere namespace de prueba vacío y dos identidades administradas; tres casos preparados |
| CI, build Docker, despliegue, prueba de carga y costo real | NO EJECUTADO | No se declaran por unitarias, SQL, build o compilación Bicep |

Los comandos deben adaptarse a la shell: en PowerShell se define cada flag con `$env:NOMBRE='1'`. Los logs completos de suites generales se conservan localmente en `logs/service-bus-2026-11-16/`, ignorados por Git. Los hashes del código y resultados resumidos se registran en `evidencia-piloto-local.json` al cerrar.

La comparación final de contenido del Inbox se validó incrementalmente con las 22 E2E SQL/HTTP y typecheck/lint/formato/build posteriores. La corrida unitaria general precede a ese último ajuste; no se presenta como una CI de un commit posterior inexistente.

### Incidencias de entorno y correcciones

La primera corrida enfocada dentro del sandbox no pudo completar sus accesos HTTP loopback; la repetición con loopback autorizado pasó las 519 pruebas. Una compilación inicial encontró que el SDK exige descripción además de razón de DLQ; se corrigió con códigos/textos fijos y typecheck pasó.

La primera corrida general no encontró OpenSSL. El binario MSYS de Git produjo después timeout al generar certificados de la suite H4 de Catalog. El binario nativo `Git/ucrt64/bin/openssl.exe` resolvió el problema: la suite aislada pasó sus 16 casos. No se editaron, omitieron ni relajaron esas pruebas. La corrida general final utiliza ese PATH y se reporta por su resultado real.

Docker requirió acceso a su pipe local; las bases creadas son fixtures propias, con puertos loopback aleatorios y cleanup. La descarga de SDK y del compilador Bicep se hizo con acceso de red autorizado. El wrapper `az bicep build` intentaba consultar una versión online; se compiló con el ejecutable oficial ya instalado, sin invocar APIs de despliegue.

## Estado separado por fase

| Estado | Situación |
|---|---|
| Documentación/alcance local | Preparado; excepción del usuario registrada |
| Adopción formal de ADR por coordinación G6 | No atribuida; ADR oficial sigue propuesta |
| Implementación interna del primer piloto | Código y pruebas locales presentes |
| Integración PostgreSQL real | Probada en fixtures descartables |
| SDK/broker Azure real e identidad/RBAC efectivos | Pendientes; no se sustituyen por el double de tests |
| Homologación G5/G7 | No ejecutada; independiente del desarrollo interno |
| CI sobre SHA de implementación | No ejecutada; cambios sin commit |
| Despliegue/producción/retirada RabbitMQ | No ejecutados |

## Dependencias concretas para el siguiente paso

- Infra/operador Azure: autorizar un namespace descartable `g6-sb-test-*`, cola piloto vacía, dos identidades y costo/región. Aplicar IaC solo tras su revisión/autorización. Ejecutar los tres casos reales: flujo positivo y denegación Sender/Receiver cruzados.
- Coordinación G6/owners: revisar la candidata de transporte y el modelo aditivo, registrar decisión interna y preparar integración a sus ramas/PRs sin extender permanentemente la excepción de `cueva`.
- Acceso GitHub: restaurar autenticación/permisos para publicar el Issue y vincular evidencia al SHA revisado. El conector devolvió 403 y `gh auth status` sigue informando token inválido; no se intentó de nuevo una vía de navegador rechazada.
- Para ampliar a otros servicios: ejecutar sus paquetes SB-04/05/06 con sus owners. Para cortar G5/retirar RabbitMQ: resolver SB-07/08 con sus gates propios.

Estado global: **PARTIAL**. El piloto interno está implementado y tiene validaciones locales; no se declara Service Bus operativo en Azure ni `READY_FOR_DEPLOY`.

## Fuentes funcionales del incremento

- [SPEC-013: transiciones efectivas y autoridad de Pricing](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/f77c442485203695a5e877fce188a4d249c129fb/requisitos/specs/SPEC-013-gestion-precios-individuales-masivos.md).
- [SPEC-014: registro append-only e idempotencia](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/f77c442485203695a5e877fce188a4d249c129fb/requisitos/specs/SPEC-014-historial-auditoria-precios.md).
- [AsyncAPI: PricingPriceChangedData y envelope v1](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/f77c442485203695a5e877fce188a4d249c129fb/contratos/eventos/asyncapi.yaml).
- [Registro DEC-F: 006 para autoridad de precios y 009 para idempotencia por identidad, intención y contenido](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/f77c442485203695a5e877fce188a4d249c129fb/arquitectura/decisiones/REGISTRO_DEC_F.md).
- [ADR H5 propuesta: transporte interno y compatibilidad externa](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/f77c442485203695a5e877fce188a4d249c129fb/arquitectura/decisiones/ADR-H5-SERVICE-BUS-BASIC.md).
