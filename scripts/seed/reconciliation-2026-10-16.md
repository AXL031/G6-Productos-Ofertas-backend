# Reconciliación documental de INFRA-001

Fecha: 2026-10-16, America/Lima. Responsable: Axel Cueva. Rama: `cueva`.
Issue: [backend #1](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/1).
Revisión de la implementación existente, sin provisión, rotación de contraseñas,
contacto con integrantes ni consultas/escrituras nuevas a Supabase.

## Fuentes verificadas

- `README.md`, `evidence.md`, `registry.json`, `dataset.json`, tests del runner y
  `.github/workflows/ci.yml`, en backend `c62111e58a78e7bf2489b3776d74a86a48e915cb`.
- Issue #1 abierto, actualizado el 2026-10-16.
- [PR #5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/5):
  GitHub confirma `merged=true`, merge del 2026-10-14 a las 06:53:32 UTC
  (01:53:32 America/Lima), commit `c3315c80d7ab4aa478828c282b51062ec31e6d0f`.
- La consulta de reviews formales del PR devuelve una lista vacía. La fusión no
  acredita por sí sola las revisiones técnicas/de integración exigidas en #1.

La afirmación histórica de `evidence.md` de que el PR sigue abierto ya no es
actual. Su descripción remota también conserva limitaciones anteriores a las
conexiones psql que sí documenta la sección posterior de `evidence.md`.
Se preserva esa historia; esta nota registra el contraste, sin reeditar el PR
fusionado ni presentar la evidencia histórica como una prueba nueva de BD.

## Qué está entregado y qué falta

| Tarea                 | Evidencia existente / revisión actual                                        | Pendiente verificable                                                                               |
| --------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| T01 auditoría         | Evidencia histórica de 84 tablas, ocho schemas y aislamiento.                | No se ejecutó una auditoría nueva de BD en esta revisión.                                           |
| T02 accesos           | Seis logins provisionados y contraseñas iniciales asignadas según evidencia. | Confirmar entrega privada y cambio de contraseña por destinatario.                                  |
| T03 conexión          | Evidencia histórica psql individual en ocho schemas, SSL verify-full.        | No confundir ese resultado con autenticación nueva ni con los logins runtime.                       |
| T04 estructura        | Directorios required/demo y un fixture reversible existentes.                | Los datos comerciales de cada contexto pertenecen a su owner.                                       |
| T05 runner/CI         | 14/14 tests ejecutados de nuevo en esta revisión; paso de CI presente.       | No hay destino apply autorizado en el registry.                                                     |
| T06 dataset           | `dataset.json` sigue en `PENDING_OWNER_REVIEW`.                              | Aprobación verificable de identidades/referencias por los owners y reconciliación con DATA #11–#17. |
| T07 prueba controlada | Dos ejecuciones y rollback documentados históricamente.                      | No se repitió el ensayo compartido; no hay carga persistente acreditada aquí.                       |
| T08 evidencia/PR      | PR fusionado comprobado; evidencia versionada existente.                     | Acreditar revisiones requeridas y criterios restantes antes del cierre de #1.                       |

## Accesos pendientes según la última evidencia disponible

| Integrante     | Schemas              | Entrega/cambio de contraseña                                              |
| -------------- | -------------------- | ------------------------------------------------------------------------- |
| Axel Cueva     | promotions           | Archivo privado al administrador documentado; cambio no confirmado aquí.  |
| Leonardo López | taxonomy             | Entrega por Axel y confirmación del destinatario pendientes de evidencia. |
| Gabriel Poma   | catalog              | Entrega por Axel y confirmación del destinatario pendientes de evidencia. |
| Miguel Taco    | inventory            | Entrega por Axel y confirmación del destinatario pendientes de evidencia. |
| Leonardo Vera  | pricing, price_audit | Entrega por Axel y confirmación del destinatario pendientes de evidencia. |
| Marco Castilla | combos, bulk         | Entrega por Axel y confirmación del destinatario pendientes de evidencia. |

No se reejecuta `credentials.mjs`: hacerlo rotaría las contraseñas. No se accede a
archivos de entrega ni a `.env.local`. Registrar solo confirmaciones, nunca
credenciales. Cada destinatario conserva la responsabilidad de cambiar su clave.

## Dependencias para el cierre

| Owner                                                       | Operación afectada                      | Condición de desbloqueo                                                                                        |
| ----------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Axel y cada destinatario                                    | Entrega individual/cambio de contraseña | Confirmaciones privadas verificables, documentadas sin secretos.                                               |
| López, Poma, Vera, Taco y Castilla, cada uno en su contexto | Dataset integrado                       | Referencias y lotes revisados por sus owners; no exigir el runner/registry para la ruta MCP autorizada por #1. |
| Leonardo López / Marco Castilla                             | Revisión BD e integración               | Evidencia enlazable de las revisiones requeridas y aceptación de criterios pendientes.                         |

El runner continúa en `shared=verify_only`. La preparación/lectura MCP autorizada
por #1 es una ruta alternativa que no exige registrar fixtures en el runner.
Ensayos y persistencia conservan las condiciones exactas de autorización del
issue; esta reconciliación no las modifica. Los avisos históricos de advisors y
dependencias globales siguen fuera de esta revisión y no se declaran resueltos.

Estado: `IMPLEMENTAR_PARCIAL` / `PARTIAL` para el cierre de #1. La revisión
documental y la prueba local del runner están completadas. No hay bloqueo para
desarrollar la configuración interna de Promotions en #70.
