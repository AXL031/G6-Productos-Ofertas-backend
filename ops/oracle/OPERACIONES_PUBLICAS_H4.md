# Lecturas candidatas H4 y evidencia de Fase 1

Fuente contractual: OpenAPI `0.6.0-rc.3` y AsyncAPI `0.6.0-rc.4` del repositorio Docs en `master@a7778ec1a22811c1213a94ef096ab905911342cc`. La matriz de seguridad consultada identifica 59 operaciones GET y 7 POST de consulta. Son candidatas de revisión: el método o la etiqueta histórica no demuestra pureza de lectura ni ausencia de datos sensibles.

El registro fila por fila está en [`H4-MATRIZ-OPERACIONES-FASE1.csv`](H4-MATRIZ-OPERACIONES-FASE1.csv). Se generó desde la matriz contractual de Docs y conserva la ruta, método, clasificación y decisión Fase 1 por operación. Las columnas de ruta funcional, respuesta 200, sensibilidad, ausencia de efectos y pruebas negativas permanecen `NO_EJECUTADA` hasta que exista una prueba sobre esta rama ligada a SHA. No interpretar una fila candidata como operación funcionalmente probada o actualmente pública.

## Allowlist pública inicial propuesta para verificación

El liderazgo autoriza evaluar estos operationIds como lecturas públicas exactas en `PUBLIC_READ_ONLY`, tras pasar las pruebas de respuesta contractual, no exposición sensible y ausencia de efectos. La matriz los marca `CONDITIONAL`; ninguna operación se declara habilitada hasta que sus pruebas funcionales estén registradas con el SHA que las ejecutó.

- Catalog: `listarProductos`, `obtenerProducto`, `obtenerProductoPorSlug`.
- Taxonomy: `listarCategorias`, `listarMarcas`, `obtenerSeoPorSlug`, `resolverSlugAnterior`.
- Pricing: `consultarPrecios`, `obtenerPrecioSku`.
- Promotions: `listarPromociones`.
- Combos: `obtenerCombo`, `consultarDisponibilidadCombo`.
- Inventory: `consultarDisponibilidadComercial`.
- Bulk: `descargarPlantillaProductos`.

Las demás operaciones conservan la autorización contractual, incluidas lecturas administrativas, M2M, datos de inventario detallados y exportaciones. `obtenerContextoSku` mantiene su frontera `x-internal` y no es pública. No se cambian rutas, DTO, schemas de seguridad, scopes ni allowlists de consumidor en OpenAPI.

## Reglas para cerrar una fila

1. Confirmar coincidencia real de `operationId`, método y ruta con controlador de owner y Gateway.
2. Ejecutar la operación con datos reales de prueba y comprobar la respuesta contractual esperada cuando proceda.
3. Revisar cada campo devuelto y confirmar que no expone contexto protegido.
4. Comprobar en PostgreSQL y RabbitMQ desechables que la consulta no muta estado, reserva recursos ni publica efectos de negocio.
5. Probar rechazo anónimo para operaciones no públicas, además de JWT inválido, actor/cliente incorrecto y permiso insuficiente.
6. Registrar comando, resultado, SHA, datos/fixture utilizados y operación exacta. Una prueba de guard aislada no cierra una fila.

Fase 1 solo puede activar IDs que tengan evidencia completa. Si falla cualquiera de esas condiciones, mantener la operación protegida y registrar el bloqueo puntual.
