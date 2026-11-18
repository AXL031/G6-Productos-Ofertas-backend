# AGENTS.md — Instrucciones operativas para agentes en Backend

> **LEER COMPLETO ANTES DE EDITAR.** Este documento rige el desarrollo backend en el monorepo NestJS de **Productos y Ofertas (G6)**.

---

## 1. Orden obligatorio de trabajo

Prohibido escribir código antes de completar los pasos 1 a 6:

1. **LEER `AGENTS.md` COMPLETO** antes de editar cualquier archivo.
2. **Identificar la rama actual:** debe ser una rama personal permanente o una rama temporal conforme a esta política.
3. **Identificar el Issue o tarea concreta:** si existe un Issue, revisar sus criterios; si no existe, documentar objetivo, motivación, alcance, criterios de aceptación, pruebas e impactos en el PR.
4. **Identificar microservicio, responsables primarios y archivos afectados:** consultar la matriz como guía de conocimiento y contacto, no como permiso exclusivo.
5. **Consultar los contratos normativos correspondientes** en el repositorio de documentación.
6. Para toda implementación o modificación del modo demo, antes de cambiar código es obligatorio leer `ops/oracle/H4-MODO-DEMO-AUTH-REVERSIBLE.md` y Backend [#144](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/144).
7. **Realizar únicamente los cambios solicitados:** sin refactors extra ni archivos fuera de scope.
8. **Ejecutar pruebas:** pruebas enfocadas primero, luego validaciones generales.
9. **Revisar `git diff`:** verificar cambios exactos y ausencia de whitespace errors.
10. **Reportar resultados y bloqueos:** según el formato de reporte obligatorio.

### Lectura obligatoria para preparación Oracle

Antes de modificar un microservicio, además de leer `AGENTS.md` y comprender la tarea (con Issue cuando exista), consulta los contratos OpenAPI, AsyncAPI y DEC-F aplicables, y estas guías de despliegue:

1. `ops/oracle/GUIA_DEVTEAM.md`.
2. `ops/oracle/CONTRATO_DESPLIEGUE.md`.
3. `ops/oracle/servicios/<servicio>.md`.
4. `ops/oracle/MATRIZ_DEPENDENCIAS.md`.
5. `ops/oracle/RABBITMQ_COMPATIBILIDAD.md`, cuando el servicio use o proponga AMQP.
6. `ops/oracle/CHECKLIST_PREDEPLOY.md`.

Un microservicio no puede declararse `READY_FOR_DEPLOY` sin evidencias asociadas a su SHA que demuestren el cumplimiento de todos los requisitos aplicables de compilación, configuración, persistencia, mensajería, seguridad, contratos, Docker y readiness. Un bloqueo específico de AMQP no debe impedir el desarrollo independiente de funcionalidades HTTP o de persistencia dentro del alcance autorizado.

### Mensajería H5 — norma obligatoria para nuevas integraciones

Para tareas de mensajería Hito 5, la arquitectura vigente es **Azure Service Bus Basic para comunicación interna entre bounded contexts G6**. G1–G5 se integran con G6 mediante HTTP autenticado a través de APIM/Gateway; G7 conserva la autoridad de identidad y grants. **No añadas dependencias, colas, handlers ni configuración RabbitMQ/AMQP para implementar H5.** No publiques el mismo efecto comercial por ambos brokers salvo que una estrategia de transición explícita haya sido aprobada y probada. Basic no tiene topics/subscriptions: modela una entrega independiente por destinatario con Outbox, Inbox e idempotencia durables.

RabbitMQ, AsyncAPI H4, Oracle y sus procedimientos siguen siendo necesarios para mantener, operar, recuperar y probar regresiones del runtime heredado durante la compatibilidad transitoria. No son la topología física H5 ni autorizan inferir colas, routing keys, variables de entorno o handlers Service Bus. Conserva intactos los contratos y fixtures H4 salvo autorización explícita de contrato.

#### Orden obligatorio de lectura para tareas H5

1. Esta sección y la tarea/Issue; identifica servicio owner, alcance y PR solapados.
2. Docs [ADR-H5-SERVICE-BUS-BASIC.md](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/decisiones/ADR-H5-SERVICE-BUS-BASIC.md) y [TOPOLOGIA-SERVICE-BUS-BASIC-H5.md](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/contratos/eventos/TOPOLOGIA-SERVICE-BUS-BASIC-H5.md).
3. Docs [PLAN-MIGRACION-MENSAJERIA-H5.md](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/integraciones/PLAN-MIGRACION-MENSAJERIA-H5.md), [MATRIZ-EXTERNOS-ASYNCAPI-H5.md](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/integraciones/MATRIZ-EXTERNOS-ASYNCAPI-H5.md), [INVENTARIO-40-MENSAJES-H5.md](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/contratos/eventos/INVENTARIO-40-MENSAJES-H5.md) y la [matriz ejecutable H5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/integraciones/MATRIZ-IMPLEMENTACION-SERVICE-BUS-H5.md).
4. Las SPEC, DEC-F, modelo/persistencia, pruebas y contratos HTTP/AsyncAPI aplicables. AsyncAPI H4 es referencia semántica histórica, no diseño de transporte H5.
5. Si la tarea toca el runtime H4/Oracle, consulta además las guías Oracle y RabbitMQ de esta sección; para H5 no las uses para diseñar transporte.

La matriz H5 es la fuente única de seguimiento por flujo. Contrasta cada fila con el SHA actual del Backend y evidencia reproducible antes de cambiar su estado; una propuesta, fixture o piloto aislado no equivale a habilitación general. El piloto #234 Pricing → Service Bus Basic → Price Audit está documentado en `docs/hito-5/CIERRE_PILOTO_234.md` y `docs/hito-5/EJECUCION_AZURE_SERVICE_BUS.md`: es evidencia parcial de ese recorrido/ambiente y no demuestra migración global, aprovisionamiento compartido, producción, homologación G5, autorización G7 ni retiro de RabbitMQ.

---

## 2. Política de colaboración y ramas

- **Ramas personales permanentes:**
  - `castilla`
  - `poma`
  - `cueva`
  - `lopez`
  - `vera`
  - `taco`
- Son el espacio preferente de desarrollo de cada integrante. No se eliminan en la limpieza ordinaria de PRs y pueden usarse para PRs sucesivos a `master`.
- Antes de comenzar otro trabajo en una rama personal, sincronízala de forma segura con `master`. Mantén cada PR cohesivo: no acumules ni mezcles cambios independientes.

### Ramas temporales

La convención obligatoria para ramas nuevas de trabajo es `trabajo/<desarrollador>/<descripcion-en-kebab-case>`, por ejemplo `trabajo/poma/correccion-azure-service-bus` o `trabajo/vera/optimizar-consultas-pricing`.

- Cualquier desarrollador puede crear varias ramas temporales y no necesita un Issue asignado para hacerlo.
- Parte del `master` actualizado, salvo que exista una dependencia explícita y documentada.
- Cada rama representa un propósito identificable y cada trabajo independiente tiene su propio PR, preferentemente hacia `master`.
- Se permite `git worktree` para desarrollar en paralelo.
- No crees ramas con prefijos de herramientas o agentes como `codex/`, `claude/`, `gemini/` o `antigravity/`.
- Esta convención rige ramas nuevas; no renombres ramas históricas ni alteres PRs existentes automáticamente.
- No uses `git push --force`, `git reset --hard` ni merges destructivos, ni sobrescribas trabajo ajeno. Sincroniza de forma segura y respeta CI y protecciones de `master`.

### Issues y tareas

Todo desarrollador puede atender cualquier Issue, incluso si está asignado a otra persona o no tiene asignación. También puede ayudar a un compañero o iniciar una corrección, optimización, refactorización justificada o mejora sin Issue previo. Puede mantener varios PRs independientes abiertos. Si no existe Issue, documenta en el PR el objetivo, motivación, alcance, criterios de aceptación, pruebas e impactos posibles. Crear una rama o abrir un PR no autoriza su aprobación, merge ni despliegue.

### Limpieza de ramas

Tras fusionar un PR temporal, confirma el merge y que la rama no sea necesaria para otro PR abierto o trabajo dependiente; luego elimina la rama temporal local y remota cuando corresponda. Las ramas temporales abandonadas pueden eliminarse tras comprobar que no contienen cambios pendientes por conservar. Nunca elimines ramas personales permanentes mediante esta limpieza ni configures una eliminación automática indiscriminada que las afecte.

---

## 3. Matriz de ownership de aplicaciones

| Rama | Aplicaciones de responsabilidad primaria y conocimiento técnico |
|---|---|
| `castilla` | `apps/bulk-svc`, `apps/combos-svc` |
| `poma` | `apps/catalog-svc` |
| `cueva` | `apps/promotions-svc` |
| `lopez` | `apps/taxonomy-svc` |
| `vera` | `apps/pricing-svc`, `apps/price-audit-svc` |
| `taco` | `apps/inventory-svc` |

- Esta matriz identifica responsables primarios, experiencia y puntos de contacto; no concede ni limita permisos exclusivos de edición. Cualquier desarrollador puede colaborar transversalmente en esos servicios.
- Antes de iniciar trabajo que pueda solaparse, comprueba Issues y PRs existentes y comunica la intervención cuando corresponda. No se requiere autorización general del responsable primario para comenzar.
- **`apps/api-gateway`:** componente transversal de alto impacto; su modificación requiere coordinación y revisión proporcional con arquitectura e integración, pero no exige crear previamente un Issue.
- **Archivos globales:** `libs/`, `.github/`, dependencias en `package.json`, scripts y configuración del monorepo (`nest-cli.json`, `tsconfig*.json`) son compartidos; requieren revisión de los responsables pertinentes según el impacto y controles del repositorio, no una asignación exclusiva.
- La colaboración no autoriza modificar unilateralmente contratos normativos, decisiones arquitectónicas aceptadas, permisos de seguridad, secretos, infraestructura productiva ni responsabilidades de otros módulos. Conserva la revisión, aprobación y homologación aplicables.

---

## 4. Fuentes normativas y reglas de negocio

- **Repositorio de documentación oficial:** [G6-Productos-Ofertas-docs](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs). Si no existe localmente en `../docs/`, consulta el repositorio oficial remoto. Rutas canónicas:
  - Arquitectura: `arquitectura/Arquitectura.md`
  - Contratos HTTP: `contratos/http/openapi.yaml`
  - Contratos Asíncronos: `contratos/eventos/asyncapi.yaml`
  - Especificaciones: `requisitos/specs/SPEC-*.md`
- **PROHIBIDO inventar contratos:** endpoints, campos, DTOs, eventos o códigos de error deben existir en OpenAPI/AsyncAPI oficiales.
- **PROHIBIDO mocks silenciosos:** no sustituir integraciones reales por arrays o datos simulados en producción.
- **PROHIBIDO alterar migraciones históricas:** las migraciones aplicadas en Supabase son inmutables.
- **PROHIBIDO compartir código entre servicios:** no importar entre `apps/*` ni compartir entidades ORM. Toda integración es vía contratos HTTP o eventos asíncronos.
- **Lógica de negocio:** no introducir lógica de negocio en `api-gateway` ni en librerías técnicas comunes.
- Si no puedes acceder al contrato normativo requerido, marca la tarea como `BLOCKED_CONTRACT` y repórtala; no inventes interfaces.

### DEC-F adoptadas y desbloqueo selectivo

- Las DEC-F-001 a DEC-F-015 adoptadas por G6 son obligatorias para la implementación interna en el bounded context al que corresponda cada regla o invariante. Consulta el [registro DEC-F](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/942bf7322eb388fe5b0fcc9c5a565152e1099139/arquitectura/decisiones/REGISTRO_DEC_F.md), su [matriz de trazabilidad](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/942bf7322eb388fe5b0fcc9c5a565152e1099139/arquitectura/decisiones/MATRIZ_TRAZABILIDAD_DEC_F.md) y la [matriz intermodular de backend](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/942bf7322eb388fe5b0fcc9c5a565152e1099139/integraciones/MATRIZ_INTERMODULAR_BACKEND.md). Antes de cambiar código, identifica las decisiones aplicables y sus fuentes normativas; no amplíes su contenido por inferencia ni crees DEC-F-016 o posteriores sin aprobación expresa de Marco.
- Clasifica cada alcance de trabajo con un estado operativo:
  - **`IMPLEMENTAR_AHORA`:** lógica, invariantes, persistencia y pruebas internas de G6 están definidas y pueden desarrollarse dentro del bounded context, con la revisión aplicable.
  - **`IMPLEMENTAR_PARCIAL`:** implementa lo interno ya definido y mantén aislada la frontera de integración que depende de una resolución externa.
  - **`BLOQUEADO_ESPECÍFICO`:** detén solo la operación, autorización, contrato compartido o secuencia que depende de la respuesta externa. Registra el owner que debe responder, la operación afectada y la condición exacta que permitirá desbloquearla.
- Una discrepancia intermodular que afecte una integración no paraliza el microservicio completo. Continúa el trabajo autónomo de G6 y no atribuyas ownership, aceptación externa, permisos ni homologación a otro módulo.
- Comunica a los consumidores externos afectados los cambios previstos, la regla DEC-F aplicable, el impacto contractual, la versión y la adaptación requerida. Esa comunicación no requiere autorización externa para desarrollar lógica e invariantes internas propias de G6.
- Antes de publicar como definitivo un cambio incompatible en un contrato compartido, exige homologación verificable de los módulos concernidos. Hasta entonces, conserva aislada la frontera pendiente; no cambies unilateralmente el contrato ni declares aceptación por silencio.
- Registra por separado el estado de implementación interna, pruebas locales, integración autenticada, homologación externa y despliegue. Ninguno se infiere de otro: documentación o YAML no prueban implementación; pruebas locales no prueban integración autenticada; una integración autenticada no prueba homologación ni despliegue.
- Toda dependencia externa pendiente debe identificar como mínimo: owner responsable de responder, operación o comportamiento afectado y condición concreta y verificable de desbloqueo. No uses un bloqueo general del microservicio si la dependencia solo afecta esa operación o frontera.

---

## 5. Protocolo para agentes de menor capacidad

1. Mantener cada rama y PR enfocados en una tarea cohesiva; se permiten varias tareas y PRs independientes en paralelo.
2. Leer solo los archivos estrictamente necesarios para el cambio.
3. No reconstruir archivos completos si basta una edición localizada.
4. No realizar refactors adicionales ni actualizar dependencias sin autorización.
5. No eliminar ni comentar pruebas que fallen.
6. No solucionar errores de tipos con `any`, `@ts-ignore` ni desactivando reglas de lint/TypeScript.
7. Tras modificar código, ejecutar primero pruebas enfocadas del microservicio y luego validaciones aplicables:
   ```bash
   npm test               # pruebas unitarias
   npm run test:e2e       # pruebas e2e
   npm run typecheck      # verificación de tipos
   npm run lint           # linter
   ```
8. Si la misma corrección falla 2 veces consecutivas, detener esa línea de trabajo y reportar el error exacto.
9. No declarar `PASS` en un paso sin haber ejecutado el comando correspondiente.
10. No afirmar que una funcionalidad está implementada si solo existe un esqueleto/stub.
11. No hacer commit ni proponer cambios si existen errores obligatorios pendientes.

---

## 6. Reporte obligatorio al finalizar

Todo agente debe estructurar su respuesta final con:

```text
RAMA Y ISSUE: <rama> | <issue o SIN ISSUE>
ARCHIVOS MODIFICADOS: <lista de rutas>
CAMBIOS REALIZADOS: <resumen conciso de cambios>
COMANDOS EJECUTADOS: <comando y resultado real: PASS/FAIL/NO EJECUTADO>
ERRORES PENDIENTES: <ninguno o detalle exacto>
DEPENDENCIAS EXTERNAS: <owner | operación afectada | condición exacta de desbloqueo, o ninguna>
CAMBIOS FUERA DEL ALCANCE: <ninguno o justificación expresa>
ESTADO FINAL: PASS / PARTIAL / BLOCKED
```

## G1 Marketplace H4 — documentación operativa obligatoria

Antes de implementar o modificar endpoints consumidos por Marketplace, lee [`integraciones/g1-marketplace/README.md`](integraciones/g1-marketplace/README.md), su [matriz de 25 funciones](integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md) y [plan de pruebas/evidencias](integraciones/g1-marketplace/PRUEBAS_Y_EVIDENCIAS_H4.md), el [acuerdo normativo G1–G6 de Docs PR #94](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/a8d89296b0eac37315ef30a9390f1e4e30933136/integraciones/ACUERDO_G1_G6_H4_2026-10-20.md), la [alineación Marketplace de Docs PR #94](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/a8d89296b0eac37315ef30a9390f1e4e30933136/integraciones/ALINEACION_MARKETPLACE.md) y el OpenAPI de Docs. Esta lectura se suma, no sustituye, a SPEC, DEC-F/ADR, modelo y pruebas del servicio. Registra contrato, código, CI, despliegue, grant y E2E con SHA exacto como estados independientes. No tomes informes históricos como estado actual.
