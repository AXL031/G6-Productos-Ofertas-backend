# Azure Service Bus real — piloto aislado

Fecha: 2026-11-16. Rama `cueva`, base `8bf6b6ecf3e60730c945fe707769f95ffa450a8e`. Issue [local autorizado](ISSUE_PILOTO_SERVICE_BUS.md), aún sin número remoto. Axel solicitó expresamente continuar con Azure real y despliegue después de autorizar la excepción Pricing/Audit/SB-01. No se atribuye aprobación de arquitectura ni de una release productiva.

**Resultado: infraestructura Azure desplegada y piloto real PASS; promoción a las Container Apps actuales pendiente.** El código probado continúa sin commit y se identifica por hashes, no como una release oficial. [Evidencia estructurada](evidencia-piloto-azure.json) y [procedimiento reproducible](../../ops/azure/service-bus/CLOUD_PILOT.md).

## Recursos desplegados

| Recurso | Valor observado |
|---|---|
| Suscripción | Azure for Students, `fef42188-accd-4470-ae88-78f583eb4906` |
| Grupo nuevo | `rg-g6-sb-pilot-261116` |
| Región | `chilecentral` |
| Namespace | `g6-sb-test-261116-axl01.servicebus.windows.net` |
| SKU / controles | Basic; TLS mínimo 1.2; `disableLocalAuth=true`; endpoint público TLS/Entra |
| Cola | `g6.price-audit.from.pricing`; lock 1 minuto; máximo 10 entregas |
| Pricing | `id-g6-sb-pilot-pricing`; client ID `ba1aa40c-5a4e-4fe2-94fb-16c705d9f949`; Data Sender solo en la cola |
| Audit | `id-g6-sb-pilot-audit`; client ID `f899f0e8-32e8-4617-b487-6ec010a9de9d`; Data Receiver solo en la cola |

Se registraron los proveedores Service Bus/Container Instances y se comprobó cuota ACI: 6 CPU disponibles, 0 utilizadas inicialmente. El laboratorio solicitó 2 CPU/2 GiB, sin IP pública. El namespace/cola y las identidades permanecen desplegados; el cómputo temporal se retiró después de recoger evidencia. No se cambiaron las nueve Container Apps existentes, la VM ni la base compartida.

## Evidencia real

El ejecutor Azure usó dos PostgreSQL 16 nuevos y las clases compiladas de Pricing/Audit. La selección explícita de `ManagedIdentityCredential` evitó usar la identidad del usuario autenticado en CLI para acreditar los permisos runtime.

| Comprobación | Resultado observado |
|---|---|
| Autenticación de ambas identidades | PASS, apertura real Sender/Receiver |
| Mutación → Outbox/entrega → broker | PASS, confirmación SDK y `sent_at` SQL |
| Codificación | PASS, envelope recibido como sección de datos binarios UTF-8 |
| Audit + redelivery | PASS, commit real antes de abandonar deliberadamente; segunda entrega completada, una sola fila de auditoría |
| Audit intenta enviar | PASS, `UnauthorizedAccess` |
| Pricing intenta recibir | PASS, `UnauthorizedAccess` |
| Mensaje inválido → DLQ | PASS, ID y razón `INVALID_PRICING_CONTRACT` comprobados en Azure |
| Resultado final | PASS, bundle `d6c2af3499c079788760d55329d75b5193c21f153a145a4c353991f66fd25eff` |

Mensaje válido: `73377d31-9ec4-4c5d-b855-1b99c399a174`. Correlación: `cc0d46d5-2601-49e5-9318-dd99dd5182fc`. Redelivery observada `deliveryCount=1` en el SDK (contador inicial 0). Mensaje inválido de prueba: `347e950c-8539-4d6d-bc01-71adfef2c8ae`.

