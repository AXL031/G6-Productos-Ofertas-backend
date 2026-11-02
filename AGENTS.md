# AGENTS.md — Instrucciones operativas para agentes en Backend

> **LEER COMPLETO ANTES DE EDITAR.** Este documento rige el desarrollo backend en el monorepo NestJS de **Productos y Ofertas (G6)**.

---

## 1. Orden obligatorio de trabajo

Prohibido escribir código antes de completar los pasos 1 a 6:

1. **LEER `AGENTS.md` COMPLETO** antes de editar cualquier archivo.
2. **Identificar la rama actual:** debe ser tu rama personal asignada.
3. **Leer el Issue asignado** y comprender todos sus criterios de aceptación.
4. **Identificar microservicio, owner y archivos autorizados:** verificar matriz de ownership.
5. **Consultar los contratos normativos correspondientes** en el repositorio de documentación.
6. Para toda implementación o modificación del modo demo, antes de cambiar código es obligatorio leer `ops/oracle/H4-MODO-DEMO-AUTH-REVERSIBLE.md` y Backend [#144](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/144).
7. **Realizar únicamente los cambios solicitados:** sin refactors extra ni archivos fuera de scope.
8. **Ejecutar pruebas:** pruebas enfocadas primero, luego validaciones generales.
9. **Revisar `git diff`:** verificar cambios exactos y ausencia de whitespace errors.
10. **Reportar resultados y bloqueos:** según el formato de reporte obligatorio.

### Lectura obligatoria para preparación Oracle

Antes de modificar un microservicio, además de leer `AGENTS.md` y el Issue asignado, consulta los contratos OpenAPI, AsyncAPI y DEC-F aplicables, y estas guías de despliegue:

1. `ops/oracle/GUIA_DEVTEAM.md`.
2. `ops/oracle/CONTRATO_DESPLIEGUE.md`.
3. `ops/oracle/servicios/<servicio>.md`.
4. `ops/oracle/MATRIZ_DEPENDENCIAS.md`.
5. `ops/oracle/RABBITMQ_COMPATIBILIDAD.md`, cuando el servicio use o proponga AMQP.
6. `ops/oracle/CHECKLIST_PREDEPLOY.md`.

Un microservicio no puede declararse `READY_FOR_DEPLOY` sin evidencias asociadas a su SHA que demuestren el cumplimiento de todos los requisitos aplicables de compilación, configuración, persistencia, mensajería, seguridad, contratos, Docker y readiness. Un bloqueo específico de AMQP no debe impedir el desarrollo independiente de funcionalidades HTTP o de persistencia dentro del alcance autorizado.

---

## 2. Política definitiva de ramas

- **Ramas personales permanentes:**
  - `castilla`
  - `poma`
  - `cueva`
  - `lopez`
  - `vera`
  - `taco`
- Cada desarrollador trabaja y continúa trabajando exclusivamente en su rama personal.
- Puede implementar múltiples Issues y abrir sucesivos PRs hacia `master` desde ella.
- **PROHIBIDO:** crear ramas `feat/...`, `fix/...` o ramas nuevas automáticas.
- **PROHIBIDO:** sincronizaciones masivas automáticas desde `master`, `rebase`, `git push --force`, `git reset --hard` o merges destructivos.
- `infra/foundation` es una excepción temporal ya existente para la Foundation inicial (PR #2), **no** una convención para desarrolladores.
- Los PRs deben mantener alcance pequeño, atómico y específico.

---

## 3. Matriz de ownership de aplicaciones

| Rama | Aplicaciones propias autorizadas |
|---|---|
| `castilla` | `apps/bulk-svc`, `apps/combos-svc` |
| `poma` | `apps/catalog-svc` |
| `cueva` | `apps/promotions-svc` |
| `lopez` | `apps/taxonomy-svc` |
| `vera` | `apps/pricing-svc`, `apps/price-audit-svc` |
| `taco` | `apps/inventory-svc` |

- **`apps/api-gateway`:** componente transversal; NO debe ser modificado libremente. Requiere Issue explícito y coordinación con arquitectura e integración.
- **Archivos globales:** `libs/`, `.github/`, dependencias en `package.json`, scripts y configuración del monorepo (`nest-cli.json`, `tsconfig*.json`) son compartidos y requieren autorización expresa en el Issue.
- **Límite estricto:** un agente no puede modificar otra aplicación para resolver un problema de la propia.
- Si detectas necesidad de modificar archivos fuera de tu ownership, detén esa parte, repórtala como dependencia y continúa solo las partes autorizadas e independientes.

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
  - **`IMPLEMENTAR_AHORA`:** lógica, invariantes, persistencia y pruebas internas de G6 están definidas y pueden desarrollarse dentro del ownership autorizado.
  - **`IMPLEMENTAR_PARCIAL`:** implementa lo interno ya definido y mantén aislada la frontera de integración que depende de una resolución externa.
  - **`BLOQUEADO_ESPECÍFICO`:** detén solo la operación, autorización, contrato compartido o secuencia que depende de la respuesta externa. Registra el owner que debe responder, la operación afectada y la condición exacta que permitirá desbloquearla.
- Una discrepancia intermodular que afecte una integración no paraliza el microservicio completo. Continúa el trabajo autónomo de G6 y no atribuyas ownership, aceptación externa, permisos ni homologación a otro módulo.
- Comunica a los consumidores externos afectados los cambios previstos, la regla DEC-F aplicable, el impacto contractual, la versión y la adaptación requerida. Esa comunicación no requiere autorización externa para desarrollar lógica e invariantes internas propias de G6.
- Antes de publicar como definitivo un cambio incompatible en un contrato compartido, exige homologación verificable de los módulos concernidos. Hasta entonces, conserva aislada la frontera pendiente; no cambies unilateralmente el contrato ni declares aceptación por silencio.
- Registra por separado el estado de implementación interna, pruebas locales, integración autenticada, homologación externa y despliegue. Ninguno se infiere de otro: documentación o YAML no prueban implementación; pruebas locales no prueban integración autenticada; una integración autenticada no prueba homologación ni despliegue.
- Toda dependencia externa pendiente debe identificar como mínimo: owner responsable de responder, operación o comportamiento afectado y condición concreta y verificable de desbloqueo. No uses un bloqueo general del microservicio si la dependencia solo afecta esa operación o frontera.

---

## 5. Protocolo para agentes de menor capacidad

1. Resolver una tarea concreta cada vez; no abarcar múltiples objetivos en paralelo.
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
RAMA Y ISSUE: <rama> | <issue>
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
