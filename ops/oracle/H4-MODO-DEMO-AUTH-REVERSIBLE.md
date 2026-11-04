# G6 — Política única de autenticación reversible para la demo H4

**Estado:** Política H4 pendiente de entrar en vigor en `master` mediante el merge del PR #145.

**Decisión de referencia:** [Backend #144](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/144).
**Owner de la política/Gateway/Oracle:** `mrcastilla8`.
**Ámbito:** ocho microservicios de G6, API Gateway, llamadas HTTP internas y frontend que participe en la demostración.
**Prioridad:** P0 · Hito 4 (07/11/2026).

## 1. Fechas y criterios independientes

| Fecha | Resultado exigido | No equivale a |
| --- | --- | --- |
| 29/10/2026 | Mecanismo de selección demo/autenticado definido, implementado y verificable por servicio para el alcance aceptado | Activación pública del bypass ni despliegue automático |
| 01/11/2026 | Fase funcional restringida: HTTP contractual real, BD y dependencias propias, Gateway y ocho servicios por SHA autorizado en Oracle; evidencia por operación | Token real G7, homologación externa, resultado AMQP no ejecutado |
| 02–06/11/2026 | Fase autenticada: JWT/JWKS G7, identidades, audiencias, roles/scopes/grants y pruebas positivas y negativas | Que un PR de G7 o una allowlist documental concedan acceso por sí solos |
| 07/11/2026 | Presentación H4 con evidencias reproducibles | Cierre automático de issues sin pruebas |

El **01/11 es una meta, no un hecho verificado**. Se mantienen los gates de autorización de release del [Backend #111](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/111).

## 2. Decisión normativa de seguridad

1. **Default cerrado:** el modo demo sin JWT permanece desactivado por defecto en **todos** los entornos, incluido local, CI y Oracle. Activación únicamente explícita mediante configuración revisada; prohibidos valores implícitos por `NODE_ENV`, ausencia de issuer o error de G7.
2. **Aislamiento previo obligatorio:** activar el modo demo solo cuando la entrada a Gateway esté realmente restringida a operadores/dispositivos autorizados por red y/o control de acceso en Caddy/Tailscale o mecanismo equivalente verificado. **Nunca exponer mutaciones, administración, importaciones ni introspección anónimas a Internet.** Ningún puerto HTTP de microservicio, PostgreSQL ni RabbitMQ puede exponerse directamente.
3. **Dos capas:** Gateway solo deja pasar métodos/rutas/`operationId` contractuales y aplica controles técnicos; cada microservicio dueño aplica además su política demo específica. Una exención en Gateway **no** desactiva los guards internos. Ambos lados deben estar alineados; un servicio no preparado debe fallar cerrado.
4. **No fabricar identidades:** no crear JWT falso, `userBearer`, roles, scopes, `client_id` ni `sub` para simular G7; no confiar en encabezados `X-User-*`, `X-Client-*`, `X-Forwarded-For`, `X-Real-IP` o `Origin` enviados por el cliente como fuente de autorización. Si un flujo exige actor para auditoría, utilizar un contexto técnico de demo **explícito, trazable y no humano**, aprobado por el owner; si no existe una semántica segura, registrar `BLOQUEADO_ESPECÍFICO` para esa operación.
5. **La excepción solo afecta autorización:** conservar validación de DTO, métodos y rutas, reglas comerciales, idempotencia, exclusión, disponibilidad, transacciones, auditoría, `X-Correlation-Id`, límites, tamaño, timeout y errores contractuales. Nunca abrir escrituras en schemas ajenos ni saltarse validaciones de negocio.
6. **Fase autenticada intacta:** conservar los verificadores JWT y la política OpenAPI existente. Al desactivar demo, restablecer firma, issuer, JWKS, audience `api-productos`, cliente/rol/scope, expiración y decisiones de autorización. Si el servicio no tiene G7/configuración válida, las rutas protegidas deben **rechazar**, no volver automáticamente a demo.
7. **Separación de mensajería:** deshabilitar JWT **no** cambia ACL/usuarios/vhost/red de RabbitMQ ni homologa mensajes. No activar consumidores, publicar mensajes externos ni alterar colas sin sus gates (Backend #29 y contratos AsyncAPI). Las operaciones HTTP independientes pueden seguir avanzando.
8. **Sin cambios unilaterales a contratos:** no inventar rutas, `operationId`, DTO, scope, actor comercial ni eventos. La excepción temporal es operativa, **no** cambia el esquema de seguridad publicado en OpenAPI/AsyncAPI.
9. **Fuentes de datos reales:** demo funcional exige implementaciones del servicio y persistencia verificable; prohibidos proveedores mock y respuestas fijas usados como sustitutos silenciosos de sistemas reales. Los datos de demostración se cargan por proceso autorizado y reversible (#112), no escribiendo directamente en schemas de otros owners.
10. **No equivale a release:** una prueba local, `build`, PR fusionado, health 200 o configuración escrita no acreditan despliegue. Los SHA, imagen/digest, ambiente y pruebas reales se verifican y autorizan por servicio (#110/#111/#115).

### 2.1 Límite de confianza del Gateway

- En demo, **solo** el Gateway restringido recibe peticiones de interfaz o de consumidores de prueba. `Caddy -> Gateway` va por `g6-edge`; `Gateway -> microservicios` por `g6-http` privada, conforme a `ops/oracle/CONTRATO_DESPLIEGUE.md`.
- Comprobar que el Gateway no pueda alcanzarse por un acceso directo sin aislamiento. Comprobar que los contenedores internos no publiquen puertos de negocio.
- Al operar sin JWT, no propagar una cabecera Authorization entrante como si fuera identidad validada. Eliminar encabezados de identidad no confiables antes de llamar al upstream; preservar únicamente headers contractuales, correlación e idempotencia autorizados.
- **La IP de origen no se infiere de headers controlados por el navegador o por un proxy arbitrario**. Si existe una excepción dependiente del par TCP (por ejemplo Inventory), documentar y comprobar cuáles IP internas del Gateway están realmente autorizadas; Caddy/Tailscale deben cerrar la entrada externa.
- El frontend Vercel desplegado públicamente **no obtiene automáticamente acceso a una API privada**. Para demo sin JWT, probar el acceso real del navegador/dispositivo autorizado a la URL restringida y la política CORS; si no es viable, documentar el bloqueo de presentación. No sustituirlo por exposición HTTP anónima pública.

### 2.2 Mecanismo de selección — diseño mínimo

No se obliga a crear una librería común ni a importar código entre `apps/*` (prohibido por `AGENTS.md`). Se exige la **misma semántica** con adaptaciones mínimas dentro del ownership de cada módulo:

- Política `AUTHENTICATED` (default): se aplica el guard JWT existente; sin token o con token inválido se obtienen los errores contractuales. Sin issuer/JWKS válido, fallar cerrado.
- Política `RESTRICTED_DEMO`: habilitable únicamente tras validación de configuración y **evidencia externa de aislamiento**. Solo omite el requisito de JWT en las operaciones expresamente incluidas en el corte contractual de demo; no altera el resto del procesamiento.
- **Un único responsable de cambios transversales del Gateway:** Marco. Otros owners implementan la adaptación únicamente dentro de su servicio y coordinan cualquier cambio fuera de su ownership.
- No inventar ni imponer aún un nombre global de flag; ver los existentes en la sección 3. Los flags faltantes deben aprobarse con Marco para evitar nombres y semánticas incompatibles.
- Flags de demo, perímetro y alcance deben verificarse juntos en el runtime. El simple valor `true` no es evidencia de aislamiento ni autorización.

## 3. Situación actual comprobada en código (28/10/2026)

Estos son **puntos de partida**, no un certificado de que el modo completo del #144 ya exista. Revisar el último SHA antes de implementarlos.

| Componente / owner | Evidencia actual | Brecha obligatoria de la fase 1 |
| --- | --- | --- |
| API Gateway — Marco | En `master`: `GATEWAY_DEMO_NO_AUTH_ENABLED` por defecto `false`; `isDemoPublicRoute` y proxy limitan la excepción efectiva a GET concretos. La rama `poma` tiene además `G6_READ_ONLY_DEMO_ENABLED` de lectura. | La política de #144 comprende operaciones contractuales **de lectura y escritura** solo dentro de la demo aislada; adaptar Gateway sin expandir la superficie pública ni pisar cambios del PR #125. |
| Catalog — Poma | Rama `poma`/PR #125: `CatalogAuthGuard` y modo `CATALOG_READ_DEMO` permiten solo GET autorizados; bloquean otras mutaciones en demo. Existe una llamada técnica Catalog→Pricing con `client_credentials` y un endpoint de contexto SKU que exige JWT. | Acordar adaptaciones reversible de lecturas, escrituras y HTTP interno sin JWT para fase 1; nunca inventar tokens ni eliminar el camino auténtico de fase 2. Integrar primero su rama vigente. |
| Taxonomy — López | En `master`: consultas GET categorías y marcas; PR #131 añade lógica/persistencia pero no endpoints administrativos nuevos. | Completar operaciones HTTP contractuales que correspondan y su política de acceso; no confundir la ausencia de endpoints con un problema de autenticación. |
| Pricing — Vera | `PricingReadGuard` admite `demoNoAuthEnabled`, configurado desde `GATEWAY_DEMO_NO_AUTH_ENABLED`; en producción el parser exige además `PRICING_DEMO_PRODUCTION_CONFIRMED=true`. El módulo tiene providers de contexto Catalog/canales/autorización pendientes. | Verificar aislamiento real y flags explícitos; coordinar con Poma contexto SKU/canales y cubrir lecturas/escrituras contractuales. No relajar introspección fuera de demo autorizada. |
| Price Audit — Vera | `AuditReadGuard` valida JWT/JWKS y no aparece una excepción demo general; decoder de evento de precio pendiente. | Adaptación reversible de lecturas contractuales y separación respecto de AMQP/decoder, que conserva su gate. |
| Inventory — Taco | `INVENTORY_DEMO_NO_AUTH_ENABLED` + `INVENTORY_DEMO_GATEWAY_IPS` limitan **dos** operaciones comerciales; operaciones administrativas siguen bajo guards de usuario. | Ampliar únicamente el alcance permitido por #144, tras definir contexto no humano y perímetro. No convertir en bypass público ni suprimir garantías de movimientos de stock. |
| Promotions — Cueva | Guards reales exigen JWT. `blockedCommercialContext` y `blockedAdminReferences` impiden ciertas operaciones hasta integrar proveedores comerciales autorizados. | Implementar mecanismo reversible **y** conectar proveedores internos reales. JWT no es el único bloqueo; no deshabilitar las verificaciones de referencias por estar en demo. |
| Bulk — Marco | En `master`, el módulo HTTP registra health/readiness; faltan endpoints funcionales contractuales conectados. | Implementar API real además de la política de acceso. |
| Combos — Marco (owner vigente) | En `master` y rama `poma`, `combos-svc` conserva solo `health`. `AGENTS.md` y `README.md` identifican a Marco como owner; Backend #79–#87 están asignados a `mrcastilla8`; Poma queda concentrado en Catalog. | La implementación funcional de Combos continúa pendiente; el modo demo no convierte el scaffold en un servicio funcional. |

**Referencias operativas:** [#144](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/144), [#107](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/107), `AGENTS.md`, `ops/oracle/GUIA_DEVTEAM.md`, `ops/oracle/CONTRATO_DESPLIEGUE.md`, `ops/oracle/RABBITMQ_COMPATIBILIDAD.md`, documentación de cada servicio y OpenAPI/AsyncAPI de G6 Docs. Esta política no reemplaza ninguna de ellas.

## 4. Contrato de prueba por servicio (obligatorio)

Cada owner ejecutará y registrará la matriz para **todos los operationId que declara incluidos en fase 1**; si falta una operación se registra `NO_IMPLEMENTADA`, no `PASS`.

| Caso | Configuración / origen | Resultado esperado |
| --- | --- | --- |
| D-01 | Modo demo apagado, sin JWT, operación protegida | Rechazo contractual 401/403, nunca 2xx anónimo |
| D-02 | Modo demo apagado, JWT erróneo/expirado/scope insuficiente | 401/403 correctos; no fallback a demo |
| D-03 | Modo demo apagado, JWT G7 válido y permiso aplicable | 2xx o error comercial legítimo, nunca rechazo por demo |
| D-04 | Modo demo activado desde red/entrada autorizada, sin JWT, ruta contractual incluida | Se ejecuta el caso de uso real; DTO/negocio/BD siguen operativos |
| D-05 | Modo demo activado, ruta/método desconocido o no incluido | Rechazo/404/405 conforme al contrato; nada de proxy libre |
| D-06 | Modo demo activado, acceso directo externo/no autorizado | Denegado por perímetro; nunca acceso anónimo a operaciones de escritura |
| D-07 | Modo demo activado, entrada manipulada / referencia SKU inválida / idempotency repetida | Validaciones, conflictos y efectos persistidos correctos; sin saltear reglas |
| D-08 | Modo demo activado, header Authorization o identidad falsa suministrada por cliente | No se acepta como identidad validada ni se transmite como credencial confiable |
| D-09 | Reinicio/redeploy sin flag o con configuración incompleta | Demo permanece apagada y el servicio falla cerrado cuando corresponda |
| D-10 | Restablecer JWT real después del corte | Regresión funcional sin duplicar controladores ni perder permisos |

La prueba D-03 exige token **emitido realmente por G7**: si aún no se dispone de él, marcar `PENDIENTE_G7` y cubrir D-01/D-02 sin atribuir una prueba positiva ficticia. D-06 exige evidencia del límite de acceso externo, no un mock de IP de origen.

### 4.1 Evidencia mínima por operación

- **Servicio y owner**, issue asociado, rama, commit SHA, CI del mismo SHA y estado de merge.
- **Contrato:** `operationId`, método, ruta, revisión OpenAPI/AsyncAPI, tipo de actor requerido en modo autenticado.
- **Demo:** variables y política activas **sin valores secretos**, topología efectiva de entrada, resultado de D-01/D-04/D-06/D-09; token ausente.
- **Negocio:** datos de prueba autorizados, respuesta real, efecto PostgreSQL comprobado, errores e idempotencia. Para flujos que requieran otros servicios, resultado por tramo.
- **Despliegue:** digest de imagen, entorno Oracle, readiness real, salida HTTP/Frontend→Gateway→Servicio y rollback autorizado; ninguna captura debe mostrar secretos.
- **Mensajería:** `NO_APLICA`, `PASS` o `BLOQUEADO_ESPECÍFICO` con ACL/vhost, dueño externo, versión de contrato y evidencia aplicable.
- **Fase 2:** JWT G7 auténtico, audience/scopes/roles, caso positivo, 401/403 y resultado de regresión, todos asociados al SHA/ambiente.

## 5. Reglas de coordinación

1. Marco publica/aprueba una única versión de este documento; los demás owners **deben leerlo antes de programar** el modo demo y enlazar su revisión/commit desde el issue de servicio. No se aceptan políticas incompatibles por microservicio.
2. Cada owner solo cambia archivos de su módulo. Cambios a `apps/api-gateway`, a `AGENTS.md`, a contratos o a infraestructura requieren coordinación/aprobación transversal según ownership existente.
3. Cuando la necesidad de identidad comercial o referencia autoritativa no tenga solución segura sin JWT, **no inventar**: señalar `BLOQUEADO_ESPECÍFICO` con operación, impacto y condición de desbloqueo. El resto continúa.
4. En Frontend usar el cliente HTTP compartido de `frontend #45`, manteniendo `mock` explícito solo donde aún no exista API. No caer silenciosamente de modo API a mock ni declarar flujo E2E por usar mocks.
5. Ante una decisión contradictoria entre descripciones históricas de issues y este documento aprobado, utilizar la **decisión vigente vinculada en #144** y preservar trazabilidad; no alterar silenciosamente el historial.
6. Marcadores de issues para la vinculación: `<!-- H4-DEMO-POLICY-2026:START -->` y `<!-- H4-DEMO-POLICY-2026:END -->`; insertar/actualizar idempotentemente sin modificar los bloques históricos `H4-DOS-FASES-2026`.

## 6. Mapa de issues que deben enlazar esta política

**Transversales Backend:** #144, #107, #106, #21, #109, #110, #111, #113 y #115. En #29 solo indicar que la política **no sustituye** los gates AMQP; no cambiar acuerdos de nombres físicos.
**Seguimiento de servicios:** Catalog #51, Taxonomy #42, Pricing #60, Price Audit #69, Inventory #105, Promotions #78, Bulk #96 y Combos #87.
**Combos:** Backend #79–#87 están asignados a `mrcastilla8`. Marco es el owner vigente; la implementación funcional continúa pendiente. Conservar responsables históricos y entregas previas.
**Frontend:** #33, #45 y #34 (Combos); otros issues de frontend solo si se modifica la selección API/demo en su implementación.

En cada issue de seguimiento se exige:

> **Lectura obligatoria:** antes de diseñar o modificar la autenticación reversible, revisar `ops/oracle/H4-MODO-DEMO-AUTH-REVERSIBLE.md` en `master` y Backend #144. Implementar únicamente dentro del ownership del servicio; informar los `operationId` cubiertos, flags reales, pruebas D-01–D-10 aplicables, dependencias bloqueantes y SHA. No se acepta un bypass propio que contradiga esa política.

## 7. Registro de pendientes que no se resuelven con este documento

- Token G7 real, clientes/grants aprovisionados, JWKS/issuer accesibles, roles y permisos efectivos; [Backend #138](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/138) sigue separado.
- Proveedores de contexto Catalog→Pricing y Catalog/Pricing/Taxonomy→Promotions; no se autorizan accesos a schemas ajenos.
- RabbitMQ topología física, identidad y ACL, retry/recuperación e integración G5; [Backend #29](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/29) es independiente.
- Homologación G4/G5/G1 y pruebas bilaterales, especialmente las operaciones de stock y cupones afectadas.
- Implementación incompleta de Bulk y Combos, escrituras administrativas de Taxonomy y eventos productivos de Price Audit.
- Datos autorizados de demo [#112](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/112), compose [#110](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/110), autorización individual de cada release [#111](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/111) y E2E [#115](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/115).

**Regla final:** «sin JWT de G7» significa **demostración restringida y reversible**, nunca «API administrativa pública sin autenticación». La meta es entregar funcionalidad real primero y activar seguridad auténtica después, sin fingir ninguno de ambos resultados.