Las dos identidades estuvieron asignadas al mismo host de laboratorio para probar permisos cruzados. Esto no acredita aislamiento entre workloads de producción. La falla posterior al commit se inyectó mediante abandon real y excepción deliberada; no se afirma haber cortado físicamente el host ni perdido un lock real. Se probaron las clases de dominio/persistencia/adaptadores; no el despliegue continuo de los procesos Nest, sus endpoints, readiness HTTP o escala de ACA.

## Fallo encontrado y corregido

El intento inicial autenticó ambas identidades y confirmó el envío, pero falló en Audit. El SDK JSON-serializa cuerpos no binarios y, con `skipParsingBodyAsJson`, devuelve bytes; el candidato esperaba texto. No se presentó ese intento como éxito. Su bundle fue `72540ae3df74189f891cd3608d4d0f802908de62a5ef1053638b3218f0c265c7`.

Se corrigió Pricing para enviar los bytes UTF-8 del envelope, evitando una segunda cadena JSON, y Audit para aceptar bytes/string y validar tamaño y UTF-8 con su decoder existente. Se añadieron pruebas de sección binaria, UTF-8 inválido, JSON anidado y exceso de tamaño. El segundo intento completo pasó; ambos logs se conservaron. La DLQ conserva dos artefactos del laboratorio: el primer envío rechazado y el inválido intencional del segundo intento. No se hace replay automático ni se borran para aparentar una cola sin incidencias.

## Validaciones posteriores a la corrección

- Unitarias específicas Service Bus: **25 PASS**.
- Unitarias completas de Pricing/Audit con acceso loopback: **524 PASS**, 37 suites. El primer intento en sandbox falló en 48 casos HTTP; la repetición autorizada pasó sin modificar esas pruebas.
- Piloto con dos PostgreSQL Docker reales: **8 PASS**. Sigue usando broker double y no sustituye la evidencia Azure anterior.
- `npm run typecheck`, `npm run build:pricing-svc`, `npm run build:price-audit-svc`: **PASS**.
- `npm run lint`: **PASS**, cuatro advertencias preexistentes en Bulk/Promotions.
- Preflight Node: **5 PASS**. Compilación Bicep de infraestructura y ejecutor: **PASS** después de corregir dos errores iniciales del template (tipo del parámetro seguro y ubicación del `for`). ARM `validate` del ejecutor y despliegues: **Succeeded**.
- `node --check`, Prettier de herramientas y `git diff --check`: **PASS**. Oxlint no incluye estos scripts operativos en su configuración; no se atribuye cobertura de lint a archivos que omitió.

Las suites generales de monorepo documentadas en el [corte local](EJECUCION_PILOTO_SERVICE_BUS.md) preceden esta corrección. No se presentan como CI ni como ejecución de una versión posterior inexistente.

## Estado por fase y siguiente paso concreto

| Fase | Estado |
|---|---|
| Código interno | Implementado localmente, hashes registrados |
| PostgreSQL aislado | PASS |
| Infra Azure / RBAC real | Desplegada y verificada |
| Flujo SDK/broker/persistencia Azure | PASS en laboratorio |
| Cómputo de laboratorio | Terminado y retirado |
| Issue remoto / commit / CI oficial | Pendientes |
| Adopción formal de ADR / homologación externa | No atribuidas |
| Activación en apps actuales / migración compartida / retirada RabbitMQ | No realizadas |

Para promover el piloto: owner de repositorio debe recuperar publicación, revisar el diff y obtener commit/CI del SHA oficial; owner de release debe acreditar el environment `azure-h5` protegido y aprobar el deployment concreto según [CD H5](../../ops/azure/container-apps/CONFIGURACION_OIDC_H5.md). Owner de datos debe autorizar/aplicar la migración aditiva en la base destino. Owner de aplicaciones debe cerrar configuración de producción, identidad exclusiva por servicio y relay siempre activo. El parser actual rechaza `NODE_ENV=production`; no se sorteó ese gate ni se alteraron las apps para ocultarlo.

Estado global: **PARTIAL** respecto de la migración y release productiva. El despliegue de infraestructura y la prueba Azure aislada están completos.
