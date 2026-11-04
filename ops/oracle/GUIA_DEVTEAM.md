# Guía de trabajo DevTeam — Oracle desde el inicio

Esta guía acompaña, no reemplaza, las reglas de ownership de `AGENTS.md`. Antes de editar, aplica este orden:

1. Confirma rama, issue asignado y archivos permitidos. Trabaja solo en la rama personal permanente del owner. `api-gateway` requiere issue transversal y coordinación explícita. No tomes una tarea de otro servicio por cercanía.
2. Lee `AGENTS.md` completo y el README del repositorio.
3. Lee OpenAPI y/o AsyncAPI oficial aplicable y las decisiones DEC-F/ADR relacionadas. Una rama personal pendiente no es contrato aprobado; documenta discrepancias sin decidirlas.
4. Lee [`CONTRATO_DESPLIEGUE.md`](CONTRATO_DESPLIEGUE.md) y tu ficha en [`servicios/`](servicios/), incluida la matriz de red.
5. Contrasta dependencias físicas, configuradas y probadas. El estado de Oracle está fechado. Si una dependencia no está desplegada o no es alcanzable, encuentra las evidencias y condición de desbloqueo específica en la ficha.
6. Implementa lógica interna, persistencia y transporte dentro del ownership autorizado. Mantén aislada la frontera externa pendiente; no cambies unilateralmente contratos, permisos, nombres AMQP ni rutas compartidas.
7. Valida con infraestructura desechable/aislada equivalente: PostgreSQL real con TLS/CA cuando aplique; RabbitMQ aislado solo con topología y nombres acordados. Si la infraestructura externa falta, registra el bloqueo y prueba invariantes internas. No ocultes la falta con mocks en runtime productivo.
8. Ejecuta solo comandos existentes: compilación, tests, typecheck y lint de `package.json` y comandos concretos de la ficha. No afirmes integración real por unit tests.
9. Entrega SHA y evidencia usando [`CHECKLIST_PREDEPLOY.md`](CHECKLIST_PREDEPLOY.md); especifica resultados, límites y acciones pendientes de Marco/owners externos.
10. Solicita revisión antes de merge/despliegue. Ninguna build o readiness local concede autorización para operar Oracle.

## Niveles de evidencia

Declara cada estado por separado:

| Estado | Evidencia mínima |
|---|---|
| **Implementación interna completa** | Reglas propias, persistencia/transporte definidos, build, typecheck, lint y tests propios; ninguna pieza local declarada ausente. |
| **Integración local real probada** | Resultado reproducible contra PostgreSQL/Rabbit/HTTP real aislado, con versión/SHA, configuración no secreta y asserts de flujo. Si no aplica, justificar. |
| **Preparación de despliegue comprobada** | Imagen y Compose correspondientes al SHA, configuración/validadores/TLS/red compatibles, health y readiness probados con dependencias representativas. No implica haber desplegado. |
| **Despliegue Oracle y smoke remoto comprobados** | Autorización individual; deployment/SHA, health, readiness y flujo funcional remoto verificados sin efectos destructivos. Solo Marco/operador autorizado ejecuta ese paso. |

Unit tests pueden contribuir al primer estado, pero no cierran los otros tres. Una dependencia bloqueada se marca `PARTIAL` o `BLOCKED`; la operación dependiente queda bloqueada, no necesariamente el microservicio completo.

## Instrucciones para agentes con baja autonomía

- No edites si no tienes issue, owner y alcance claros; identifica la falta y avisa.
- Si dos fuentes normativas discrepan, conserva ambas citas, describe exactamente el impacto, identifica el owner competente y detén solo el cambio dependiente.
- No inventes env vars para llenar una tabla: busca en parser/bootstrap y anota “no consta” si no aparece.
- No uses credenciales reales ni leas valores de `runtime.env`; publica nombres de variable, nunca valores.
- Si DB/AMQP/upstream no está disponible, prepara tests con contenedores aislados. No cambies el esquema/nombres para “hacerlo funcionar” sin decisión.
- No ejecutes despliegue ni SQL sobre Supabase/Oracle. No hagas commit, push, merge ni publicación sin autorización expresa.

## H4 Marketplace — autoridad y estado

El [paquete operativo H4](../../integraciones/g1-marketplace/README.md) es la fuente actual de operaciones, owner y evidencia G1. La matriz de esta guía registra despliegue/infraestructura por sus propios SHA y ambiente; no deducir deploy de que una ruta responda HTTP 200, ni readiness estable de liveness. Separar la imagen digest desplegada del código de ramas personales/PR. Autenticación se valida por token real, allowlist y scope; el YAML o `DEMO_NO_AUTH` no acreditan grant ni seguridad H4.
