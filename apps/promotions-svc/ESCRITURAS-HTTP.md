# Escrituras HTTP de Promotions — #74

Owner: Axel Cueva · rama `cueva` · 23/10/2026.

**IMPLEMENTAR_PARCIAL:** las doce operaciones administrativas están implementadas
y probadas con PostgreSQL/TLS real y JWT firmados. Crear, editar o activar campañas
y recomendaciones requiere el adaptador autorizado de referencias de Catálogo;
el provider de producción permanece explícitamente bloqueado. Las pruebas lo
sustituyen por referencias sintéticas identificadas. Esto no acredita integración
con Catálogo/G7 ni despliegue.

## Contrato y operaciones

Fuente: Docs G6 `51a5ce6e76bb0c61d93ef47416e46797bf5b9846`, OpenAPI
`0.6.0-rc.1`, SPEC-005/006/007 y DEC-F-007/008/009/012. Se amplió el generador
existente para conservar los diez operationIds de consulta y añadir estos doce:

| Recurso | Crear | Editar | Activar / desactivar |
| --- | --- | --- | --- |
| Promociones | POST /api/v1/promociones | PATCH /api/v1/promociones/{promocionId} | POST /api/v1/promociones/{promocionId}/activar y /desactivar |
| Cupones | POST /api/v1/cupones | PATCH /api/v1/cupones/{cuponId} | POST /api/v1/cupones/{cuponId}/activar y /desactivar |
| Recomendaciones | POST /api/v1/recomendaciones/reglas | PATCH /api/v1/recomendaciones/reglas/{reglaId} | POST /api/v1/recomendaciones/reglas/{reglaId}/activar y /desactivar |

Crear responde 201; editar/cambiar estado, 200. Solo `userBearer` con firma y rol
GESTOR_COMERCIAL; un token de servicio no administra aunque tenga scopes de lectura.
Se conservan DTOs y códigos por operación: 400/401/403/404/409/422/500/503 donde
los declara OpenAPI. Un identificador propio opaco que no representa un UUID
existente devuelve el 404 contractual del recurso, sin ejecutar un cast SQL inválido.

El contrato no define endpoints HTTP para consumir/restaurar ni una clave de
idempotencia para crear maestros; no se añaden. Reintentar un POST de creación no
se presenta como una operación idempotente. El cupón mantiene unicidad por código
normalizado; las mutaciones de estado/edición no crean usos ni borran historia.

## Transacciones e invariantes

- La edición bloquea la fila del agregado y combina el PATCH con su versión
  actual bajo el bloqueo, evitando sobrescribir otro PATCH independiente.
- Promoción, alcances y política se guardan atómicamente. Recomendación e items
  también. Se preservan constraints diferidos y triggers de las migraciones oficiales.
- Omitir canales/alcance/items en PATCH conserva los existentes. Enviarlos vacíos
  se valida según el contrato y las reglas del dominio. Producto y SKU se mantienen
  separados; la sustitución del alcance nunca consulta schemas ajenos.
- La capacidad de cambiar modalidad se deriva nuevamente bajo bloqueo. El cliente
  no puede concederla con `puedeCambiarModalidad`; la primera activación se conserva
  por el trigger oficial, incluso después de desactivar.
- Cupones verifican la campaña CUPON propia, normalizan código y excluyen su propio
  registro al comprobar duplicados. La restricción única resuelve la carrera restante.
  `null` conserva el significado contractual de sin límite/mínimo opcional.
- La conversión de fechas persistidas al formato RFC3339 ocurre antes de volver a
  validar el agregado; el formato textual de PostgreSQL no invalida un PATCH válido.
- Las llamadas al adaptador de referencias ocurren antes de adquirir locks, con
  timeout y señal de cancelación. Si cambia el conjunto de referencias antes del
  bloqueo, la mutación falla con 503 y no aplica una comprobación obsoleta.
- Desactivar promociones/recomendaciones no requiere Catálogo y puede ejecutarse
  durante una caída externa. Crear/editar/activar no acepta referencias inventadas.
  Activar con referencias no verificables falla con el 503 permitido por su contrato.
- No se emiten eventos de creación/edición inventados: AsyncAPI vigente solo define
  cuatro publicaciones propias de Promotions, los resultados de cupones.

## Evidencia reproducible

`test/support/http-write-checks.mjs` se ejecuta en la suite de persistencia existente:

```powershell
npm test -- apps/promotions-svc --maxWorkers=1
npm run test:e2e -- apps/promotions-svc --maxWorkers=1
npm run build:promotions-svc
node apps/promotions-svc/test/persistence.isolated.smoke.mjs
```

Usa PostgreSQL desechable con TLS verificado, login restringido y claves/JWT de
prueba. Verifica las doce rutas, rechazo de tokens de servicio, errores contractuales,
actualizaciones concurrentes, duplicados, límites nulos, estado/modalidad e items
UPSELL. Un trigger de prueba diferido, creado solamente en la base desechable,
provoca fallo al COMMIT después de cambiar hijos y comprueba rollback completo.
Compara usos/recibos/Inbox/Outbox antes/después: sin efectos de consumo/restauración.

## Dependencia específica

Catálogo + integración G6/G7 | altas/ediciones/activaciones que verifican referencias |
adaptador autorizado que distinga referencias inexistentes/inactivas de fallo técnico,
con procedencia y prueba autenticada. OpenAPI sí contiene DTOs tipados de Catálogo
y Taxonomía; la identidad de servicio de Promotions no está incluida en las
allowlists de lectura y las variantes administrativas exigen `userBearer`.
Los selectores HTTP de usuario del frontend no sustituyen esa validación propia.
Ver [REFERENCIAS-CATALOGO.md](REFERENCIAS-CATALOGO.md).

Implementación y pruebas internas se informan separadas de homologación externa,
grants, carga DATA y despliegue. El consumidor/pump de cupones sigue deshabilitado.
